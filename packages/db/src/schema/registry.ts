import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** data/registry.sqlite。事業体の一覧のみ（帳簿データは持たない） */
export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["individual", "corporation"] }).notNull(),
    dbFile: text("db_file").notNull().unique(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [check("entities_kind", sql`${t.kind} IN ('individual', 'corporation')`)],
);
