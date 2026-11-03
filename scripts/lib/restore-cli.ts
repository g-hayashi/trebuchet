/**
 * `pnpm restore -- --file <backup.tbk> [--data-dir <dir>] [--yes]` の本体（contracts/cli.md「復元のコマンド」）。
 * 端末の入力と server の確認は deps で差し替えられる（テスト用）。回復キーは引数・環境変数では受け取らない
 * （標準入力から読む。引数は `ps` に出る）。
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む。
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RECEIPT_STORE_DIRNAME } from "../../packages/db/src/backup/receipts.ts";
import {
  type RestoreErrorCode,
  type RestoreOptions,
  type RestoreSummary,
  restoreBackup,
} from "../../packages/db/src/backup/restore.ts";

const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;
const EXIT_SERVER_RUNNING = 3;
const EXIT_CANCELLED = 4;

const SERVER_PORT = 8787;

export type RestoreCliDeps = {
  env: Record<string, string | undefined>;
  /** `--data-dir` も `TREBUCHET_DATA_DIR` もないときの場所（リポジトリ直下の `data/`） */
  defaultDataDir: string;
  /** 平文の写しの作業場所（`.tmp/`） */
  tmpRoot: string;
  /** 標準入力から回復キーを 1 行読む（端末ならエコーなし） */
  readRecoveryKey: () => Promise<string>;
  /** 端末で y/N を尋ねる */
  confirm: (question: string) => Promise<boolean>;
  isServerRunning: () => Promise<boolean>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  restore?: (options: RestoreOptions) => ReturnType<typeof restoreBackup>;
};

/** 127.0.0.1 の port に接続できれば、server（または何か）が動いているとみなす */
export function isServerRunning(port: number = SERVER_PORT, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (running: boolean) => {
      socket.destroy();
      resolve(running);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const USAGE =
  "使い方: pnpm restore -- --file <backup.tbk> [--data-dir <dir>] [--receipts-dir <dir>] [--allow-missing-receipts] [--yes]";

const MESSAGES: Record<RestoreErrorCode, string> = {
  INVALID: "回復キーが違うか、ファイルが壊れています",
  VERSION_MISMATCH:
    "アプリの版が一致しません。このバックアップを取った版のアプリで復元してください",
  CANCELLED: "取り消しました",
  BEFORE_BACKUP_FAILED:
    "復元の前の帳簿のバックアップを書けなかったため、中止しました。帳簿は変わっていません",
  RESTORE_FAILED: "復元に失敗しました。帳簿は変わっていません",
  RECEIPTS_MISSING:
    "証憑のファイルが置き場所にそろっていません。帳簿は変わっていません。--receipts-dir で置き場所を指定するか、帳簿だけを戻すなら --allow-missing-receipts を付けてください",
};

function formatSummary(summary: RestoreSummary): string[] {
  const lines = [`作成日時: ${summary.createdAt}`, `作った Mac: ${summary.macId}`, "事業体:"];
  if (summary.entities.length === 0) lines.push("  （なし）");
  for (const e of summary.entities) {
    const years = e.fiscalYears.map((y) => `${y.year}年度 ${y.journals}件`).join("、");
    lines.push(`  ${e.name}: ${years === "" ? "年度なし" : years}`);
  }
  if (summary.differences.length > 0) {
    lines.push("今の帳簿に同じ事業体があります（今の帳簿 → バックアップ）:");
    for (const d of summary.differences) {
      lines.push(
        `  ${d.name}: 仕訳 ${d.current.journals}件 → ${d.backup.journals}件、` +
          `最後の更新 ${d.current.lastUpdatedAt ?? "なし"} → ${d.backup.lastUpdatedAt ?? "なし"}`,
      );
    }
  }
  if (summary.hasExistingLedger) {
    lines.push("今の帳簿は、復元の前にバックアップして残します。");
  }
  return lines;
}

/** 終了コードを返す（process.exit は呼ばない） */
export async function runRestoreCli(argv: string[], deps: RestoreCliDeps): Promise<number> {
  // pnpm は `--` をそのまま渡すことがある
  const rest = argv[0] === "--" ? argv.slice(1) : argv;
  let values: {
    file?: string | undefined;
    "data-dir"?: string | undefined;
    yes?: boolean | undefined;
    "receipts-dir"?: string | undefined;
    "allow-missing-receipts"?: boolean | undefined;
  };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        file: { type: "string" },
        "data-dir": { type: "string" },
        yes: { type: "boolean" },
        "receipts-dir": { type: "string" },
        "allow-missing-receipts": { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    deps.stderr(USAGE);
    return EXIT_USAGE;
  }
  const file = values.file;
  if (file === undefined || file === "") {
    deps.stderr(`--file が必要です。${USAGE}`);
    return EXIT_USAGE;
  }
  const dataDir = values["data-dir"] ?? deps.env.TREBUCHET_DATA_DIR ?? deps.defaultDataDir;

  // 1. server が動いていれば中止
  if (await deps.isServerRunning()) {
    deps.stderr("server が動いています。停止してから復元してください");
    return EXIT_SERVER_RUNNING;
  }
  if (!existsSync(file)) {
    deps.stderr(`バックアップのファイルが見つかりません: ${file}`);
    return EXIT_USAGE;
  }

  let recoveryKey: string;
  try {
    recoveryKey = await deps.readRecoveryKey();
  } catch {
    deps.stderr("回復キーを標準入力から入力してください");
    return EXIT_USAGE;
  }

  // 証憑の写しの置き場所の既定は、.tbk と同じフォルダの trebuchet-receipts/（010 R11）
  const receiptsDir = values["receipts-dir"] ?? join(dirname(resolve(file)), RECEIPT_STORE_DIRNAME);
  let missingReceipts = 0;
  const restore = deps.restore ?? restoreBackup;
  const result = await restore({
    file,
    recoveryKey,
    dataDir,
    tmpRoot: deps.tmpRoot,
    receiptsDir,
    allowMissingReceipts: values["allow-missing-receipts"] === true,
    onReceiptsMissing: (count) => {
      missingReceipts = count;
    },
    confirm: async (summary) => {
      for (const line of formatSummary(summary)) deps.stdout(line);
      if (values.yes === true) return true;
      return deps.confirm("この内容で復元しますか");
    },
  });
  if (!result.ok) {
    deps.stderr(MESSAGES[result.error]);
    if (result.error === "RECEIPTS_MISSING") {
      deps.stderr(`見つからない、または壊れている証憑のファイル: ${missingReceipts} 件`);
    }
    return result.error === "CANCELLED" ? EXIT_CANCELLED : EXIT_INVALID;
  }
  if (result.value.beforeRestoreBackup !== null) {
    deps.stdout(`復元の前の帳簿のバックアップ: ${result.value.beforeRestoreBackup}`);
  }
  if (result.value.previousDataDir !== null) {
    deps.stdout(`元のデータ場所: ${result.value.previousDataDir}`);
  }
  if (result.value.missingReceipts > 0) {
    deps.stdout(
      `戻せなかった証憑のファイル: ${result.value.missingReceipts} 件（画面では「ファイルがありません」と表示されます）`,
    );
  }
  deps.stdout("復元しました。アプリを起動し、回復キーで解錠して、新しいパスキーを登録してください");
  return EXIT_OK;
}
