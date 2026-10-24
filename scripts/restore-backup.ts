/**
 * バックアップ（.tbk）をデータ場所へ復元する（contracts/cli.md「復元のコマンド」、research R13）。
 * データ場所を置き換える操作。元のデータ場所は `<dataDir>.before-restore-<日時>/` に残り、
 * 今の帳簿は復元の前に `<dataDir>/../trebuchet-before-restore-<日時>.tbk` にバックアップされる。
 *
 *   pnpm restore -- --file <path/to/backup.tbk> [--data-dir <dir>] [--yes]
 *
 * - `--data-dir` の既定は TREBUCHET_DATA_DIR、なければリポジトリ直下の `data/`
 * - パスフレーズは端末から入力する（エコーなし）。引数・環境変数では受け取らない
 * - server が 127.0.0.1:8787 で動いていれば中止する。先に停止すること
 * - 終了コード: 0 = 成功、1 = 検査の失敗、2 = 使い方の誤り、3 = server が動いている、4 = 取り消し
 *
 * 平文の写しは `.tmp/` の下に作り、必ず消す。本体は scripts/lib/restore-cli.ts。
 */
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isServerRunning, runRestoreCli } from "./lib/restore-cli.ts";

/** 端末から 1 行読む。入力は画面に出さない */
function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("not a terminal"));
      return;
    }
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let line = "";
    const finish = (action: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      action();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish(() => resolve(line));
          return;
        }
        if (ch === "\u0003") {
          finish(() => reject(new Error("interrupted")));
          return;
        }
        if (ch === "\u007f" || ch === "\b") line = Array.from(line).slice(0, -1).join("");
        else line += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const code = await runRestoreCli(process.argv.slice(2), {
  env: process.env,
  defaultDataDir: fileURLToPath(new URL("../data", import.meta.url)),
  tmpRoot: fileURLToPath(new URL("../.tmp/", import.meta.url)),
  readPassphrase: () => readHiddenLine("バックアップのパスフレーズ: "),
  confirm: askYesNo,
  isServerRunning: () => isServerRunning(),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
process.exit(code);
