import { defineConfig } from "wxt";

// See https://wxt.dev for config docs
export default defineConfig({
  extensionApi: "chrome",

  // Don't auto-open any browser — just build and serve
  webExt: {
    disabled: true,
  },

  manifest: {
    name: "BrowserPowers",
    description: "Bridge — connects this browser to the BrowserPowers core for multi-browser LLM agent control",
    options_page: "options.html",
    permissions: [
      "tabs",
      "activeTab",
      "scripting",
      "storage",
      "windows",
      "cookies",
      "history",
      "bookmarks",
      "downloads",
      "notifications",
      "webNavigation",
      "webRequest",
      "alarms",
      "contextMenus",
      // Required for chrome.debugger — gives page.js and console capture
      // DevTools-level access on the page, bypassing page CSP. The user is
      // prompted once at install/upgrade.
      "debugger",
      // Required for chrome.offscreen.createDocument — used by the
      // screenshot overlay feature to host a real <canvas> in a hidden
      // page. The SW paints via the offscreen document; service workers
      // can't paint directly.
      "offscreen",
    ],
    host_permissions: ["<all_urls>"],
  },
});
