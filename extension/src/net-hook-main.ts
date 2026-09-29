/**
 * FILE: extension/src/net-hook-main.ts
 * PURPOSE: Page MAIN-world hook for `page.net` (TSK-0015), injected as a
 *          serialized function via `chrome.scripting.executeScript
 *          ({ world: "MAIN" })` from the service worker — NOT via a
 *          `<script>` tag from the content script, because strict page CSPs
 *          (`script-src 'self'` without `unsafe-inline`, e.g. cloud.ru)
 *          refuse inline scripts while extension-API MAIN-world injection
 *          is CSP-exempt.
 *
 *          Wraps WebSocket (constructor + send + inbound listener), fetch
 *          (observe + block short-circuit), XMLHttpRequest (observe only —
 *          XHR cannot be cleanly short-circuited, honest subset).
 *          HTTP observe relays method/url/status only; bodies only when the
 *          SW pushes includeBodies and then truncated to 4KB. Blocking
 *          returns a synthetic 403 Response — wrapper-level, NOT
 *          network-stack blocking (true MV3 stack blocking would need
 *          declarativeNetRequest rules).
 *
 * SERIALIZATION WARNING: this function is serialized via .toString() and
 * evaluated in the page — it MUST stay self-contained plain JS (JSDoc
 * comments only, no TS annotations — they would survive verbatim into
 * the evaluated source) and reference NOTHING outside its own body.
 * No imports, no module-scope helpers, globals only.
 *
 * OWNS: The page-side half of the page.net bridge.
 * EXPORTS: netHookMain
 */
