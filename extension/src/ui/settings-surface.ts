/**
 * FILE: extension/src/ui/settings-surface.ts
 * PURPOSE: Bootstrap the shared popup and options settings surface.
 * OWNS: Wiring the browser identity, core URL, capability permissions, reconnect/reset, approvals UI, and locale switching.
 * EXPORTS: bootstrapSettingsSurface() — initializes the shared settings/approvals experience in the current document.
 * DOCS: agent_chat/plan_ui_approval_flow_2026-05-10.md
 */

import type { PagePermissionGroup } from "../types";
import {
  clearAllSessionPermissionOverrides,
  clearSessionPermissionOverride,
  getEffectivePermissions,
  getPageSitePermissions,
  getSettings,
  resetSettings,
  savePageSitePermissions,
  saveSettings,
} from "../storage";
import {
  t,
  initI18n,
  applyStaticI18n,
  getLocale,
  setLocale,
  SUPPORTED_LOCALES,
} from "./i18n";
import type { Locale } from "./i18n";

type SurfaceMode = "popup" | "options";
type ConnectionState = "disconnected" | "connecting" | "connected" | "waiting";

interface ConnectionStatus {
  state: ConnectionState;
  connected: boolean;
  reconnectAttempts: number;
  authRequired?: boolean;
  extVersion?: string;
  coreVersion?: string | null;
  registered?: boolean;
}

interface ApprovalItem {
  requestId: string;
  tool: string;
  params: Record<string, unknown>;
  description: string;
  group: string;
  title?: string;
  url?: string;
}

const CAP_GROUPS = [
  { id: "tabs" },
  { id: "screenshots" },
  { id: "history.read" },
  { id: "history.delete" },
  { id: "bookmarks.read" },
  { id: "bookmarks.modify" },
  { id: "bookmarks.delete" },
  { id: "downloads" },
  { id: "network" },
  { id: "storage" },
  { id: "windows" },
  { id: "cookies" },
] as const;

const PAGE_CAP_GROUPS: Array<{ id: PagePermissionGroup }> = [
  { id: "page.read" },
  { id: "page.act" },
  { id: "page.execute" },
];

const PERMISSION_OPTIONS = ["allow", "ask", "deny"] as const;

// Autonyms for the locale picker; proper nouns, intentionally untranslated.
const LOCALE_NAMES: Record<Locale, string> = { en: "English", de: "Deutsch", es: "Español", fr: "Français", ru: "Русский", zh: "中文", ar: "العربية" };

export function bootstrapSettingsSurface(mode: SurfaceMode = "popup"): void {
  void init(mode).catch((error) => {
    console.error("[bp-ext] Failed to bootstrap settings surface:", error);
  });
}

async function init(mode: SurfaceMode): Promise<void> {
  initI18n();

  document.body.classList.toggle("options-page", mode === "options");

  const statusEl = byId("connection-status");
  const nameInput = byId<HTMLInputElement>("browser-name");
  const coreUrlInput = byId<HTMLInputElement>("core-url");
  const approvalNotificationsInput = byId<HTMLInputElement>("approval-notifications");
  const capsList = byId("capabilities-list");
  const saveNameBtn = byId<HTMLButtonElement>("save-name");
  const reconnectBtn = byId<HTMLButtonElement>("reconnect");
  const resetBtn = byId<HTMLButtonElement>("reset");
  const approvalsListEl = byId("approvals-list");
  const tabSettings = byId<HTMLButtonElement>("tab-settings");
  const tabApprovals = byId<HTMLButtonElement>("tab-approvals");
  const panelSettings = byId("panel-settings");
  const panelApprovals = byId("panel-approvals");
  const approvalBadge = byId("approval-badge");

  const settings = await getSettings();
  const effectivePermissions = await getEffectivePermissions();

  nameInput.value = settings.browserName;
  coreUrlInput.value = settings.coreUrl;
  const authKeyInput = byId<HTMLInputElement>("auth-key");
  authKeyInput.value = settings.authKey ?? "";
  authKeyInput.addEventListener("change", () => { void saveAuthKey(authKeyInput); });
  approvalNotificationsInput.checked = settings.approvalNotificationsEnabled;
  wireYoloToggle(capsList);

  renderCapabilities(capsList, effectivePermissions);
  const pageCapsContainer = byId("page-capabilities-list");
  renderPageCapabilities(pageCapsContainer);
  void loadPageCapabilities(pageCapsContainer);
  void updateStatus(statusEl);
  applyStaticI18n(document);

  wireAnnotateButtons();
  approvalNotificationsInput.addEventListener("change", () => { void saveApprovalNotifications(approvalNotificationsInput); });
  saveNameBtn.addEventListener("click", () => { void saveName(nameInput); });
  reconnectBtn.addEventListener("click", () => { void reconnect(statusEl); });
  resetBtn.addEventListener("click", () => {
    void reset({
      statusEl,
      nameInput,
      coreUrlInput,
      approvalNotificationsInput,
      capsList,
      approvalBadge,
      approvalsListEl,
    });
  });

  tabSettings.addEventListener("click", () => switchTab("settings", tabSettings, tabApprovals, panelSettings, panelApprovals, approvalsListEl, approvalBadge, capsList));
  tabApprovals.addEventListener("click", () => switchTab("approvals", tabSettings, tabApprovals, panelSettings, panelApprovals, approvalsListEl, approvalBadge, capsList));

  setInterval(() => { void updateStatus(statusEl); }, 2000);

  const pending = await renderApprovals(approvalsListEl, approvalBadge, capsList);
  if (pending.length > 0) {
    switchTab("approvals", tabSettings, tabApprovals, panelSettings, panelApprovals, approvalsListEl, approvalBadge, capsList);
  }

  setInterval(() => { void renderApprovals(approvalsListEl, approvalBadge, capsList); }, 2000);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required element: #${id}`);
  }
  return el as T;
}

