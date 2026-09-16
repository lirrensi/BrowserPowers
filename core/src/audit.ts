/**
 * FILE: core/src/audit.ts
 * PURPOSE: Privacy-by-construction audit log — append-only JSONL with redaction,
 *          plus list/get/delete read API, 30d retention, torn-tail tolerance.
 * OWNS: Audit file lifecycle — append (redacted), rotate, list, read, delete, prune.
 * EXPORTS: logAudit, getAuditDir, listAudits, getAuditEntries, deleteAudit, pruneAudits
 */

import { existsSync, mkdirSync, renameSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { appendFile, readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

function auditDir(): string {
  const override = process.env.BROWSERPOWERS_HOME?.trim();
  if (override) return join(override, "audit");
  return join(homedir(), ".config", "browserpowers", "audit");
}

export function getAuditDir(): string {
  return auditDir();
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let currentFile: string | null = null;
let currentSize = 0;

function ensureDir(): void {
  const dir = auditDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getCurrentFile(): string {
  if (!currentFile) {
    ensureDir();
    const date = new Date().toISOString().slice(0, 10);
    currentFile = join(auditDir(), `audit-${date}.jsonl`);
    if (existsSync(currentFile)) {
      try { currentSize = statSync(currentFile).size; } catch { currentSize = 0; }
    }
  }
  return currentFile;
}

function rotateIfNeeded(): void {
  if (currentSize >= MAX_FILE_SIZE && currentFile) {
    const ts = Date.now();
    const rotated = currentFile.replace(".jsonl", `-${ts}.jsonl`);
    try { renameSync(currentFile, rotated); } catch { /* best-effort */ }
    currentFile = null;
    currentSize = 0;
  }
}

// ── Redaction (privacy by construction) ──

function safeUrl(u: unknown): string | undefined {
  if (typeof u !== "string") return undefined;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `${parsed.protocol}//[redacted]`;
    return `${parsed.protocol}//${parsed.host}`;
  } catch { return "[invalid-url]"; }
}

function safeText(t: unknown, maxWords = 24, maxChars = 160): string | undefined {
  if (typeof t !== "string") return undefined;
  let s = t.slice(0, 500);
  // Redact emails, long tokens, digit runs, secret-looking assignments.
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
  s = s.replace(/[A-Za-z0-9_-]{64,}/g, "[token]");
  s = s.replace(/\d{6,}/g, "[digits]");
  s = s.replace(/(password|secret|bearer|api[_-]?key|sk-|ghp_)[=:]\S+/gi, "$1=[redacted]");
  const words = s.split(/\s+/).slice(0, maxWords).join(" ");
  return words.slice(0, maxChars);
}

function redactParams(tool: string, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (["value", "text", "code", "expression", "file_data", "password", "token", "apiKey", "authKey"].includes(k)) {
      out[k] = "[redacted]";
    } else if (k === "url" || k === "pattern") {
      out[k] = safeUrl(v) ?? "[redacted]";
    } else if (k === "target" && typeof v === "object" && v !== null) {
      const t = v as Record<string, unknown>;
      out[k] = {
        ...(typeof t.css === "string" ? { css: "[selector]" } : {}),
        ...(typeof t.text === "string" ? { text: safeText(t.text, 8, 60) } : {}),
        ...(typeof t.role === "string" ? { role: t.role } : {}),
      };
    } else if (typeof v === "string" && v.length > 200) {
      out[k] = safeText(v) ?? v.slice(0, 160);
    } else if (typeof v === "object" && v !== null) {
      out[k] = "[object]";
    } else {
      out[k] = v;
    }
  }
  void tool;
  return out;
}

/**
 * Append a single JSONL entry (redacted) to the audit log.
 */
export async function logAudit(entry: Record<string, unknown>): Promise<void> {
  try {
    rotateIfNeeded();
    const file = getCurrentFile();
    const redacted = {
      _t: new Date().toISOString(),
      browserId: entry.browserId,
      tool: entry.tool,
      params: redactParams(String(entry.tool ?? ""), (entry.params as Record<string, unknown>) ?? {}),
      ok: (entry.result as Record<string, unknown> | undefined)?.success ?? undefined,
      error: typeof (entry.result as Record<string, unknown> | undefined)?.error === "string"
        ? safeText((entry.result as Record<string, unknown>).error, 12, 120)
        : undefined,
    };
    const line = JSON.stringify(redacted) + "\n";
    await appendFile(file, line);
    currentSize += Buffer.byteLength(line, "utf-8");
  } catch (err) {
    console.error("[audit] Failed to write audit entry:", (err as Error).message);
  }
}

// ── Read API ──

export interface AuditFileInfo {
  file: string;
  date: string;
  size: number;
  mtime: string;
}

export function listAudits(): AuditFileInfo[] {
  try {
    pruneAudits();
    const dir = auditDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const p = join(dir, f);
        try {
          const st = statSync(p);
          return { file: f, date: f.replace(/^audit-/, "").replace(/\.jsonl$/, ""), size: st.size, mtime: st.mtime.toISOString() };
        } catch { return null; }
      })
      .filter(Boolean) as AuditFileInfo[];
  } catch { return []; }
}

export async function getAuditEntries(file: string, offset = 0, limit = 100): Promise<{ entries: unknown[]; total: number; file: string }> {
  const safe = basename(file);
  if (!safe.endsWith(".jsonl") || safe.includes("..")) throw new Error("Invalid audit file");
  const p = join(auditDir(), safe);
  const raw = await readFile(p, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    try { entries.push(JSON.parse(lines[i])); }
    catch {
      // Torn-tail tolerance: ignore last line if unwritten, else skip corrupt line.
      if (i !== lines.length - 1) continue;
    }
  }
  return { entries: entries.slice(offset, offset + limit), total: entries.length, file: safe };
}

export function deleteAudit(file: string): boolean {
  const safe = basename(file);
  if (!safe.endsWith(".jsonl") || safe.includes("..")) throw new Error("Invalid audit file");
  const p = join(auditDir(), safe);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  if (currentFile && currentFile.endsWith(safe)) { currentFile = null; currentSize = 0; }
  return true;
}

export function pruneAudits(now = Date.now()): number {
  try {
    const dir = auditDir();
    if (!existsSync(dir)) return 0;
    let pruned = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs > RETENTION_MS) { unlinkSync(p); pruned++; }
      } catch { /* ignore */ }
    }
    return pruned;
  } catch { return 0; }
}

export async function auditStats(): Promise<{ files: number; bytes: number; dir: string }> {
  const files = listAudits();
  let bytes = 0;
  for (const f of files) bytes += f.size;
  return { files: files.length, bytes, dir: auditDir() };
}
