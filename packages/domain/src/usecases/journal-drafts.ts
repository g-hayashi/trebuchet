import type { JournalDraft } from "@trebuchet/schema";
import type { Clock, JournalDraftStore } from "../ports.ts";
import { ok } from "../types.ts";

export type JournalDraftDeps = { store: JournalDraftStore; clock: Clock };

/** 完成した仕訳への変換・検証・監査の書き込みは行わない（INV-69）。 */
export function getJournalDraft(deps: Pick<JournalDraftDeps, "store">) {
  return ok(deps.store.get());
}

export function replaceJournalDraft(deps: JournalDraftDeps, draft: JournalDraft) {
  const updatedAt = deps.clock.now();
  deps.store.replace(draft, updatedAt);
  return ok({ updatedAt });
}

export function deleteJournalDraft(deps: Pick<JournalDraftDeps, "store">) {
  deps.store.delete();
  return ok(undefined);
}
