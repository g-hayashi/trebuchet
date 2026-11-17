/**
 * リリースの見本のバックアップを作る（`docs/development.md` の「互換性（公開後）」の「リリースの手順」、ADR 0016）。
 *
 *   pnpm backup:fixture
 *
 * `.tmp/` の一時のデータ場所に合成の帳簿（事業体 2 つ。デモ事業の計画と、締め・決算整理・明細の承認などを足した事業）を
 * server のアプリ（`app.request`。HTTP の口は開けない）で作り、テスト専用の固定の DK・回復キーで `.tbk` を書く。
 * 出力は `packages/db/test/fixtures/backups/v<ルートの package.json の version>/`:
 * `backup.tbk`、`trebuchet-receipts/`（証憑の写し。.tbk の外）、`expected.json`（照合する値）、`README.md`。
 * その版のフォルダが既にあれば何も書かずに失敗する（既存の見本は書き換えない）。
 * 書く前に、作った `.tbk` を一時の場所へ `restoreBackup` で戻して expected.json と一致することを確かめる。
 * 実データ（`data/`・`work/`）は読まない。取引先・摘要はすべて架空。AI は呼ばない。
 *
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む
 */
import { randomUUIDv7 } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../apps/server/src/app.ts";
import { DEV_WEB_HOST, DEV_WEB_ORIGIN } from "../apps/server/src/lib/origin.ts";
import { issueSession, SESSION_COOKIE } from "../apps/server/src/lib/session.ts";
import { DrizzleAuthStore } from "../packages/db/src/auth-repository.ts";
import { packArchive } from "../packages/db/src/backup/archive.ts";
import { encryptBackup } from "../packages/db/src/backup/crypto.ts";
import {
  receiptRefsFromSnapshotFiles,
  receiptStoreDir,
  syncReceiptsToStore,
} from "../packages/db/src/backup/receipts.ts";
import { restoreBackup } from "../packages/db/src/backup/restore.ts";
import {
  createSnapshotDir,
  currentAppVersion,
  currentRelease,
  snapshotDataDir,
} from "../packages/db/src/backup/snapshot.ts";
import { parseRecoveryKey } from "../packages/db/src/recovery-key.ts";
import { closeAll, dataDir, openAuth, openRegistry } from "../packages/db/src/tenant-store.ts";
import { TEST_DATA_KEY, useTempDataDir } from "../packages/db/src/testing.ts";
import { wrapDataKey } from "../packages/db/src/vault-crypto.ts";
import {
  LOCAL_RP_ID,
  ok,
  type ReceiptImageTool,
  type ReceiptReader,
} from "../packages/domain/src/index.ts";
import {
  BACKUP_FIXTURES_DIR,
  compareSummaries,
  FIXTURE_BACKUP_FILE,
  FIXTURE_EXPECTED_FILE,
  type FixtureExpected,
  summarizeDataDir,
} from "./lib/backup-fixture.ts";
import { buildFixtureLedger } from "./lib/backup-fixture-ledger.ts";

/**
 * テスト専用の回復キー（見本のバックアップを開くためだけのもの。実データの鍵ではない）。DK は
 * `useTempDataDir` のテスト用の固定の DK（`TEST_DATA_KEY`）。本番のコードに置かない
 */
const TEST_ONLY_RECOVERY_KEY = "TEST-0000-0000-0000-0000-0000-0000-0001";
/** 帳簿を作る日時（アプリの時計）と、ヘッダーの作成日時 */
const CREATED_AT = "2026-11-16T03:00:00.000Z";
const MAC_ID = "f1e7e5e0-0000-4000-8000-000000000000";

