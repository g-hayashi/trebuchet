/**
 * SC-005（004）のベンチマーク: 仕訳 数千件/年 × 3 年 × 複数の事業体の帳簿で、手動のバックアップ
 * （snapshotDataDir → packArchive → encryptBackup → writeBackupFile〔読み戻しの復号と展開の検証を含む〕）が
 * 30 秒以内に終わり、その間の event loop の遅延の p99 が 200 ms 以下か（画面と API の応答が止まらないか）を測る。
 * `.tmp/` の下に一時のデータ場所とバックアップの置き場所を作り、終了時に削除する。
 * 暗号化は本物の Argon2id（memory 65536 KiB、passes 3）。結果の数値はコミットしない。
 *
 *   pnpm bench:backup
 *   BENCH_BACKUP_LIMIT_MS=30000 BENCH_BACKUP_LOOP_P99_MS=200 pnpm bench:backup   # しきい値の変更
 *   BENCH_BACKUP_ENTITIES=2 BENCH_BACKUP_YEARS=2 BENCH_BACKUP_JOURNALS=100 pnpm bench:backup   # 小さい件数
 *
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む
 */
import { randomUUIDv7 } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { packArchive, unpackArchive } from "../packages/db/src/backup/archive.ts";
import { decryptBackup, encryptBackup } from "../packages/db/src/backup/crypto.ts";
import { backupFileName, writeBackupFile } from "../packages/db/src/backup/file.ts";
import {
  createSnapshotDir,
  currentAppVersion,
  snapshotDataDir,
} from "../packages/db/src/backup/snapshot.ts";
import { DrizzleLedgerRepository } from "../packages/db/src/ledger-repository.ts";
import { DrizzleMasterRepository } from "../packages/db/src/master-repository.ts";
import { openTenant } from "../packages/db/src/tenant-store.ts";
import { TMP_ROOT, useTempDataDir } from "../packages/db/src/testing.ts";
import { type JournalLine, ok, type ValidLine } from "../packages/domain/src/types.ts";
import { createNextFiscalPeriod } from "../packages/domain/src/usecases/masters.ts";
import {
  benchClock as clock,
  createBenchEntity,
  benchIds as ids,
  positiveNumber,
  runBench,
} from "./lib/bench-common.ts";

const ENTITIES = Math.floor(positiveNumber("BENCH_BACKUP_ENTITIES", 3));
const YEARS = Math.floor(positiveNumber("BENCH_BACKUP_YEARS", 3));
const JOURNALS_PER_YEAR = Math.floor(positiveNumber("BENCH_BACKUP_JOURNALS", 3_000));
const LIMIT_MS = positiveNumber("BENCH_BACKUP_LIMIT_MS", 30_000);
const LOOP_P99_LIMIT_MS = positiveNumber("BENCH_BACKUP_LOOP_P99_MS", 200);
const FIRST_YEAR = 2024;
const PASSPHRASE = "bench-backup-passphrase-0123456789";
const MAC_ID = "benchmac0000";

