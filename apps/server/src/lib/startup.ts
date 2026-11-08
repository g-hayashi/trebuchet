import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { removeStaleSnapshots } from "@trebuchet/db";
import {
  type BackupScheduler,
  type BackupSchedulerDeps,
  startBackupScheduler,
} from "./backup-scheduler.ts";
import type { FmServer } from "./fm-server.ts";
import { RECEIPT_CONVERT_DIR_PREFIX } from "./image-tool.ts";
import {
  type RecurringScheduler,
  type RecurringSchedulerDeps,
  startRecurringScheduler,
} from "./recurring-scheduler.ts";
import { startSessionSweeper } from "./session-sweeper.ts";
import type { Vault } from "./vault.ts";

export type BackgroundServices = {
  /** 起動時に消した、前回の異常終了で残った平文の写しの数 */
  removedSnapshots: number;
  /** 起動時に消した、前回の異常終了で残った証憑の変換の作業ディレクトリ（平文の写し）の数 */
  removedReceiptConversions: number;
  stop(): void;
};

/**
 * 前回の異常終了で残った証憑の変換の作業ディレクトリ（`<tmpRoot>/receipt-convert-*`。平文の写し。
 * 010/R9）を消す。消した数を返す。`removeStaleSnapshots`（004）と同じ
 */
export function removeStaleReceiptConversions(tmpRoot: string): number {
  if (!existsSync(tmpRoot)) return 0;
  let removed = 0;
  for (const entry of readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(RECEIPT_CONVERT_DIR_PREFIX)) continue;
    rmSync(join(tmpRoot, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * server の起動の処理（`main.ts` から呼ぶ）。
 * 前回の異常終了で残った平文の写し（`<tmpRoot>/backup-snapshot-*`）は起動時に消す。
 * 自動のバックアップ（004 R10）と定期仕訳の自動登録（005 R18）は、解錠で始め（最初の判断はすぐに行う）、
 * 施錠で止める（008 の D7。施錠中は registry・事業体の DB を開けない）。
 * 有効なセッションがなくなったら施錠する判定（008 の D3）を 1 分ごとに行う。時計は全部で共有する
 */
export function startBackgroundServices(
  deps: BackupSchedulerDeps & {
    tmpRoot: string;
    recurring: Omit<RecurringSchedulerDeps, "clock">;
    /** 端末内の AI（`fm serve`。006 R10）。終了時に止める。起動は最初の推定のとき */
    fm?: Pick<FmServer, "stop">;
    vault: Vault;
    /** 解錠のたびに（背景の処理を始める前に）1 回呼ぶ。失敗しても背景の処理は始める。デモ事業の作りかけの後始末に使う（014 R2） */
    onUnlock?: () => void;
  },
): BackgroundServices {
  const removedSnapshots = removeStaleSnapshots(deps.tmpRoot);
  const removedReceiptConversions = removeStaleReceiptConversions(deps.tmpRoot);
  let running: { backup: BackupScheduler; recurring: RecurringScheduler } | null = null;

  function start(): void {
    if (running !== null) return;
    try {
      deps.onUnlock?.();
    } catch (e) {
      console.error("onUnlock に失敗", e instanceof Error ? e.name : "unknown");
    }
    const backup = startBackupScheduler(deps);
    const recurring = startRecurringScheduler({ ...deps.recurring, clock: deps.clock });
    running = { backup, recurring };
    void backup.tick();
    void recurring.tick();
  }

  function halt(): void {
    running?.backup.stop();
    running?.recurring.stop();
    running = null;
  }

  const unsubscribe = deps.vault.subscribe((unlocked) => (unlocked ? start() : halt()));
  if (deps.vault.isUnlocked()) start();
  const sweeper = startSessionSweeper({ store: deps.auth, vault: deps.vault, clock: deps.clock });

  return {
    removedSnapshots,
    removedReceiptConversions,
    stop: () => {
      unsubscribe();
      sweeper.stop();
      halt();
      deps.fm?.stop();
    },
  };
}
