import { describe, expect, it } from "vitest";
import {
  createKeychainSecretStore,
  createMemorySecretStore,
  escapeForSecurityShell,
  type SecurityExec,
} from "../src/lib/keychain.ts";

// T012: キーチェーンに実際には触れない。実行関数を差し替えて、渡す引数と標準入力を確かめる

const KEY = "trebuchet-backup";

type Call = { args: string[]; input: string | undefined };

/** 渡された引数と標準入力を記録し、保存・読み出し・削除の簡単な動きをまねる偽の `security` */
function fakeSecurity(initial?: string) {
  const calls: Call[] = [];
  let value = initial;
  const exec: SecurityExec = async (args, input) => {
    calls.push({ args: [...args], input });
    if (args[0] === "-i") {
      // 標準入力の 1 行 `add-generic-password … -w "<値>"` を読む（引用符と \ のエスケープを戻す）
      const m = /-w "((?:[^"\\]|\\.)*)"\n$/.exec(input ?? "");
      if (m === null) return { code: 1, stdout: "" };
      value = (m[1] ?? "").replace(/\\(.)/g, "$1");
      return { code: 0, stdout: "" };
    }
    if (args[0] === "find-generic-password") {
      return value === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${value}\n` };
    }
    if (args[0] === "delete-generic-password") {
      const had = value !== undefined;
      value = undefined;
      return { code: had ? 0 : 44, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  return { exec, calls };
}

describe("escapeForSecurityShell", () => {
  it("二重引用符とバックスラッシュをエスケープし、他は変えない", () => {
    expect(escapeForSecurityShell('a"b\\c d')).toBe('a\\"b\\\\c d');
    expect(escapeForSecurityShell("日本語 の パスフレーズ")).toBe("日本語 の パスフレーズ");
  });

  it("改行・復帰・NUL を含む値は拒否する", () => {
    for (const bad of ["a\nb", "a\rb", "a\0b"]) {
      expect(() => escapeForSecurityShell(bad)).toThrow();
    }
  });
});

describe("createKeychainSecretStore", () => {
  it("保存は security -i の標準入力の 1 行だけで行い、引数にパスフレーズを載せない", async () => {
    const { exec, calls } = fakeSecurity();
    const store = createKeychainSecretStore(exec);
    const secret = 'pass "q" \\ 日本語 phrase';
    await store.set(KEY, secret);

    const add = calls[0];
    expect(add?.args).toEqual(["-i"]);
    expect(add?.input).toBe(
      `add-generic-password -U -a trebuchet -s ${KEY} -w "pass \\"q\\" \\\\ 日本語 phrase"\n`,
    );
    expect(add?.input?.match(/\n/g)).toHaveLength(1);
    for (const call of calls) expect(call.args.join(" ")).not.toContain("phrase");
  });

  it("読み出し・削除の引数にもパスフレーズは載らず、往復できる", async () => {
    const { exec, calls } = fakeSecurity();
    const store = createKeychainSecretStore(exec);
    const secret = "correct horse battery staple";
    await store.set(KEY, secret);
    expect(await store.get(KEY)).toBe(secret);
    await store.delete(KEY);
    expect(await store.get(KEY)).toBeUndefined();

    expect(calls.find((c) => c.args[0] === "find-generic-password")?.args).toEqual([
      "find-generic-password",
      "-a",
      "trebuchet",
      "-s",
      KEY,
      "-w",
    ]);
    expect(calls.find((c) => c.args[0] === "delete-generic-password")?.args).toEqual([
      "delete-generic-password",
      "-a",
      "trebuchet",
      "-s",
      KEY,
    ]);
    for (const call of calls) expect(call.args.join(" ")).not.toContain(secret);
  });

  it("空白・引用符・バックスラッシュを含む値も往復できる（エスケープの逆変換と一致する）", async () => {
    const { exec } = fakeSecurity();
    const store = createKeychainSecretStore(exec);
    const secret = ' lead "quoted" back\\slash  trail ';
    await store.set(KEY, secret);
    expect(await store.get(KEY)).toBe(secret);
  });

  it("改行を含む値は保存せず、security を呼ばない", async () => {
    const { exec, calls } = fakeSecurity();
    const store = createKeychainSecretStore(exec);
    await expect(store.set(KEY, "line1\nline2 long enough")).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("保存の後に読み戻して一致しなければ失敗にする（security -i は失敗を終了コードで返さないことがある）", async () => {
    const exec: SecurityExec = async (args) =>
      args[0] === "find-generic-password"
        ? { code: 0, stdout: "other\n" }
        : { code: 0, stdout: "" };
    const store = createKeychainSecretStore(exec);
    await expect(store.set(KEY, "a-long-enough-secret")).rejects.toThrow();
  });

  it("見つからない（終了コード 44）なら undefined、他の失敗は例外（値は含めない）", async () => {
    const missing = createKeychainSecretStore(async () => ({ code: 44, stdout: "" }));
    expect(await missing.get(KEY)).toBeUndefined();
    await expect(missing.delete(KEY)).resolves.toBeUndefined();
    const broken = createKeychainSecretStore(async () => ({ code: 1, stdout: "secret-out" }));
    await expect(broken.get(KEY)).rejects.toThrow(/keychain/);
    const message = await broken.get(KEY).then(
      () => "",
      (e: unknown) => String(e),
    );
    expect(message).not.toContain("secret-out");
  });

  it("キーに使えない文字（空白など）は拒否する", async () => {
    const { exec, calls } = fakeSecurity();
    const store = createKeychainSecretStore(exec);
    await expect(store.get("bad key")).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("createMemorySecretStore", () => {
  it("get・set・delete の往復", async () => {
    const store = createMemorySecretStore();
    expect(await store.get(KEY)).toBeUndefined();
    await store.set(KEY, "value");
    expect(await store.get(KEY)).toBe("value");
    await store.delete(KEY);
    expect(await store.get(KEY)).toBeUndefined();
  });
});
