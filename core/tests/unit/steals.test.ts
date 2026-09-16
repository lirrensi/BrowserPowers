import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// These tests cover the BrowserSkill steals. All mocked — no browser,
// no real filesystem writes, nothing destructive.

const mockAppendFile = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRenameSync = vi.fn();
const mockStatSync = vi.fn();
const mockReaddirSync = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    renameSync: mockRenameSync,
    statSync: mockStatSync,
    readdirSync: mockReaddirSync,
  };
});

vi.mock("node:fs/promises", () => ({
  appendFile: mockAppendFile,
  readFile: vi.fn().mockResolvedValue(""),
  stat: vi.fn(),
}));

describe("steals: gates (human/record)", () => {
  let checkGate: typeof import("../../src/gates/middleware.js").checkGate;

  beforeEach(async () => {
    vi.resetModules();
    checkGate = (await import("../../src/gates/middleware.js")).checkGate;
  });

  it("human.requestHelp is always allowed — even when profile says deny", () => {
    // The help request IS the human step; gating it would ask approval to ask for help.
    expect(checkGate({ human: "deny" }, "human.requestHelp").mode).toBe("allow");
    expect(checkGate({}, "human.requestHelp").allowed).toBe(true);
  });

  it("human.helpStatus rides the same always-allow orchestration lane", () => {
    expect(checkGate({ human: "deny" }, "human.helpStatus").mode).toBe("allow");
  });

  it("record tools respect the profile (allow/deny)", () => {
    expect(checkGate({ record: "allow" }, "record.start").allowed).toBe(true);
    const denied = checkGate({ record: "deny" }, "record.stop");
    expect(denied.allowed).toBe(false);
    expect(denied.mode).toBe("deny");
  });
});

describe("steals: audit redaction (privacy by construction)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 0 });
    mockAppendFile.mockResolvedValue(undefined);
  });

  it("reduces URLs to origin-only and redacts values/code", async () => {
    const { logAudit } = await import("../../src/audit.js");
    await logAudit({
      browserId: "b-1",
      tool: "page.act",
      params: {
        action: "fill",
        value: "supersecret",
        url: "https://example.com/account?token=abc",
        target: { css: "#pw", text: "Password" },
      },
      result: { success: true },
    });
    const line = mockAppendFile.mock.calls[0][1] as string;
    expect(line).not.toContain("supersecret");
    expect(line).not.toContain("token=abc");
    expect(line).toContain("https://example.com");
    expect(line).toContain("[redacted]");
  });

  it("scrubs emails and long tokens from error text", async () => {
    const { logAudit } = await import("../../src/audit.js");
    await logAudit({
      browserId: "b-1",
      tool: "page.read",
      params: {},
      result: { success: false, error: "failed for user@example.com with A".concat("a".repeat(70)) },
    });
    const line = mockAppendFile.mock.calls[0][1] as string;
    expect(line).not.toContain("user@example.com");
    expect(line).not.toContain("a".repeat(70));
  });
});

describe("steals: BROWSERPOWERS_HOME override", () => {
  const OLD = process.env.BROWSERPOWERS_HOME;
  afterEach(() => {
    if (OLD === undefined) delete process.env.BROWSERPOWERS_HOME;
    else process.env.BROWSERPOWERS_HOME = OLD;
  });

  it("points audit dir and pid path at the shared dir when set", async () => {
    vi.resetModules();
    process.env.BROWSERPOWERS_HOME = "/shared/bp";
    const audit = await import("../../src/audit.js");
    const config = await import("../../src/config.js");
    expect(audit.getAuditDir()).toContain("shared");
    expect(config.getPidPath()).toContain("shared");
  });
});

describe("steals: help catalog covers new tools/actions", () => {
  it("documents request_help, record, snapshot, wheel, scroll_to, visual_click", async () => {
    const help = await import("../../src/adapters/help-text.js");
    expect(help.PAGE_READ_ACTIONS).toContain("snapshot");
    expect(help.PAGE_ACT_ACTIONS).toEqual(
      expect.arrayContaining(["wheel", "scroll_to", "focus", "blur", "visual_click"]),
    );
    expect(help.buildToolHelp("request_help")).not.toMatch(/No help available/);
    expect(help.buildToolHelp("record")).not.toMatch(/No help available/);
    expect(help.buildHelpIndex()).toContain("request_help");
  });
});
