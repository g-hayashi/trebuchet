import { spawn } from "node:child_process";
import type { SecretStore } from "@trebuchet/domain";

/** バックアップのパスフレーズをキーチェーンに入れるときの名前（service）。account は `ACCOUNT` */
export const BACKUP_PASSPHRASE_KEY = "trebuchet-backup";

const ACCOUNT = "trebuchet";
const SECURITY = "/usr/bin/security";
/** `security find-generic-password` などで項目がないときの終了コード */
const NOT_FOUND = 44;
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const TIMEOUT_MS = 15_000;

/** `/usr/bin/security` の実行。標準入力に `input` を流す。テストは偽物に差し替える */
export type SecurityExec = (
  args: string[],
  input?: string,
) => Promise<{ code: number; stdout: string }>;

/** 既定の実行関数。引数にはパスフレーズを載せない（ps に出るため）。標準入力だけで渡す */
export const execSecurity: SecurityExec = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(SECURITY, args, { stdio: ["pipe", "pipe", "ignore"], timeout: TIMEOUT_MS });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => reject(new Error("keychain: security を実行できない")));
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });

/**
 * `security -i`（対話モード）の 1 行に入れる値のエスケープ。対話モードは行を空白で区切り引用符を解釈するので、
 * 値は二重引用符で囲み、`"` と `\` をバックスラッシュでエスケープする（research R12）。
 * 改行・復帰・NUL を含む値は、1 行に収まらないので拒否する。
 */
export function escapeForSecurityShell(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("keychain: 改行を含む値は保存できない");
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function checkKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error("keychain: キーの形が違う");
}

/**
 * macOS キーチェーンの SecretStore（R12）。`key` は service 名。account は固定。
 * 保存は `security -i` の標準入力に `add-generic-password -U … -w "<値>"` の 1 行を流す
 * （引数に値を載せない）。対話モードは失敗を終了コードで返さないことがあるので、保存の後に読み戻して確かめる。
 * エラーのメッセージに値・`security` の出力を含めない。
 */
export function createKeychainSecretStore(exec: SecurityExec = execSecurity): SecretStore {
  const find = async (key: string): Promise<string | undefined> => {
    const r = await exec(["find-generic-password", "-a", ACCOUNT, "-s", key, "-w"]);
    if (r.code === NOT_FOUND) return undefined;
    if (r.code !== 0) throw new Error("keychain: 読み出しに失敗");
    return r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
  };
  return {
    async get(key) {
      checkKey(key);
      return find(key);
    },
    async set(key, value) {
      checkKey(key);
      const line = `add-generic-password -U -a ${ACCOUNT} -s ${key} -w "${escapeForSecurityShell(value)}"\n`;
      const r = await exec(["-i"], line);
      if (r.code !== 0 || (await find(key)) !== value) throw new Error("keychain: 保存に失敗");
    },
    async delete(key) {
      checkKey(key);
      const r = await exec(["delete-generic-password", "-a", ACCOUNT, "-s", key]);
      if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error("keychain: 削除に失敗");
    },
  };
}

/** メモリだけの SecretStore。保存しない（server の再起動で消える）。キーチェーンが使えない環境の代替 */
export function createMemorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}
