/**
 * Persistent GitHub↔Lark identity mapping.
 *
 * Single source of truth for approval state. Lives in `data/user-mapping.json`
 * so every sync run, approve-page fetch, and notify job sees the same decisions
 * via the checked-in file.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  MatchCandidate,
  PendingApproval,
  UserMapping,
  UserMappingEntry,
} from './types.js';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
export const USER_MAPPING_FILE = path.join(DATA_DIR, 'user-mapping.json');

const EMPTY: UserMapping = { entries: {}, pending: {} };

export function loadUserMapping(): UserMapping {
  if (!fs.existsSync(USER_MAPPING_FILE)) return structuredClone(EMPTY);
  try {
    const raw = JSON.parse(fs.readFileSync(USER_MAPPING_FILE, 'utf-8'));
    return {
      entries: raw.entries ?? {},
      pending: raw.pending ?? {},
    };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function saveUserMapping(mapping: UserMapping): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USER_MAPPING_FILE, JSON.stringify(mapping, null, 2) + '\n');
}

export function recordMatch(
  mapping: UserMapping,
  ghLogin: string,
  entry: Omit<UserMappingEntry, 'status' | 'decided_at'> & { decided_by?: string },
): void {
  mapping.entries[ghLogin] = {
    status: 'matched',
    decided_at: new Date().toISOString(),
    ...entry,
  };
  delete mapping.pending[ghLogin];
}

export function recordSkip(
  mapping: UserMapping,
  ghLogin: string,
  decidedBy?: string,
): void {
  mapping.entries[ghLogin] = {
    status: 'skipped',
    decided_at: new Date().toISOString(),
    decided_by: decidedBy,
  };
  delete mapping.pending[ghLogin];
}

export function addPending(
  mapping: UserMapping,
  approval: PendingApproval,
): void {
  mapping.pending[approval.gh_login] = approval;
}

export function isResolved(mapping: UserMapping, ghLogin: string): boolean {
  return ghLogin in mapping.entries;
}

export function isPending(mapping: UserMapping, ghLogin: string): boolean {
  return ghLogin in mapping.pending;
}

/** Look up a matched Lark open_id by GitHub login. Returns undefined for skipped or unknown users. */
export function larkIdForGithub(
  mapping: UserMapping,
  ghLogin: string,
): string | undefined {
  const e = mapping.entries[ghLogin];
  return e?.status === 'matched' ? e.lark_open_id : undefined;
}

export function countPending(mapping: UserMapping): number {
  return Object.keys(mapping.pending).length;
}

export type { MatchCandidate };
