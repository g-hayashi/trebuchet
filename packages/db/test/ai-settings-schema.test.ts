import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAll, openRegistry } from "../src/tenant-store.ts";
import { NOW, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 006 の data-model §2.1（registry の ai_settings）、research R12

let tmp: TempDataDir;
let db: ReturnType<typeof openRegistry>;
beforeEach(() => {
  tmp = useTempDataDir("ai-settings-schema");
  db = openRegistry();
});
afterEach(() => {
  closeAll();
  tmp.cleanup();
});

type Row = Record<string, unknown>;

const row = (over: Row = {}): Row => ({
  id: 1,
  local_enabled: 1,
  external_enabled: 0,
  external_base_url: null,
  external_model: null,
  updated_at: NOW,
  ...over,
});

function insert(r: Row): void {
  const cols = Object.keys(r);
  db.$client
    .prepare(
      `INSERT INTO ai_settings (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(r));
}

describe("ai_settings（registry）", () => {
  it("STRICT の表で、API キーの列を持たない", () => {
    const t = db.$client
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'ai_settings'")
      .get() as { sql: string } | undefined;
    expect(t?.sql).toMatch(/\)\s*STRICT$/);
    const cols = (db.$client.prepare("PRAGMA table_info(ai_settings)").all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(
      [
        "external_base_url",
        "external_enabled",
        "external_model",
        "id",
        "local_enabled",
        "receipt_images_enabled",
        "updated_at",
      ].sort(),
    );
  });

  it("receipt_images_enabled（010 R15）: 既定 0、0・1 だけ、1 にできるのは external_enabled = 1 のときだけ", () => {
    insert(row());
    const stored = db.$client.prepare("SELECT receipt_images_enabled AS v FROM ai_settings").get();
    expect(stored).toEqual({ v: 0 });
    const external = {
      external_enabled: 1,
      external_base_url: "https://x/v1",
      external_model: "m",
    };
    db.$client.prepare("DELETE FROM ai_settings").run();
    expect(() => insert(row({ receipt_images_enabled: 2, ...external }))).toThrow(/CHECK/);
    expect(() => insert(row({ receipt_images_enabled: -1, ...external }))).toThrow(/CHECK/);
    expect(() => insert(row({ receipt_images_enabled: 1, external_enabled: 0 }))).toThrow(/CHECK/);
    expect(() => insert(row({ receipt_images_enabled: 1, ...external }))).not.toThrow();
  });

  it("local_enabled の列の既定は 0（端末内の AI は非推奨で既定は無効）", () => {
    db.$client.prepare("INSERT INTO ai_settings (id, updated_at) VALUES (1, ?)").run(NOW);
    expect(db.$client.prepare("SELECT local_enabled AS v FROM ai_settings").get()).toEqual({
      v: 0,
    });
  });

  it("1 行だけ（id = 1）。真偽値は 0・1", () => {
    expect(() => insert(row({ id: 2 }))).toThrow(/CHECK/);
    expect(() => insert(row({ local_enabled: 2 }))).toThrow(/CHECK/);
    expect(() => insert(row({ external_enabled: -1 }))).toThrow(/CHECK/);
    expect(() => insert(row())).not.toThrow();
    expect(() => insert(row())).toThrow(/UNIQUE|PRIMARY/);
  });

  it("external_enabled = 1 なら接続先とモデルが必須", () => {
    expect(() => insert(row({ external_enabled: 1 }))).toThrow(/CHECK/);
    expect(() => insert(row({ external_enabled: 1, external_base_url: "https://x/v1" }))).toThrow(
      /CHECK/,
    );
    expect(() => insert(row({ external_enabled: 1, external_model: "m" }))).toThrow(/CHECK/);
    expect(() =>
      insert(row({ external_enabled: 1, external_base_url: "https://x/v1", external_model: "m" })),
    ).not.toThrow();
  });
});