function wireLocaleSelect(args: {
  statusEl: HTMLElement;
  capsList: HTMLElement;
  approvalsListEl: HTMLElement;
  approvalBadge: HTMLElement;
}): void {
  const select = document.getElementById("locale") as HTMLSelectElement | null;
  if (!select) return;

  select.innerHTML = "";
  for (const locale of SUPPORTED_LOCALES) {
    const option = document.createElement("option");
    option.value = locale;
    option.textContent = LOCALE_NAMES[locale] ?? locale;
    select.appendChild(option);
  }
  select.value = getLocale();

  select.addEventListener("change", () => {
    setLocale(select.value as Locale);
    select.value = getLocale();
    void (async () => {
      renderCapabilities(args.capsList, await getEffectivePermissions());
      const pageCapsContainer = byId("page-capabilities-list");
      renderPageCapabilities(pageCapsContainer);
      await loadPageCapabilities(pageCapsContainer);
      await updateStatus(args.statusEl);
      await renderApprovals(args.approvalsListEl, args.approvalBadge, args.capsList);
      applyStaticI18n(document);
    })();
  });
}

function renderCapabilities(container: HTMLElement, permissions: Record<string, string>): void {
  container.innerHTML = "";
  const yolo = permissions.__yolo === "allow" || document.body.classList.contains("yolo-on");

  for (const group of CAP_GROUPS) {
    const current = permissions[group.id] ?? "ask";

    const row = document.createElement("div");
    row.className = "cap-row";

    const info = document.createElement("div");
    info.className = "cap-info";
    const label = document.createElement("strong");
    label.textContent = t(`caps.${group.id}.label`);
    const desc = document.createElement("small");
    desc.textContent = t(`caps.${group.id}.desc`);
    info.appendChild(label);
    info.appendChild(desc);

    const select = document.createElement("select");
    select.dataset.group = group.id;
    for (const opt of PERMISSION_OPTIONS) {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = t(`perms.${opt}`);
      if (opt === current) option.selected = true;
      select.appendChild(option);
    }

    select.addEventListener("change", () => {
      const val = select.value;
      void (async () => {
        const currentSettings = await getSettings();
        await clearSessionPermissionOverride(group.id);
        await saveSettings({ permissions: { ...currentSettings.permissions, [group.id]: val } });
      })();
      select.className = `perm-${val}`;
    });

    select.className = `perm-${current}`;
    if (yolo) select.disabled = true;
    row.appendChild(info);
    row.appendChild(select);
    container.appendChild(row);
  }

  applyStaticI18n(document);
}

