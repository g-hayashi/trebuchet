import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAll, openAuth, openRegistry } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let registry: ReturnType<typeof openRegistry>;
let auth: ReturnType<typeof openAuth>;
beforeEach(() => {
  tmp = useTempDataDir("registry-auth-schema");
  registry = openRegistry();
  auth = openAuth();
});
afterEach(() => {
  closeAll();
  tmp.cleanup();
});

/** 008 の D2: 認証の表は auth.sqlite、端末の設定とバックアップの記録は registry */
const AUTH_TABLES = ["passkeys", "key_wraps", "sessions", "auth_events"];
const REGISTRY_TABLES = [
  "entities",
  "app_settings",
  "backup_runs",
  "pairing_tokens",
  "ai_settings",
];

const NOW = "2026-10-20T09:00:00.000Z";
const runOn =
  (db: { $client: { prepare(s: string): { run(...p: unknown[]): unknown } } }) =>
  (sqlText: string, ...params: unknown[]) =>
    db.$client.prepare(sqlText).run(...params);
const runAuth = (sqlText: string, ...params: unknown[]) => runOn(auth)(sqlText, ...params);
const runRegistry = (sqlText: string, ...params: unknown[]) => runOn(registry)(sqlText, ...params);

const tables = (db: { $client: { prepare(s: string): { all(): unknown[] } } }) =>
  db.$client
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
    )
    .all() as { name: string; sql: string }[];

const insertPasskey = (
  over: { id?: string; counter?: number; name?: string; prfSalt?: Buffer } = {},
) =>
  runAuth(
    "INSERT INTO passkeys (id, public_key, counter, rp_id, transports, name, prf_salt, created_at, last_used_at) VALUES (?, ?, ?, 'localhost', NULL, ?, ?, ?, NULL)",
    over.id ?? "pk1",
    Buffer.from([1, 2, 3]),
    over.counter ?? 0,
    over.name ?? "MacBook",
    over.prfSalt ?? Buffer.alloc(32, 1),
    NOW,
  );
const insertWrap = (
  id: string,
  kind: string,
  credentialId: string | null,
  over: { salt?: Buffer; iv?: Buffer; tag?: Buffer; wrapped?: Buffer } = {},
) =>
  runAuth(
    "INSERT INTO key_wraps (id, kind, credential_id, salt, iv, tag, wrapped, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    kind,
    credentialId,
    over.salt ?? Buffer.alloc(32, 2),
    over.iv ?? Buffer.alloc(12, 3),
    over.tag ?? Buffer.alloc(16, 4),
    over.wrapped ?? Buffer.alloc(32, 5),
    NOW,
  );
const countWraps = () =>
  (auth.$client.prepare("SELECT count(*) AS n FROM key_wraps").get() as { n: number }).n;
const insertSession = (id: string, tokenHash: string, kind = "normal") =>
  runAuth(
    "INSERT INTO sessions (id, token_hash, kind, rp_id, passkey_id, user_agent, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, 'localhost', NULL, NULL, ?, ?, NULL)",
    id,
    tokenHash,
    kind,
    NOW,
    NOW,
  );
const insertEvent = (id: string, kind: string) =>
  runAuth(
    "INSERT INTO auth_events (id, occurred_at, kind, rp_id, passkey_id, session_id, user_agent, detail) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    id,
    NOW,
    kind,
  );
const insertSetting = (key: string) =>
  runRegistry("INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'v', ?)", key, NOW);
const insertRun = (id: string, trigger: string, status: string) =>
  runRegistry(
    "INSERT INTO backup_runs (id, started_at, finished_at, trigger, status, error_code, file_name, size_bytes, content_sha256, summary) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    id,
    NOW,
    NOW,
    trigger,
    status,
  );
const insertPairing = (id: string, tokenHash: string) =>
  runRegistry(
    "INSERT INTO pairing_tokens (id, token_hash, rp_id, created_at, expires_at, used_at) VALUES (?, ?, 'a.b.ts.net', ?, ?, NULL)",
    id,
    tokenHash,
    NOW,
    NOW,
  );

describe("表の置き場所（008 の D2）", () => {
  it("auth.sqlite は認証の 4 表だけ、registry は認証の表を持たない。すべて STRICT", () => {
    const authTables = tables(auth);
    expect(authTables.map((t) => t.name).sort()).toEqual([...AUTH_TABLES].sort());
    const registryTables = tables(registry);
    expect(registryTables.map((t) => t.name).sort()).toEqual([...REGISTRY_TABLES].sort());
    for (const t of [...authTables, ...registryTables])
      expect(t.sql, t.name).toMatch(/\)\s*STRICT$/);
  });

  it("recovery_codes はどちらにもない", () => {
    expect(tables(auth).map((t) => t.name)).not.toContain("recovery_codes");
    expect(tables(registry).map((t) => t.name)).not.toContain("recovery_codes");
  });

  it("auth.sqlite は外部キーを有効にして開く", () => {
    expect(auth.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(auth.$client.pragma("journal_mode", { simple: true })).toBe("wal");
  });
});

