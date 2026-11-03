import type { JournalDraft } from "@trebuchet/schema";
import type { JournalDraftStore, SavedJournalDraft } from "../../src/ports.ts";

export class InMemoryJournalDraftStore implements JournalDraftStore {
  private value: SavedJournalDraft = { draft: null, updatedAt: null };
  get(): SavedJournalDraft {
    return structuredClone(this.value);
  }
  replace(draft: JournalDraft, updatedAt: string): void {
    this.value = { draft: structuredClone(draft), updatedAt };
  }
  delete(): void {
    this.value = { draft: null, updatedAt: null };
  }
}
