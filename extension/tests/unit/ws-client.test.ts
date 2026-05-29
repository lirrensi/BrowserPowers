import { describe, it, expect, beforeEach, vi } from "vitest";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "closed", wasClean: true });
  }

  fail(): void {
    this.onerror?.({});
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "unavailable", wasClean: false });
  }
}

describe("ws-client", () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as any);
    // Prevent ws-client's offline check from trying window.addEventListener
    if (typeof navigator !== "undefined") {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    }
  });

  it("deduplicates concurrent connect attempts", async () => {
    const { connect } = await import("../../src/ws-client.js");

    await Promise.all([connect(), connect(), connect()]);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("moves to waiting when the socket closes", async () => {
    const { connect, getConnectionStatus } = await import("../../src/ws-client.js");

    await connect();
    expect(getConnectionStatus().state).toBe("connecting");

    MockWebSocket.instances[0].fail();

    expect(getConnectionStatus().state).toBe("waiting");
  });
});