export function netHookMain() {
  try {
    const w = /** @type {any} */ (window);
    if (w.__bpNetHookInstalled) return;
    w.__bpNetHookInstalled = true;

    let socketSeq = 0;
    const sockets = /** @type {Object<string, any>} */ ({});
    let rules = /** @type {Array<any>} */ ([]);
    let includeBodies = false;

    /** @param {any} msg */
    function relay(msg) {
      try {
        window.postMessage(Object.assign({ source: "browserpowers-net" }, msg), "*");
      } catch (e) { /* never break page */ }
    }

    /** @param {string} url @param {string} pattern */
    function matches(url, pattern) {
      if (!pattern) return false;
      if (url == null) return false;
      if (pattern.indexOf("*") !== -1) {
        try {
          const rx = new RegExp(
            "^" +
              pattern
                .split("*")
                .map(function (p) {
                  return p.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
                })
                .join(".*") +
              "$",
          );
          return rx.test(url);
        } catch (e) {
          return false;
        }
      }
      return url.indexOf(pattern) !== -1;
    }

    /** @param {string} url */
    function blocked(url) {
      for (const r of rules) {
        if (r && r.action === "block" && matches(url, r.pattern)) return true;
      }
      return false;
    }

    /** @param {string} url */
    function observed(url) {
      for (const r of rules) {
        if (r && matches(url, r.pattern)) return true;
      }
      return false;
    }

    // ── WebSocket ──
    try {
      const OrigWS = /** @type {any} */ (window.WebSocket);
      if (OrigWS && !OrigWS.__bpHooked) {
        const meta = new WeakMap();
        const origSend = OrigWS.prototype.send;
        /** @this {any} @param {any} data */
        OrigWS.prototype.send = function (data) {
          try {
            const m = meta.get(this);
            if (m) {
              const text = typeof data === "string" ? data : "[binary]";
              relay({
                domain: "ws",
                kind: "frame",
                socketId: m.socketId,
                url: m.url,
                dir: "out",
                data: String(text).slice(0, 4096),
              });
            }
          } catch (e) { /* ignore */ }
          return origSend.call(this, data);
        };
        /** @this {any} @param {string} url @param {any} protocols */
        function HookedWS(url, protocols) {
          const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
          try {
            socketSeq += 1;
            const socketId = "sock_" + socketSeq;
            const urlStr = String(url);
            meta.set(ws, { socketId: socketId, url: urlStr });
            sockets[socketId] = ws;
            ws.addEventListener("message", function (e) {
              try {
                const text = typeof e.data === "string" ? e.data : "[binary]";
                relay({
                  domain: "ws",
                  kind: "frame",
                  socketId: socketId,
                  url: urlStr,
                  dir: "in",
                  data: String(text).slice(0, 4096),
                });
              } catch (err) { /* ignore */ }
            });
            ws.addEventListener("close", function () {
              try {
                relay({ domain: "ws", kind: "close", socketId: socketId, url: urlStr });
              } catch (err) { /* ignore */ }
            });
            relay({ domain: "ws", kind: "open", socketId: socketId, url: urlStr });
          } catch (e) { /* ignore */ }
          return ws;
        }
        HookedWS.prototype = OrigWS.prototype;
        for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
          try {
            HookedWS[k] = OrigWS[k];
          } catch (e) { /* ignore */ }
        }
        HookedWS.__bpHooked = true;
        w.WebSocket = HookedWS;
      }
    } catch (e) { /* never break page */ }

    // ── fetch (observe + block short-circuit) ──
    try {
      const origFetch = /** @type {any} */ (window.fetch);
      if (origFetch && !origFetch.__bpHooked) {
        /** @this {any} @param {any} input @param {any} init */
        const hooked = function (input, init) {
          let urlStr = "";
          let method = "GET";
          try {
            urlStr = String(typeof input === "string" ? input : input.url);
            method =
              (init && init.method) ||
              (typeof input !== "string" && input.method) ||
              "GET";
          } catch (e) { /* ignore */ }
          if (blocked(urlStr)) {
            relay({ domain: "http", kind: "http", method: method, url: urlStr, status: 403, blocked: true });
            return Promise.resolve(
              new Response("Blocked by BrowserPowers page.net http_block (wrapper-level, not network-stack)", {
                status: 403,
                statusText: "Forbidden",
              }),
            );
          }
          return origFetch.apply(this, arguments).then(function (res) {
            try {
              if (observed(urlStr)) {
                if (includeBodies) {
                  res
                    .clone()
                    .text()
                    .then(function (t) {
                      relay({
                        domain: "http",
                        kind: "http",
                        method: method,
                        url: urlStr,
                        status: res.status,
                        blocked: false,
                        body: String(t).slice(0, 4096),
                      });
                    })
                    .catch(function () {
                      relay({ domain: "http", kind: "http", method: method, url: urlStr, status: res.status, blocked: false });
                    });
                } else {
                  relay({ domain: "http", kind: "http", method: method, url: urlStr, status: res.status, blocked: false });
                }
              }
            } catch (e) { /* ignore */ }
            return res;
          });
        };
        hooked.__bpHooked = true;
        w.fetch = hooked;
      }
    } catch (e) { /* never break page */ }

    // ── XMLHttpRequest (observe only) ──
    try {
      const OrigXHR = /** @type {any} */ (window.XMLHttpRequest);
      if (OrigXHR && !OrigXHR.__bpHooked) {
        const origOpen = OrigXHR.prototype.open;
        const origXhrSend = OrigXHR.prototype.send;
        OrigXHR.prototype.open = function () {
          try {
            this.__bpMethod = arguments[0];
            this.__bpUrl = arguments[1];
          } catch (e) { /* ignore */ }
          return origOpen.apply(this, arguments);
        };
        OrigXHR.prototype.send = function () {
          try {
            const self = this;
            const urlStr = String(self.__bpUrl || "");
            if (observed(urlStr)) {
              self.addEventListener("load", function () {
                try {
                  relay({
                    domain: "http",
                    kind: "http",
                    method: String(self.__bpMethod || "GET"),
                    url: urlStr,
                    status: self.status || 0,
                    blocked: false,
                  });
                } catch (e) { /* ignore */ }
              });
            }
          } catch (e) { /* ignore */ }
          return origXhrSend.apply(this, arguments);
        };
        OrigXHR.__bpHooked = true;
      }
    } catch (e) { /* never break page */ }

    // ── Control channel from the isolated world ──
    window.addEventListener("message", function (e) {
      try {
        const d = e.data;
        if (!d || d.source !== "browserpowers-net-ctl") return;
        if (d.cmd === "send") {
          const ws = sockets[d.socketId];
          if (ws && ws.readyState === 1) {
            ws.send(d.data);
            relay({ domain: "ws", kind: "frame", socketId: d.socketId, url: "", dir: "out", data: String(d.data).slice(0, 4096) });
          }
        } else if (d.cmd === "rules") {
          rules = d.rules || [];
          includeBodies = d.includeBodies === true;
        }
      } catch (err) { /* ignore */ }
    });
  } catch (e) { /* pages never break */ }
}
