/**
 * FILE: extension/src/v2/anchor-manager.ts
 * PURPOSE: Manage anchor lifecycle in the extension service worker.
 *          Anchors are per-tab, per-inspect-session with documentId staleness detection.
 * OWNS: Anchor storage, retrieval, and invalidation for fast follow-up actions.
 * EXPORTS: setAnchors, getAnchor, getDocumentId, clearAnchors, clearAllAnchors
 * DOCS: agent_chat/plan_adr001_v2_2026-05-12.md (Phase 2c),
 *       .agents/reports/plan_runtime-verdict_2026-06-22.md §2.8
 */

import type { Target } from "../types.js";

interface AnchorEntry {
  selector: string;
  documentId: string;
  tabId: number;
  target: Target;
  /** Optional chain of shadow host tag names leading to the anchor. */
  shadowPath?: string[];
}

export interface StoredAnchor {
  selector: string;
  target: Target;
  shadowPath?: string[];
}

const tabAnchors = new Map<number, Map<string, AnchorEntry>>();
const tabGenerations = new Map<number, number>();

/**
 * Store a batch of anchors for a given tab + documentId.
 * Bumps the per-tab generation — every inspect replaces the ref map.
 */
export function setAnchors(
  tabId: number,
  documentId: string,
  anchors: Array<{ anchor: string; target: Target; selector: string; shadowPath?: string[] }>,
): number {
  const map = new Map<string, AnchorEntry>();
  for (const a of anchors) {
    map.set(a.anchor, {
      selector: a.selector,
      documentId,
      tabId,
      target: a.target,
      shadowPath: a.shadowPath,
    });
  }
  tabAnchors.set(tabId, map);
  const gen = (tabGenerations.get(tabId) ?? 0) + 1;
  tabGenerations.set(tabId, gen);
  return gen;
}

/**
 * Retrieve an anchor entry by tabId + anchorId + documentId.
 * Returns null if the anchor doesn't exist or is stale (documentId mismatch).
 */
export function getAnchor(
  tabId: number,
  anchorId: string,
  documentId?: string,
): StoredAnchor | null {
  const map = tabAnchors.get(tabId);
  if (!map) return null;
  const entry = map.get(anchorId);
  if (!entry) return null;
  if (documentId !== undefined && entry.documentId !== documentId) return null; // stale
  return { selector: entry.selector, target: entry.target, shadowPath: entry.shadowPath };
}

/**
 * Get the documentId of the last anchor batch stored for a tab.
 * Returns null if no anchors are stored for the tab.
 */
export function getDocumentId(tabId: number): string | null {
  const map = tabAnchors.get(tabId);
  if (!map || map.size === 0) return null;
  // All entries in a batch have the same documentId — grab from first
  return map.values().next().value?.documentId ?? null;
}

/**
 * Get the current ref generation for a tab (bumps on every inspect).
 * Used to guard canvas capture_id + detect stale maps.
 */
export function getGeneration(tabId: number): number {
  return tabGenerations.get(tabId) ?? 0;
}

/**
 * Remove all anchors for a given tab (on navigation / page change).
 */
export function clearAnchors(tabId: number): void {
  tabAnchors.delete(tabId);
}

/**
 * Remove all anchors across all tabs.
 */
export function clearAllAnchors(): void {
  tabAnchors.clear();
}
