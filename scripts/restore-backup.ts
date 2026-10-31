/**
 * バックアップ（.tbk）をデータ場所へ復元する（contracts/cli.md「復元のコマンド」、research R13）。
 * データ場所を置き換える操作。元のデータ場所は `<dataDir>.before-restore-<日時>/` に残り、
 * 今の帳簿は復元の前に `<dataDir>/../trebuchet-before-restore-<日時>.tbk` にバックアップされる。
 *
 *   pnpm restore -- --file <path/to/backup.tbk> [--data-dir <dir>] [--yes]
 *
 * - `--data-dir` の既定は TREBUCHET_DATA_DIR、なければリポジトリ直下の `data/`
 * - 回復キー（初回の設定・再発行で表示した 4 文字区切りのキー）を標準入力から受け取る。端末ならエコーなしで入力し、
 *   パイプでも 1 行目を読む（そのときは確認も標準入力を使えないので `--yes` が要る）。引数・環境変数では受け取らない（`ps` に出るため）。バックアップのヘッダーの包み →
 *   今のデータ場所の `auth.sqlite` の recovery の包みの順に試す。復元した後の `auth.sqlite` は、DK を開けた
 *   recovery の包みだけ（パスキーとセッションは空）。次の起動で回復キーで解錠し、パスキーを登録する
 * - server が 127.0.0.1:8787 で動いていれば中止する。先に停止すること
 * - 終了コード: 0 = 成功、1 = 検査の失敗、2 = 使い方の誤り、3 = server が動いている、4 = 取り消し
 *
 * 平文の写しは `.tmp/` の下に作り、必ず消す。本体は scripts/lib/restore-cli.ts。
 */
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isServerRunning, runRestoreCli } from "./lib/restore-cli.ts";

/** 標準入力から 1 行読む。端末なら入力は画面に出さない。パイプなら 1 行目（空なら失敗） */
function readHiddenLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin });
      rl.once("line", (line) => {
        rl.close();
        if (line.trim() === "") reject(new Error("empty"));
        else resolve(line);
      });
      rl.once("close", () => reject(new Error("no input")));
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
  readRecoveryKey: () => readHiddenLine("回復キー: "),
  confirm: askYesNo,
  isServerRunning: () => isServerRunning(),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
process.exit(code);
