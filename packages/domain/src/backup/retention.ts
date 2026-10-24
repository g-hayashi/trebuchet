import type { BackupFileInfo } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 直近のこの期間は日ごとに最新の 1 つを残す */
export const DAILY_RETENTION_MS = 30 * DAY_MS;
/** これより古いファイルは消す（年数） */
export const RETENTION_YEARS = 7;

function newest(files: BackupFileInfo[]): BackupFileInfo {
  return files.reduce((a, b) =>
    b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.name > a.name) ? b : a,
  );
}

function groupLatest(files: BackupFileInfo[], keyLength: number): Set<string> {
  const best = new Map<string, BackupFileInfo>();
  for (const f of files) {
    const key = f.createdAt.slice(0, keyLength);
    const cur = best.get(key);
    best.set(key, cur === undefined ? f : newest([cur, f]));
  }
  return new Set([...best.values()].map((f) => f.name));
}

/**
 * 世代の整理で消すファイルを選ぶ（INV-27、R11）。純関数。
 * - この Mac（`macId` の先頭 8 文字）のファイルだけを対象にする
 * - 直近 30 日は UTC の日ごとに最新の 1 つ、それより前は月ごとに最新の 1 つを残す
 * - 7 年より古いものは消す
 * - 今回のファイル（`now` に最も近い 1 つ）は決して選ばない
 * `now` と `createdAt` は ISO 8601。
 */
export function selectBackupsToPrune(
  files: readonly BackupFileInfo[],
  macId: string,
  now: string,
): BackupFileInfo[] {
  const prefix = macId.slice(0, 8).toLowerCase();
  const own = files.filter((f) => f.macId.toLowerCase() === prefix);
  if (own.length === 0) return [];
  const nowMs = Date.parse(now);
  const cutoff = new Date(nowMs);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - RETENTION_YEARS);
  const cutoffMs = cutoff.getTime();

  const recent: BackupFileInfo[] = [];
  const older: BackupFileInfo[] = [];
  for (const f of own) {
    const at = Date.parse(f.createdAt);
    if (nowMs - at < DAILY_RETENTION_MS) recent.push(f);
    else if (at >= cutoffMs) older.push(f);
  }

  const kept = new Set<string>([...groupLatest(recent, 10), ...groupLatest(older, 7)]);
  const current = own.reduce((a, b) => {
    const da = Math.abs(Date.parse(a.createdAt) - nowMs);
    const db = Math.abs(Date.parse(b.createdAt) - nowMs);
    return db < da ? b : a;
  });
  kept.add(current.name);

  return own.filter((f) => !kept.has(f.name));
}