/** 証憑の画像の寸法を調べる部品の代わり（sips を呼ばない。寸法は固定） */
const imageTool: ReceiptImageTool = {
  probe: async () => ok({ width: 800, height: 1100, fullColor: true }),
  toDisplay: async (bytes, mediaType) => ok({ bytes, mediaType }),
  toAiJpeg: async () => ok(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
};

/** 証憑の読み取りの代わり（外部の AI を呼ばない。決まった候補を返す） */
const reader: ReceiptReader = {
  model: async () => "fixture-reader",
  read: async () =>
    ok({
      transactionDate: "2026-04-01",
      amount: 1_100,
      partnerName: "見本文具店",
      accountCode: null,
      taxCategory: null,
      confidence: "medium",
      reason: "見本",
    }),
};

function readme(expected: FixtureExpected): string {
  const entities = expected.entities
    .map(
      (e) =>
        `- ${e.name}: 仕訳 ${e.journals} 件、会計年度 ${e.trialBalances.map((t) => t.fiscalYear).join("・")}`,
    )
    .join("\n");
  return `# 見本のバックアップ v${expected.release}

v${expected.release} のアプリで \`pnpm backup:fixture\`（\`scripts/make-backup-fixture.ts\`）が作った見本。
\`packages/db/test/backup-fixtures.test.ts\` が、毎回今の版で復元して \`expected.json\` と照合する。

- **書き換えない・消さない**。互換を壊す変更はテストが赤で止める。直すのは今の版のコード（マイグレーション・復元）の側
- 帳簿は合成（架空の取引先・摘要）。実データを含まない
- 鍵はテスト専用: DK は \`TEST_DATA_KEY\`（\`packages/db/src/testing.ts\`）、回復キーは \`expected.json\` の \`recoveryKey\`
- アプリの版（マイグレーションの数）: registry ${expected.appVersion.registry}、tenant ${expected.appVersion.tenant}
- 作成日時: ${expected.createdAt}

${entities}

| ファイル | 中身 |
|---|---|
| \`${FIXTURE_BACKUP_FILE}\` | バックアップ（ヘッダーの \`release\` は ${expected.release}） |
| \`trebuchet-receipts/\` | 証憑の写し（.tbk の外。復元の既定の置き場所） |
| \`${FIXTURE_EXPECTED_FILE}\` | 照合する値（仕訳の件数と内容のハッシュ、会計年度ごとの試算表、表ごとの行数） |
`;
}

async function main(): Promise<number> {
  const release = currentRelease();
  const outDir = join(BACKUP_FIXTURES_DIR, `v${release}`);
  if (existsSync(outDir)) {
    console.error(
      `見本 v${release} は既にあります（${outDir}）。既存の見本は書き換えません。package.json の version を上げてから実行してください`,
    );
    return 1;
  }
  const secret = parseRecoveryKey(TEST_ONLY_RECOVERY_KEY);
  if (secret === null) throw new Error("回復キーの形が違う");

  const tmp = useTempDataDir("backup-fixture");
  try {
    // ---- 合成の帳簿（server のアプリを app.request で呼ぶ。時計は固定） ----
    const clock = { now: () => CREATED_AT };
    const { token } = await issueSession(new DrizzleAuthStore(openAuth(), openRegistry), {
      id: randomUUIDv7(),
      now: CREATED_AT,
      kind: "normal",
      rpId: LOCAL_RP_ID,
      passkeyId: null,
      userAgent: null,
    });
    const headers = {
      Host: DEV_WEB_HOST,
      Origin: DEV_WEB_ORIGIN,
      Cookie: `${SESSION_COOKIE}=${token}`,
    };
    const app = createApp({ clock, receipts: { imageTool, reader } });
    await buildFixtureLedger(async (path, init) => {
      const h = new Headers(init?.headers);
      for (const [k, v] of Object.entries(headers)) if (!h.has(k)) h.set(k, v);
      return await app.request(path, { ...init, headers: h });
    });

    const summary = summarizeDataDir();
    const expected: FixtureExpected = {
      release,
      appVersion: currentAppVersion(),
      createdAt: CREATED_AT,
      recoveryKey: TEST_ONLY_RECOVERY_KEY,
      ...summary,
    };

    // ---- .tbk と証憑の写し（server のバックアップの実行と同じ部品） ----
    const staging = join(tmp.dir, "out");
    mkdirSync(staging, { recursive: true });
    const snapDir = createSnapshotDir(join(tmp.dir, "scratch"));
    let archive: Buffer;
    let refs: ReturnType<typeof receiptRefsFromSnapshotFiles>;
    try {
      const snapshot = snapshotDataDir(dataDir(), snapDir);
      refs = receiptRefsFromSnapshotFiles(snapshot.files);
      archive = packArchive(snapshot);
    } finally {
      rmSync(snapDir, { recursive: true, force: true });
    }
    const encrypted = encryptBackup(archive, TEST_DATA_KEY, {
      appVersion: expected.appVersion,
      macId: MAC_ID,
      createdAt: CREATED_AT,
      recoveryWrap: wrapDataKey(TEST_DATA_KEY, secret, "recovery", null),
      release,
    });
    const backupFile = join(staging, FIXTURE_BACKUP_FILE);
    writeFileSync(backupFile, encrypted);
    await syncReceiptsToStore({ dk: TEST_DATA_KEY, storeDir: receiptStoreDir(staging), refs });
    writeFileSync(join(staging, FIXTURE_EXPECTED_FILE), `${JSON.stringify(expected, null, 2)}\n`);
    writeFileSync(join(staging, "README.md"), readme(expected));

    // ---- 書く前の確かめ: テストと同じ経路で戻し、expected.json と一致すること ----
    closeAll();
    const restoredDir = join(tmp.dir, "restored", "data");
    const restored = await restoreBackup({
      file: backupFile,
      recoveryKey: TEST_ONLY_RECOVERY_KEY,
      dataDir: restoredDir,
      tmpRoot: join(tmp.dir, "scratch"),
      confirm: () => true,
    });
    if (!restored.ok) throw new Error(`作った見本を復元できない: ${restored.error}`);
    process.env.TREBUCHET_DATA_DIR = restoredDir;
    const problems = compareSummaries(expected, summarizeDataDir());
    if (problems.length > 0) throw new Error(`作った見本が照合に通らない:\n${problems.join("\n")}`);

    mkdirSync(dirname(outDir), { recursive: true });
    renameSync(staging, outDir);

    const empty = [
      ...Object.entries(expected.registry.rows)
        .filter(([, n]) => n === 0)
        .map(([t]) => `registry.${t}`),
      ...expected.entities.flatMap((e) =>
        Object.entries(e.rows)
          .filter(([, n]) => n === 0)
          .map(([t]) => `${e.name}.${t}`),
      ),
    ];
    console.log(`見本 v${release} を書きました: ${outDir}`);
    for (const e of expected.entities) {
      console.log(`  ${e.name}: 仕訳 ${e.journals} 件`);
    }
    console.log(`  .tbk ${encrypted.length} バイト`);
    if (empty.length > 0) console.log(`  行のない表: ${empty.join(", ")}`);
    return 0;
  } finally {
    secret.fill(0);
    tmp.cleanup();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error);
  return 1;
});
