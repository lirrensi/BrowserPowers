import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { routeExecute as routeExecuteType } from "../../src/capability-router.js";

describe("capability-router", () => {
  let routeExecute: typeof routeExecuteType;
  let executeScriptMock: Mock;
  let tabsSendMessageMock: Mock;

  beforeEach(async () => {
    vi.resetModules();

    executeScriptMock = vi.fn().mockResolvedValue([{ result: "hello" }]);
    tabsSendMessageMock = vi.fn().mockResolvedValue(undefined);

    // Ensure chrome mocks are still active
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        onMessage: { addListener: vi.fn() },
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        query: vi.fn().mockResolvedValue([
          { id: 1, url: "https://example.com", title: "Example" },
        ]),
        create: vi.fn().mockResolvedValue({ id: 2 }),
        update: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue(undefined),
        captureVisibleTab: vi.fn().mockResolvedValue("data:image/png;base64,abc"),
        sendMessage: tabsSendMessageMock,
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
      },
      scripting: {
        executeScript: executeScriptMock,
      },
      windows: {
        getAll: vi.fn().mockResolvedValue([
          { id: 1, type: "normal", state: "normal" },
        ]),
      },
      cookies: {
        get: vi.fn().mockResolvedValue({ name: "test", value: "val" }),
        getAll: vi.fn().mockResolvedValue([{ name: "test", value: "val" }]),
      },
      storage: {
        local: { get: vi.fn(), set: vi.fn() },
      },
      action: {
        setBadgeText: vi.fn(),
        setBadgeBackgroundColor: vi.fn(),
      },
      webRequest: {
        onBeforeRequest: { addListener: vi.fn() },
        onCompleted: { addListener: vi.fn() },
      },
    } as any);

    // Bypass isExtensionContext
    vi.stubGlobal("process", {
      ...process,
      versions: { ...process.versions, node: undefined },
    });
  });

  it("tabs.list returns paginated tab results", async () => {
    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-1",
      tool: "tabs.list",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("tabs");
    expect(Array.isArray(result.data.tabs)).toBe(true);
    expect(result.data.tabs).toHaveLength(1);
    expect(result.data).toHaveProperty("totalCount", 1);
  });

  it("screenshots.capture returns base64 image", async () => {
    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-3",
      tool: "screenshots.capture",
      params: {},
    });
    expect(result.success).toBe(true);
    // The implementation returns { base64, format: "png" }
    expect(result.data).toHaveProperty("base64");
    expect(result.data).toHaveProperty("format", "png");
  });

  it("returns error for unknown tool", async () => {
    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-4",
      tool: "nonexistent.tool",
      params: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("cookies.get returns a cookie", async () => {
    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-5",
      tool: "cookies.get",
      params: { url: "https://example.com", name: "test" },
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("name", "test");
    expect(result.data).toHaveProperty("value", "val");
  });

  it("resolves frame_url to a real frameId and targets that frame", async () => {
    executeScriptMock.mockResolvedValueOnce([
      { frameId: 0, result: { href: "https://example.com/outer", name: "" } },
      { frameId: 77, result: { href: "https://example.com/inner", name: "inner" } },
    ]);
    tabsSendMessageMock.mockResolvedValueOnce({
      success: true,
      anchors: [],
      documentId: "doc-1",
      url: "https://example.com/inner",
      title: "Inner",
    });

    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-frame-1",
      tool: "page.read",
      params: { action: "inspect", frame_url: "/inner" },
    });

    expect(result.success).toBe(true);
    expect(executeScriptMock).toHaveBeenCalledWith({
      target: { tabId: 1, allFrames: true },
      func: expect.any(Function),
    });
    expect(tabsSendMessageMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ action: "inspect" }),
      { frameId: 77 },
    );
  });

  it("fails loudly when the requested frame is not found", async () => {
    executeScriptMock.mockResolvedValueOnce([
      { frameId: 0, result: { href: "https://example.com/outer", name: "" } },
    ]);

    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-frame-2",
      tool: "page.read",
      params: { action: "inspect", frame_url: "/missing" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("frame not found");
    expect(tabsSendMessageMock).not.toHaveBeenCalled();
  });

  it("surfaces ActionResult failure messages instead of a shrug", async () => {
    // sendMessage → undefined simulates a dead content script; inspect must
    // report WHY (message + code), not "success:false with no error message".
    const { routeExecute } = await import("../../src/capability-router.js");
    const result = await routeExecute({
      requestId: "test-6",
      tool: "page.read",
      params: { action: "inspect" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Content script not available");
    expect(result.error).not.toContain("no error message");
  });
});