function renderPageCapabilities(container: HTMLElement): void {
  container.innerHTML = "";
  const yolo = document.body.classList.contains("yolo-on");

  for (const group of PAGE_CAP_GROUPS) {
    const section = document.createElement("div");
    section.className = "page-cap-section";
    section.dataset.group = group.id;

    const heading = document.createElement("h3");
    heading.textContent = t(`pagecaps.${group.id}.label`);
    section.appendChild(heading);

    const desc = document.createElement("p");
    desc.className = "hint";
    desc.textContent = t(`pagecaps.${group.id}.desc`);
    section.appendChild(desc);

    for (const listName of ["allow", "ask", "deny"] as const) {
      const label = document.createElement("label");
      label.textContent = t(`sites.list.${listName}`);
      label.className = `site-list-label site-list-${listName}`;

      const textarea = document.createElement("textarea");
      textarea.className = "site-pattern-ta";
      textarea.dataset.group = group.id;
      textarea.dataset.list = listName;
      textarea.rows = 2;
      textarea.placeholder = listName === "allow" ? t("sites.allowPh") : "";
      if (yolo) textarea.disabled = true;

      // Debounced save
      let saveTimer: ReturnType<typeof setTimeout> | undefined;
      textarea.addEventListener("input", () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          void savePagePatternsFromTextarea(textarea);
        }, 600);
      });

      section.appendChild(label);
      section.appendChild(textarea);
    }

    container.appendChild(section);
  }

  applyStaticI18n(document);
}

async function savePagePatternsFromTextarea(textarea: HTMLTextAreaElement): Promise<void> {
  const group = textarea.dataset.group as PagePermissionGroup;
  const list = textarea.dataset.list as "allow" | "ask" | "deny";
  const patterns = textarea.value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const current = await getPageSitePermissions();
  const groupPerms = current[group] ?? { allow: [], ask: [], deny: [] };
  // Rebuild ALL THREE lists from all textareas in this section
  const section = textarea.closest(".page-cap-section");
  if (section) {
    const tas = section.querySelectorAll<HTMLTextAreaElement>("textarea.site-pattern-ta");
    for (const ta of tas) {
      const g = ta.dataset.group as PagePermissionGroup;
      const l = ta.dataset.list as "allow" | "ask" | "deny";
      const patterns = ta.value
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (!current[g]) current[g] = { allow: [], ask: [], deny: [] };
      current[g][l] = patterns;
    }
  }

  await savePageSitePermissions(current);
}

async function loadPageCapabilities(container: HTMLElement): Promise<void> {
  const pageSites = await getPageSitePermissions();
  const tas = container.querySelectorAll<HTMLTextAreaElement>("textarea.site-pattern-ta");
  for (const ta of tas) {
    const group = ta.dataset.group as PagePermissionGroup;
    const list = ta.dataset.list as "allow" | "ask" | "deny";
    const groupPerms = pageSites[group];
    if (groupPerms) {
      ta.value = (groupPerms[list] ?? []).join("\n");
    }
  }
}

async function updateStatus(statusEl: HTMLElement): Promise<void> {
  const versionEl = document.getElementById("version-info") as HTMLElement | null;
  try {
    const status = await chrome.runtime.sendMessage({ type: "getConnectionStatus" }) as ConnectionStatus | undefined;

    if (versionEl) {
      const ext = status?.extVersion ?? "…";
      const core = status?.coreVersion ?? "…";
      const mismatch = status?.registered === true
        && status?.extVersion !== undefined
        && status?.coreVersion !== null
        && status.extVersion !== status.coreVersion;
      versionEl.textContent = `ext v${ext} · core v${core}`;
      versionEl.classList.toggle("version-skew", mismatch);
      versionEl.title = mismatch
        ? `Version skew: extension v${ext} vs core v${core} — reload the extension (chrome://extensions → reload) so new tools appear`
        : `Extension v${ext}, core v${core} — reload the extension after reinstall if tools fail with "Unknown tool"`;
    }

    if (status?.authRequired) {
      statusEl.textContent = t("status.authRequired");
      statusEl.className = "status disconnected";
      applyStaticI18n(document);
      return;
    }

    // Registered (handshake done) wins over socket state: a connected socket
    // without a `registered` reply is still "connecting" from the user's view.
    if (status?.connected && status?.registered !== true) {
      statusEl.textContent = t("status.registering");
      statusEl.className = "status connecting";
      applyStaticI18n(document);
      return;
    }

    switch (status?.state) {
      case "connected":
        statusEl.textContent = t("status.connected");
        statusEl.className = "status connected";
        applyStaticI18n(document);
        return;
      case "connecting":
        statusEl.textContent = t("status.connecting");
        statusEl.className = "status connecting";
        applyStaticI18n(document);
        return;
      case "waiting":
        statusEl.textContent = t("status.waiting");
        statusEl.className = "status connecting";
        applyStaticI18n(document);
        return;
      default:
        statusEl.textContent = t("status.disconnected");
        statusEl.className = "status disconnected";
    }
  } catch {
    statusEl.textContent = t("status.disconnected");
    statusEl.className = "status disconnected";
  }
  applyStaticI18n(document);
}

