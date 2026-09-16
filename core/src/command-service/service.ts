import { randomUUID } from "node:crypto";
import type { CommandService, BrowserInfo } from "./interface.js";
import type { ToolResult } from "../types.js";
import { ApprovalTimeoutError, registry } from "../registry.js";
import { checkGate } from "../gates/middleware.js";
import { logAudit } from "../audit.js";

/**
 * The SINGLE implementation of CommandService.
 * All adapters (REST, MCP, CLI) call into this.
 * Currently: routes to browser extensions via WebSocket.
 * Future: can also route to direct CDP connections.
 */
class CommandServiceImpl implements CommandService {
  async listBrowsers(): Promise<BrowserInfo[]> {
    return registry.list().map((b) => ({
      id: b.id,
      name: b.name,
      connected: true,
      capabilities: b.capabilities.map((c: { tool: string }) => c.tool),
      lastHeartbeat: b.lastHeartbeat,
    }));
  }

  async execute(
    browserId: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const browser = registry.get(browserId);
    if (!browser) {
      return { browserId, tool, success: false, error: `Browser "${browserId}" not found` };
    }

    // Gate check
    const gate = checkGate(browser.permissions, tool);
    if (gate.mode === "deny") {
      return {
        browserId,
        tool,
        success: false,
        error: `Gate: ${gate.reason} (mode: ${gate.mode})`,
      };
    }

    // Load config once — used for approval timeout and queue timeout
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();

    // If gate is "ask", enter approval flow
    if (gate.mode === "ask") {
      // TEST ONLY: automated harnesses (test:live) have no human to click the
      // popup. Never set in production — it silently approves everything.
      if (process.env.BROWSERPOWERS_AUTO_APPROVE === "1") {
        console.warn(`[gates] TEST MODE: auto-approving "${tool}" for ${browserId} (BROWSERPOWERS_AUTO_APPROVE=1)`);
      } else {
      const requestId = `${browserId}:approval:${randomUUID()}`;
      const description = `Agent wants to run "${tool}" with params: ${JSON.stringify(params)}`;
      const approvalTimeoutMs = config.gates.approvalTimeoutMs ?? 60_000;

      // Queue approval FIRST — entry must exist before WS message is sent
      // to prevent race: fast user approval arriving before registry entry exists
      const approvalPromise = registry.queueApproval(browserId, requestId, tool, params, approvalTimeoutMs);

      const { sendToExtension } = await import("../ws-server.js");
      try {
        sendToExtension(browserId, {
          type: "request_approval",
          payload: { requestId, tool, params, description },
        });
      } catch (err) {
        // If send fails, clean up the pending approval
        registry.resolveApproval(requestId, false);
        return {
          browserId,
          tool,
          success: false,
          error: `Failed to request approval: ${(err as Error).message}`,
        };
      }

      try {
        const approved = await approvalPromise;
        if (!approved) {
          return {
            browserId,
            tool,
            success: false,
            error: `Gate: User denied approval for tool group "${gate.reason?.match(/"([^"]+)"/)?.[1] ?? tool}"`,
          };
        }
      } catch (err) {
        if (err instanceof ApprovalTimeoutError) {
          return {
            browserId,
            tool,
            success: false,
            error: `Gate: Approval timed out after ${approvalTimeoutMs}ms for tool group "${gate.reason?.match(/"([^"]+)"/)?.[1] ?? tool}"`,
          };
        }

        return {
          browserId,
          tool,
          success: false,
          error: (err as Error).message,
        };
      }
      } // end else: normal approval flow (auto-approve path falls through)
    } // end if (ask)

    // Check capability
    const cap = browser.capabilities.find((c: { tool: string }) => c.tool === tool);
    if (!cap) {
      return {
        browserId,
        tool,
        success: false,
        error: `Tool "${tool}" not in browser's capabilities`,
      };
    }

    // Enqueue request — will be drained by ws-server when browser is ready
    const rawTimeout = (params.timeout_ms as number) ?? config.queue.defaultTimeoutMs ?? 120_000;
    // Clamp timeout to reasonable bounds (1s – 5min) to prevent abuse:
    //   timeout_ms=0  → instant timeout (DoS),
    //   timeout_ms >5min → memory leak vector
    let timeoutMs = Math.max(1_000, Math.min(rawTimeout, 300_000));

    // Remove timeout_ms from params before forwarding to extension
    const { timeout_ms, ...cleanParams } = params as Record<string, unknown>;

    // Human-loop orchestration: the extension answers requestHelp IMMEDIATELY
    // with {outcome:"pending"} (MV3 workers can't survive long waits), then
    // the CORE polls helpStatus on its own clock — which never sleeps, so the
    // agent always gets a terminal envelope even across worker restarts.
    let helpDeadlineMs = 0;
    if (tool === "human.requestHelp") {
      helpDeadlineMs = Math.max(10_000, Math.min(Number(params.timeout_ms ?? 300_000) || 300_000, 600_000));
      (cleanParams as Record<string, unknown>).deadline_ms = helpDeadlineMs;
      timeoutMs = 30_000; // first dispatch returns pending immediately
    }

    const { requestId, promise } = registry.enqueue(browserId, tool, cleanParams, timeoutMs);

    // Attempt to drain immediately (if browser is connected and not busy)
    const { tryDrain } = await import("../ws-server.js");
    tryDrain(browserId);

    try {
      const result = await promise;
      if (tool === "human.requestHelp") {
        const data = result.data as { outcome?: string; notif_id?: string } | undefined;
        if (data?.outcome === "pending" && data?.notif_id) {
          return await this.pollHumanHelp(browserId, data.notif_id, helpDeadlineMs);
        }
      }
      await logAudit({ browserId, tool, params: cleanParams, result: { success: true } });
      return result;
    } catch (err) {
      await logAudit({ browserId, tool, params: cleanParams, result: { success: false, error: (err as Error).message } });
      return {
        browserId,
        tool,
        success: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Poll human.helpStatus until a terminal outcome or the deadline.
   * Each poll is a short independent dispatch, so worker restarts between
   * polls are harmless — state lives in extension storage, not memory.
   */
  private async pollHumanHelp(browserId: string, notifId: string, deadlineMs: number): Promise<ToolResult> {
    const start = Date.now();
    const tool = "human.requestHelp";
    for (;;) {
      if (Date.now() - start >= deadlineMs) {
        const data = { outcome: "timed_out", elapsed_ms: Date.now() - start, hint: "No human response in time — report blocker, do not loop request." };
        await logAudit({ browserId, tool, params: { notif_id: notifId }, result: { success: true } });
        return { browserId, tool, success: true, data };
      }
      await new Promise((r) => setTimeout(r, 2000));
      let s: ToolResult;
      try {
        s = await this.execute(browserId, "human.helpStatus", { notif_id: notifId, timeout_ms: 15_000 });
      } catch (err) {
        continue; // transient dispatch failure — keep polling till deadline
      }
      if (!s.success) {
        // Old extension without helpStatus? Fail fast with upgrade hint.
        return {
          browserId, tool, success: false,
          error: `human.helpStatus unavailable (${s.error}) — update the extension to use request_help`,
        };
      }
      const env = s.data as { outcome?: string } | undefined;
      if (env?.outcome && env.outcome !== "pending") {
        await logAudit({ browserId, tool, params: { notif_id: notifId }, result: { success: true } });
        return { browserId, tool, success: true, data: s.data };
      }
    }
  }

  async executeAsync(
    browserId: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<{ requestId: string }> {
    const browser = registry.get(browserId);
    if (!browser) {
      throw new Error(`Browser "${browserId}" not found`);
    }

    // Gate check
    const gate = checkGate(browser.permissions, tool);
    if (gate.mode === "deny") {
      throw new Error(`Gate: ${gate.reason} (mode: ${gate.mode})`);
    }
    // "ask" gates require user interaction — cannot be handled asynchronously
    if (gate.mode === "ask") {
      throw new Error(`Gate: Tool "${tool}" requires user approval — async mode does not support approval-gated tools. Use sync mode.`);
    }

    // Capability check
    const cap = browser.capabilities.find((c: { tool: string }) => c.tool === tool);
    if (!cap) {
      throw new Error(`Tool "${tool}" not in browser's capabilities`);
    }

    // Enqueue request — fire-and-forget
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    const rawTimeout = (params.timeout_ms as number) ?? config.queue.defaultTimeoutMs ?? 120_000;
    const timeoutMs = Math.max(1_000, Math.min(rawTimeout, 300_000));
    const { timeout_ms, ...cleanParams } = params as Record<string, unknown>;

    const { requestId, promise } = registry.enqueue(browserId, tool, cleanParams, timeoutMs);

    const { tryDrain } = await import("../ws-server.js");
    tryDrain(browserId);

    // Fire and forget — the promise resolves/rejects and stores the result via registry
    promise.then(
      () => {},
      () => {},
    );

    return { requestId };
  }

  async getResult(requestId: string): Promise<{ status: "pending" | "complete" | "error"; result?: ToolResult }> {
    // Check if request is still pending (in-flight)
    // The registry stores results only after completion — if it's not in completedResults,
    // check if it's still in pendingRequests
    const completed = registry.getResult(requestId);
    if (completed) {
      return {
        status: completed.success ? "complete" : "error",
        result: completed,
      };
    }

    // Not in completed results — could be pending or unknown
    // We don't have a direct "is pending" check, so we return pending
    // (the caller can retry; if it's truly unknown, the 5min window will expire)
    return { status: "pending" };
  }

  async executeAll(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult[]> {
    const browsers = registry.list();
    const results = await Promise.allSettled(
      browsers.map((b) => this.execute(b.id, tool, params)),
    );
    return results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { browserId: browsers[i].id, tool, success: false, error: r.reason?.message },
    );
  }

  async executeBatch(
    batch: Array<{ browserId: string; tool: string; params: Record<string, unknown> }>,
  ): Promise<ToolResult[]> {
    const results = await Promise.allSettled(
      batch.map((item) => this.execute(item.browserId, item.tool, item.params ?? {})),
    );
    return results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { browserId: batch[i].browserId, tool: batch[i].tool, success: false, error: r.reason?.message },
    );
  }

  async getCapabilities(browserId: string): Promise<string[]> {
    const browser = registry.get(browserId);
    return browser?.capabilities.map((c: { tool: string }) => c.tool) ?? [];
  }

  async isConnected(browserId: string): Promise<boolean> {
    return registry.get(browserId) !== undefined;
  }

  async findBrowserByName(name: string): Promise<string> {
    const browsers = registry.list();
    const matches = browsers.filter((b: { name: string }) => b.name === name);
    if (matches.length === 0) {
      throw new Error(`Browser "${name}" not found. Connected browsers: ${browsers.map((b: { name: string }) => `"${b.name}"`).join(", ") || "none"}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple browsers named "${name}" found. Use browser_id instead.`);
    }
    return matches[0].id;
  }
}

export const commandService: CommandService = new CommandServiceImpl();