const tmp = useTempDataDir("bench-backup");
const outDir = join(TMP_ROOT, `bench-backup-out-${randomUUIDv7()}`);
await runBench(
  async () => {
    mkdirSync(outDir, { recursive: true });

    // ---- 合成の帳簿（use case とリポジトリを直接使う。HTTP は通さない） ----
    const setupStart = performance.now();
    let journalCount = 0;
    for (let e = 0; e < ENTITIES; e++) {
      const entity = createBenchEntity({
        name: `ベンチ事業体 ${e + 1}`,
        firstFiscalYear: FIRST_YEAR,
      });
      const db = openTenant(entity.id);
      const masters = new DrizzleMasterRepository(db);
      for (let y = 1; y < YEARS; y++) {
        const next = createNextFiscalPeriod({ repo: masters, ids, clock });
        if (!next.ok) throw new Error(next.error.message);
      }
      const accountId = (name: string): string => {
        const found = masters.listAccounts().find((a) => a.name === name);
        if (found === undefined) throw new Error(`科目がありません: ${name}`);
        return found.id;
      };
      const cash = accountId("普通預金");
      const sales = accountId("売上高");
      const expense = accountId("消耗品費");
      const ledger = new DrizzleLedgerRepository(db);
      const periods = masters.listFiscalPeriods();
      ledger.transaction((tx) => {
        if (!(tx instanceof DrizzleLedgerRepository)) throw new Error("想定外のリポジトリ");
        for (const period of periods) {
          const start = Date.parse(`${period.startDate}T00:00:00Z`);
          for (let i = 0; i < JOURNALS_PER_YEAR; i++) {
            const amount = 1_000 + ((i * 7_919 + e * 31) % 90_000);
            const isSale = i % 2 === 0;
            const line = (
              lineNo: number,
              side: ValidLine["side"],
              account: string,
            ): JournalLine => ({
              id: ids.next(),
              lineNo,
              side,
              accountId: account,
              subAccountId: null,
              amount,
              taxCategory: "OUT_OF_SCOPE",
              taxAmount: 0,
              partnerId: null,
              description: `ベンチ摘要 ${e}-${period.fiscalYear}-${i} 取引先ベンチ株式会社 備品の購入と代金の支払い`,
              tagIds: [],
            });
            tx.insertJournal({
              id: ids.next(),
              journalNo: tx.nextJournalNo(),
              date: new Date(start + Math.floor((i * 360) / JOURNALS_PER_YEAR) * 86_400_000)
                .toISOString()
                .slice(0, 10),
              fiscalPeriodId: period.id,
              memo: `ベンチ備考 ${i}`,
              correctsJournalId: null,
              createdAt: clock.now(),
              lines: isSale
                ? [line(1, "debit", cash), line(2, "credit", sales)]
                : [line(1, "debit", expense), line(2, "credit", cash)],
            });
            journalCount += 1;
          }
        }
        return ok(null);
      });
    }
    console.log(
      `合成の帳簿: 事業体 ${ENTITIES} 件 × ${YEARS} 年 × ${JOURNALS_PER_YEAR} 仕訳（計 ${journalCount} 仕訳）を作成: ${(performance.now() - setupStart).toFixed(0)} ms`,
    );

    // ---- 手動のバックアップ（snapshot → pack → encrypt → 書き込みと検証）を計る ----
    const appVersion = currentAppVersion();
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    const phases: [name: string, time: number, loopMax: number][] = [];
    /** 工程ごとの時間と、その間の event loop の遅延の最大（どの工程が止めているかの診断） */
    const phase = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
      const local = monitorEventLoopDelay({ resolution: 10 });
      local.enable();
      const start = performance.now();
      const value = await run();
      const time = performance.now() - start;
      // 工程の最後の同期区間の遅延は、loop が一度回ってから記録される
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      local.disable();
      phases.push([name, time, local.max]);
      return value;
    };

    // 帳簿の作成は同期の処理で長く、libuv の時刻が古いまま計測を始めると最初の標本が膨らむ。
    // 一度 event loop を回してから計測を始める
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    histogram.enable();
    const snapshotDir = createSnapshotDir(TMP_ROOT);
    let fileSize = 0;
    try {
      const snapshot = await phase("snapshot", () => snapshotDataDir(tmp.dir, snapshotDir));
      const archive = await phase("pack", () => packArchive(snapshot));
      const at = new Date();
      const encrypted = await phase("encrypt (Argon2id + AES-GCM)", () =>
        encryptBackup(archive, PASSPHRASE, {
          appVersion,
          macId: MAC_ID,
          createdAt: at.toISOString(),
        }),
      );
      fileSize = encrypted.length;
      await phase("write + verify", () =>
        writeBackupFile(outDir, backupFileName(MAC_ID, at), encrypted, async (readBack) => {
          const check = await decryptBackup(readBack, PASSPHRASE, appVersion);
          return check.ok && unpackArchive(check.value.archive).ok;
        }),
      );
    } finally {
      rmSync(snapshotDir, { recursive: true, force: true });
    }
    // 工程の時間の合計（診断用の待ちは含めない）
    const elapsed = phases.reduce((sum, [, time]) => sum + time, 0);
    histogram.disable();

    const files = readdirSync(outDir).filter((n) => n.endsWith(".tbk"));
    if (files.length !== 1)
      throw new Error(`バックアップのファイルが ${files.length} 個: 1 個のはず`);
    const onDisk = statSync(join(outDir, files[0] ?? "")).size;
    if (onDisk !== fileSize) throw new Error("書いたファイルの大きさが暗号文と違います");

    const ms = (ns: number): number => Number((ns / 1e6).toFixed(1));
    const p99 = ms(histogram.percentile(99));
    const max = ms(histogram.max);
    console.log(`バックアップのファイル: ${(fileSize / 1024 / 1024).toFixed(1)} MiB`);
    console.table(
      phases.map(([name, time, loopMax]) => ({
        phase: name,
        "time (ms)": Number(time.toFixed(0)),
        "loop delay max (ms)": ms(loopMax),
      })),
    );
    console.table([
      {
        "total (ms)": Number(elapsed.toFixed(0)),
        "limit (ms)": LIMIT_MS,
        "loop delay p99 (ms)": p99,
        "p99 limit (ms)": LOOP_P99_LIMIT_MS,
        "loop delay max (ms)": max,
      },
    ]);

    const timeOk = elapsed <= LIMIT_MS;
    const loopOk = p99 <= LOOP_P99_LIMIT_MS;
    if (!timeOk)
      console.error(
        `SC-005 を満たしません: ${elapsed.toFixed(0)} ms が ${LIMIT_MS} ms を超えました`,
      );
    if (!loopOk) {
      console.error(
        `SC-005 を満たしません: event loop の遅延の p99 ${p99} ms が ${LOOP_P99_LIMIT_MS} ms を超えました`,
      );
    }
    if (!(timeOk && loopOk)) return false;
    console.log(
      `SC-005 OK: ${(elapsed / 1000).toFixed(1)} 秒（上限 ${LIMIT_MS / 1000} 秒）、event loop の遅延の p99 は ${p99} ms（上限 ${LOOP_P99_LIMIT_MS} ms）`,
    );
    return true;
  },
  () => {
    rmSync(outDir, { recursive: true, force: true });
    tmp.cleanup();
  },
);
