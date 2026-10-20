import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAll, openRegistry } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let db: ReturnType<typeof openRegistry>;
beforeEach(() => {
  tmp = useTempDataDir("registry-auth-schema");
  db = openRegistry();
});
afterEach(() => {
  closeAll();
  tmp.cleanup();
});

const NEW_TABLES = [
  "passkeys",
  "recovery_codes",
  "sessions",
  "auth_events",
  "app_settings",
  "backup_runs",
  "pairing_tokens",
];

const NOW = "2026-10-20T09:00:00.000Z";
const run = (sqlText: string, ...params: unknown[]) => db.$client.prepare(sqlText).run(...params);

const insertPasskey = (over: { id?: string; counter?: number; name?: string } = {}) =>
  run(
    "INSERT INTO passkeys (id, public_key, counter, rp_id, transports, name, created_at, last_used_at) VALUES (?, ?, ?, 'localhost', NULL, ?, ?, NULL)",
    over.id ?? "pk1",
    Buffer.from([1, 2, 3]),
    over.counter ?? 0,
    over.name ?? "MacBook",
    NOW,
  );
const insertSession = (id: string, tokenHash: string, kind = "normal") =>
  run(
    "INSERT INTO sessions (id, token_hash, kind, rp_id, passkey_id, user_agent, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, 'localhost', NULL, NULL, ?, ?, NULL)",
    id,
    tokenHash,
    kind,
    NOW,
    NOW,
  );
const insertEvent = (id: string, kind: string) =>
  run(
    "INSERT INTO auth_events (id, occurred_at, kind, rp_id, passkey_id, session_id, user_agent, detail) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    id,
    NOW,
    kind,
  );
const insertCode = (id: string, usedAt: string | null = null, revokedAt: string | null = null) =>
  run(
    "INSERT INTO recovery_codes (id, code_hash, created_at, used_at, revoked_at) VALUES (?, 'h', ?, ?, ?)",
    id,
    NOW,
    usedAt,
    revokedAt,
  );
const insertSetting = (key: string) =>
  run("INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'v', ?)", key, NOW);
const insertRun = (id: string, trigger: string, status: string) =>
  run(
    "INSERT INTO backup_runs (id, started_at, finished_at, trigger, status, error_code, file_name, size_bytes, content_sha256, summary) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    id,
    NOW,
    NOW,
    trigger,
    status,
  );
const insertPairing = (id: string, tokenHash: string) =>
  run(
    "INSERT INTO pairing_tokens (id, token_hash, rp_id, created_at, expires_at, used_at) VALUES (?, ?, 'a.b.ts.net', ?, ?, NULL)",
    id,
    tokenHash,
    NOW,
    NOW,
  );

describe("registry の認証・バックアップの表（T004）", () => {
  it("7表がすべて STRICT で、既存の entities も残る", () => {
    const rows = db.$client
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'")
      .all() as { name: string; sql: string }[];
    expect(rows.map((r) => r.name)).toContain("entities");
    for (const name of NEW_TABLES) {
      const row = rows.find((r) => r.name === name);
      expect(row, name).toBeDefined();
      expect(row?.sql, name).toMatch(/\)\s*STRICT$/);
    }
  });

  it("auth_events は追記のみ（更新・削除はトリガーで失敗）", () => {
    insertEvent("e1", "register");
    expect(() => run("UPDATE auth_events SET detail = 'x' WHERE id = 'e1'")).toThrow(/append-only/);
    expect(() => run("DELETE FROM auth_events WHERE id = 'e1'")).toThrow(/append-only/);
  });

  it("有効な回復コードは高々1つ。閉じれば次を入れられる", () => {
    insertCode("c1");
    expect(() => insertCode("c2")).toThrow(/UNIQUE/);
    run("UPDATE recovery_codes SET used_at = ? WHERE id = 'c1'", NOW);
    insertCode("c2");
    run("UPDATE recovery_codes SET revoked_at = ? WHERE id = 'c2'", NOW);
    insertCode("c3");
    // 閉じた行は何行あってもよい
    insertCode("c4", NOW, null);
    insertCode("c5", null, NOW);
    expect(db.$client.prepare("SELECT COUNT(*) AS n FROM recovery_codes").get()).toEqual({ n: 5 });
  });

  describe("CHECK", () => {
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

    it("sessions.kind は normal / recovery", () => {
      insertSession("s1", "h1", "normal");
      insertSession("s2", "h2", "recovery");
      expect(() => insertSession("s3", "h3", "admin")).toThrow(/CHECK/);
    });

    it("passkeys: counter >= 0、name は空でない", () => {
      insertPasskey({ id: "ok", counter: 0 });
      expect(() => insertPasskey({ id: "neg", counter: -1 })).toThrow(/CHECK/);
      expect(() => insertPasskey({ id: "blank", name: "" })).toThrow(/CHECK/);
    });
  });

  describe("UNIQUE", () => {
    it("sessions.token_hash の重複は失敗", () => {
      insertSession("s1", "dup");
      expect(() => insertSession("s2", "dup")).toThrow(/UNIQUE/);
    });

    it("pairing_tokens.token_hash の重複は失敗", () => {
      insertPairing("p1", "dup");
      expect(() => insertPairing("p2", "dup")).toThrow(/UNIQUE/);
    });
  });
});
