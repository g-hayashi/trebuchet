import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DRIZZLE = fileURLToPath(new URL("../drizzle", import.meta.url));

export type MigrationKind = "registry" | "tenant" | "auth";

type JournalEntry = {
  idx: number;
  when: number;
  tag: string;
  version: string;
  breakpoints: boolean;
};

function readJournal(kind: MigrationKind): { entries: JournalEntry[] } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(DRIZZLE, kind, "meta", "_journal.json"), "utf8"));
}

/** 今のマイグレーションの件数 */
export function migrationCount(kind: MigrationKind): number {
  return readJournal(kind).entries.length;
}

/**
 * 今のマイグレーションの先頭 count 件だけのフォルダを `dir`（`.tmp/` の下）に作る（古い版の再現）。
 * extra を渡すと、その後ろに 1 件を足す（途中で失敗するマイグレーションの差し込み）
 */
export function migrationsUpTo(
  dir: string,
  kind: MigrationKind,
  count: number,
  extra?: { tag: string; sql: string },
): string {
  const out = join(dir, "migrations", `${kind}-${count}-${extra?.tag ?? "plain"}`);
  mkdirSync(join(out, "meta"), { recursive: true });
  const journal = readJournal(kind);
  const entries = journal.entries.slice(0, count);
  if (entries.length !== count) throw new Error(`${kind} のマイグレーションは ${count} 件もない`);
  for (const e of entries) {
    copyFileSync(join(DRIZZLE, kind, `${e.tag}.sql`), join(out, `${e.tag}.sql`));
  }
  if (extra !== undefined) {
    const last = entries[entries.length - 1];
    entries.push({
      idx: entries.length,
      when: (last?.when ?? 0) + 1000,
      tag: extra.tag,
      version: "6",
      breakpoints: true,
    });
    writeFileSync(join(out, `${extra.tag}.sql`), extra.sql);
  }
  writeFileSync(join(out, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return out;
}
