import type { JournalDraftStore, SavedJournalDraft } from "@trebuchet/domain";
import { JournalDraft } from "@trebuchet/schema";
import { eq } from "drizzle-orm";
import type { TenantConn } from "./internal.ts";
import { journalDrafts } from "./schema/tenant.ts";

export class DrizzleJournalDraftStore implements JournalDraftStore {
  private readonly db: TenantConn;
  constructor(db: TenantConn) {
    this.db = db;
  }

  get(): SavedJournalDraft {
    const row = this.db.select().from(journalDrafts).where(eq(journalDrafts.id, 1)).get();
    return row === undefined
      ? { draft: null, updatedAt: null }
      : { draft: JournalDraft.parse(JSON.parse(row.payload)), updatedAt: row.updatedAt };
  }

  replace(draft: JournalDraft, updatedAt: string): void {
    const values = { id: 1, payload: JSON.stringify(draft), updatedAt };
    this.db
      .insert(journalDrafts)
      .values(values)
      .onConflictDoUpdate({
        target: journalDrafts.id,
        set: { payload: values.payload, updatedAt },
      })
      .run();
  }

  delete(): void {
    this.db.delete(journalDrafts).where(eq(journalDrafts.id, 1)).run();
  }
}