describe("key_wraps の制約（INV-53）", () => {
  it("passkey の包みは credential_id が必須、recovery の包みは credential_id を持たない", () => {
    insertPasskey();
    insertWrap("w1", "passkey", "pk1");
    insertWrap("w2", "recovery", null);
    expect(() => insertWrap("w3", "passkey", null)).toThrow(/CHECK/);
    expect(() => insertWrap("w4", "recovery", "pk1")).toThrow(/CHECK/);
    expect(() => insertWrap("w5", "other", null)).toThrow(/CHECK/);
    expect(countWraps()).toBe(2);
  });

  it("recovery の包みは 1 行だけ", () => {
    insertWrap("r1", "recovery", null);
    expect(() => insertWrap("r2", "recovery", null)).toThrow(/UNIQUE/);
    runAuth("DELETE FROM key_wraps WHERE id = 'r1'");
    insertWrap("r2", "recovery", null);
    expect(countWraps()).toBe(1);
  });

  it("passkey の包みはパスキーごとに 1 行で、存在しないパスキーには付けられない", () => {
    insertPasskey({ id: "pk1" });
    insertPasskey({ id: "pk2" });
    insertWrap("a", "passkey", "pk1");
    expect(() => insertWrap("b", "passkey", "pk1")).toThrow(/UNIQUE/);
    insertWrap("c", "passkey", "pk2");
    expect(() => insertWrap("d", "passkey", "none")).toThrow(/FOREIGN KEY/);
  });

  it("パスキーを消すと、その包みも消える（ON DELETE CASCADE）", () => {
    insertPasskey({ id: "pk1" });
    insertPasskey({ id: "pk2" });
    insertWrap("a", "passkey", "pk1");
    insertWrap("b", "passkey", "pk2");
    insertWrap("r", "recovery", null);
    runAuth("DELETE FROM passkeys WHERE id = 'pk1'");
    const ids = (
      auth.$client.prepare("SELECT id FROM key_wraps ORDER BY id").all() as { id: string }[]
    ).map((r) => r.id);
    expect(ids).toEqual(["b", "r"]);
  });

  it("salt 32・iv 12・tag 16・wrapped 32 バイト", () => {
    insertWrap("ok", "recovery", null);
    runAuth("DELETE FROM key_wraps");
    expect(() => insertWrap("s", "recovery", null, { salt: Buffer.alloc(16) })).toThrow(/CHECK/);
    expect(() => insertWrap("i", "recovery", null, { iv: Buffer.alloc(16) })).toThrow(/CHECK/);
    expect(() => insertWrap("t", "recovery", null, { tag: Buffer.alloc(12) })).toThrow(/CHECK/);
    expect(() => insertWrap("w", "recovery", null, { wrapped: Buffer.alloc(48) })).toThrow(/CHECK/);
  });
});

describe("auth.sqlite の CHECK・トリガー", () => {
  it("auth_events は追記のみ（更新・削除はトリガーで失敗）", () => {
    insertEvent("e1", "register");
    expect(() => runAuth("UPDATE auth_events SET detail = 'x' WHERE id = 'e1'")).toThrow(
      /append-only/,
    );
    expect(() => runAuth("DELETE FROM auth_events WHERE id = 'e1'")).toThrow(/append-only/);
  });

  it("auth_events.kind は 13 種だけ", () => {
    const kinds = [
      "register",
      "sign_in",
      "sign_in_failed",
      "recovery_used",
      "recovery_failed",
      "recovery_regenerated",
      "passkey_renamed",
      "passkey_deleted",
      "session_revoked",
      "sign_out",
      "pairing_issued",
      "pairing_used",
      "remote_settings_changed",
    ];
    kinds.forEach((k, i) => {
      insertEvent(`e${i}`, k);
    });
    expect(() => insertEvent("bad", "unknown")).toThrow(/CHECK/);
  });

  it("sessions.kind は normal / recovery、token_hash は一意", () => {
    insertSession("s1", "h1", "normal");
    insertSession("s2", "h2", "recovery");
    expect(() => insertSession("s3", "h3", "admin")).toThrow(/CHECK/);
    expect(() => insertSession("s4", "h1")).toThrow(/UNIQUE/);
  });

  it("passkeys: counter >= 0、name は空でない、prf_salt は 32 バイトで必須", () => {
    insertPasskey({ id: "ok", counter: 0 });
    expect(() => insertPasskey({ id: "neg", counter: -1 })).toThrow(/CHECK/);
    expect(() => insertPasskey({ id: "blank", name: "" })).toThrow(/CHECK/);
    expect(() => insertPasskey({ id: "salt", prfSalt: Buffer.alloc(16) })).toThrow(/CHECK/);
    expect(() =>
      runAuth(
        "INSERT INTO passkeys (id, public_key, counter, rp_id, name, created_at) VALUES ('nosalt', x'01', 0, 'localhost', 'x', ?)",
        NOW,
      ),
    ).toThrow(/NOT NULL/);
  });
});

describe("registry の CHECK・UNIQUE", () => {
  it("app_settings.key は 7 種だけ", () => {
    for (const k of [
      "mac_id",
      "remote_enabled",
      "remote_host",
      "backup_folder",
      "backup_passphrase_set",
      "backup_force_write",
      "recovery_code_acknowledged",
    ])
      insertSetting(k);
    expect(() => insertSetting("other")).toThrow(/CHECK/);
  });

  it("backup_runs.trigger は manual / auto、status は succeeded / skipped / failed", () => {
    insertRun("r1", "manual", "succeeded");
    insertRun("r2", "auto", "skipped");
    insertRun("r3", "auto", "failed");
    expect(() => insertRun("r4", "pre_restore", "succeeded")).toThrow(/CHECK/);
    expect(() => insertRun("r5", "manual", "running")).toThrow(/CHECK/);
  });

  it("pairing_tokens.token_hash の重複は失敗", () => {
    insertPairing("p1", "dup");
    expect(() => insertPairing("p2", "dup")).toThrow(/UNIQUE/);
  });
});