async function saveName(nameInput: HTMLInputElement): Promise<void> {
  await saveSettings({ browserName: nameInput.value });
  nameInput.style.borderColor = "#22c55e";
  setTimeout(() => { nameInput.style.borderColor = ""; }, 1500);
}

async function saveCoreUrl(coreUrlInput: HTMLInputElement): Promise<void> {
  await saveSettings({ coreUrl: coreUrlInput.value });
}

async function saveAuthKey(authKeyInput: HTMLInputElement): Promise<void> {
  await saveSettings({ authKey: authKeyInput.value });
}

async function saveApprovalNotifications(approvalNotificationsInput: HTMLInputElement): Promise<void> {
  await saveSettings({ approvalNotificationsEnabled: approvalNotificationsInput.checked });
}

/** YOLO switch: one flag, no permission writes. Re-render caps read-only state on toggle. */
function wireYoloToggle(capsList: HTMLElement): void {
  const toggle = document.getElementById("yolo-mode") as HTMLInputElement | null;
  if (!toggle) return;
  void (async () => {
    const settings = await getSettings();
    toggle.checked = settings.yoloMode === true;
    document.body.classList.toggle("yolo-on", toggle.checked);
  })();
  toggle.addEventListener("change", () => {
    void (async () => {
      await saveSettings({ yoloMode: toggle.checked });
      document.body.classList.toggle("yolo-on", toggle.checked);
      // Re-register so the core sees the mode change on next execute; reconnect is cheap.
      try {
        await chrome.runtime.sendMessage({ type: "reconnectToCore" });
      } catch { /* popup may close mid-send */ }
      renderCapabilities(capsList, await getEffectivePermissions());
      const pageCapsContainer = byId("page-capabilities-list");
      renderPageCapabilities(pageCapsContainer);
      await loadPageCapabilities(pageCapsContainer);
    })();
  });
}

/** Annotate card: two mode buttons — element picker vs region screenshot. Esc exits. */
function wireAnnotateButtons(): void {
  const elBtn = document.getElementById("annotate-element") as HTMLButtonElement | null;
  const regionBtn = document.getElementById("annotate-region") as HTMLButtonElement | null;
  const state = document.getElementById("annotate-state");
  if (!elBtn || !regionBtn) return;
  const say = (msg: string): void => { if (state) state.textContent = msg; };
  const arm = (mode: "element" | "region", hint: string): void => {
    void (async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: "annotateArm", mode }) as { success?: boolean; error?: string } | undefined;
        say(res?.success === true ? hint : `Failed: ${res?.error ?? "unknown"}`);
      } catch {
        say("Failed to arm picker.");
      }
    })();
  };
  elBtn.addEventListener("click", () => arm("element", "element mode — click page elements (Esc exits)"));
  regionBtn.addEventListener("click", () => arm("region", "region mode — drag a rectangle, type, send (Esc exits)"));
  void (async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: "annotateStatus" }) as { armed?: boolean; mode?: string } | undefined;
      if (res?.armed === true) say(res.mode === "region" ? "region mode — drag a rectangle (Esc exits)" : "element mode — click page elements (Esc exits)");
    } catch {
      say("");
    }
  })();
}
async function reconnect(statusEl: HTMLElement): Promise<void> {
  statusEl.textContent = t("status.connecting");
  statusEl.className = "status connecting";
  await chrome.runtime.sendMessage({ type: "reconnectToCore" });
  void updateStatus(statusEl);
}

async function reset(args: {
  statusEl: HTMLElement;
  nameInput: HTMLInputElement;
  coreUrlInput: HTMLInputElement;
  approvalNotificationsInput: HTMLInputElement;
  capsList: HTMLElement;
  approvalBadge: HTMLElement;
  approvalsListEl: HTMLElement;
}): Promise<void> {
  if (!confirm(t("dialogs.resetConfirm"))) return;

  await clearAllSessionPermissionOverrides();
  await resetSettings();

  const settings = await getSettings();
  args.nameInput.value = settings.browserName;
  args.coreUrlInput.value = settings.coreUrl;
  args.approvalNotificationsInput.checked = settings.approvalNotificationsEnabled;
  const authKeyInput = byId<HTMLInputElement>("auth-key");
  authKeyInput.value = settings.authKey ?? "";
  renderCapabilities(args.capsList, await getEffectivePermissions());
  const pageCapsContainer = byId("page-capabilities-list");
  renderPageCapabilities(pageCapsContainer);
  void loadPageCapabilities(pageCapsContainer);
  await renderApprovals(args.approvalsListEl, args.approvalBadge, args.capsList);
  void updateStatus(args.statusEl);
}

function switchTab(
  tab: "settings" | "approvals",
  tabSettings: HTMLButtonElement,
  tabApprovals: HTMLButtonElement,
  panelSettings: HTMLElement,
  panelApprovals: HTMLElement,
  approvalsListEl: HTMLElement,
  approvalBadge: HTMLElement,
  capsList: HTMLElement,
): void {
  tabSettings.classList.toggle("active", tab === "settings");
  tabApprovals.classList.toggle("active", tab === "approvals");
  panelSettings.classList.toggle("active", tab === "settings");
  panelApprovals.classList.toggle("active", tab === "approvals");

  if (tab === "approvals") {
    void renderApprovals(approvalsListEl, approvalBadge, capsList);
  }
}

async function renderApprovals(
  approvalsListEl: HTMLElement,
  approvalBadge: HTMLElement,
  capsList: HTMLElement,
): Promise<ApprovalItem[]> {
  const pending = await chrome.runtime.sendMessage({ type: "getPendingApprovals" }) as ApprovalItem[] | undefined;

  if (!pending || pending.length === 0) {
    approvalsListEl.innerHTML = "";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.dataset.i18n = "approvals.empty";
    empty.textContent = t("approvals.empty");
    approvalsListEl.appendChild(empty);
    approvalBadge.classList.add("hidden");
    approvalBadge.textContent = "0";
    applyStaticI18n(document);
    return [];
  }

  approvalBadge.classList.remove("hidden");
  approvalBadge.textContent = String(pending.length);

  approvalsListEl.innerHTML = pending.map((item) => `
    <div class="approval-item" data-request-id="${item.requestId}">
      <div class="approval-site">${escapeHtml(item.title || item.url || item.group)}</div>
      <div class="tool-name">${escapeHtml(item.tool)}</div>
      <div class="tool-desc">${escapeHtml(item.description)}</div>
      <div class="tool-params">${escapeHtml(JSON.stringify(item.params, null, 2))}</div>
      <div class="approval-actions">
        <button class="btn-approve-once" data-action="approve-once" data-request-id="${item.requestId}">${escapeHtml(t("approvals.approveOnce"))}</button>
        <button class="btn-approve-session" data-action="approve-session" data-request-id="${item.requestId}">${escapeHtml(t("approvals.approveSession"))}</button>
        <button class="btn-approve-forever" data-action="approve-forever" data-request-id="${item.requestId}">${escapeHtml(t("approvals.approveForever"))}</button>
        <button class="btn-deny" data-action="deny" data-request-id="${item.requestId}">${escapeHtml(t("approvals.reject"))}</button>
      </div>
    </div>
  `).join("");

  approvalsListEl.querySelectorAll("[data-action='approve-once']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const requestId = (btn as HTMLElement).dataset.requestId!;
      await chrome.runtime.sendMessage({ type: "approveRequest", requestId, scope: "once" });
      void renderApprovals(approvalsListEl, approvalBadge, capsList);
    });
  });

  approvalsListEl.querySelectorAll("[data-action='approve-session']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const requestId = (btn as HTMLElement).dataset.requestId!;
      await chrome.runtime.sendMessage({ type: "approveRequest", requestId, scope: "session" });
      void renderApprovals(approvalsListEl, approvalBadge, capsList);
    });
  });

  approvalsListEl.querySelectorAll("[data-action='approve-forever']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const requestId = (btn as HTMLElement).dataset.requestId!;
      await chrome.runtime.sendMessage({ type: "approveRequest", requestId, scope: "forever" });
      void renderApprovals(approvalsListEl, approvalBadge, capsList);
      renderCapabilities(capsList, await getEffectivePermissions());
    });
  });

  approvalsListEl.querySelectorAll(".btn-deny").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const requestId = (btn as HTMLElement).dataset.requestId!;
      await chrome.runtime.sendMessage({ type: "denyRequest", requestId });
      void renderApprovals(approvalsListEl, approvalBadge, capsList);
    });
  });

  applyStaticI18n(document);
  return pending;
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
