import type { StatementStatus } from "@trebuchet/schema";
import type { Journal } from "../types.ts";

/**
 * 明細の状態（006 R15、INV-44）。保存せず、結びつき・除外・仕訳の状態から導く。
 * - 有効な結びつきの仕訳が有効、または訂正（`correctsJournalId`）をたどった先に有効な仕訳がある → `registered`
 * - ほか、除外している → `excluded`
 * - ほか → `unprocessed`
 *
 * `journals` は結びつきの仕訳とその訂正の連鎖を含む仕訳の集まり（並びは問わない）
 */
export function statementStatus(
  statement: { excludedAt: string | null },
  links: readonly { journalId: string; revokedAt: string | null }[],
  journals: readonly Pick<Journal, "id" | "status" | "correctsJournalId">[],
): StatementStatus {
  const byId = new Map(journals.map((j) => [j.id, j]));
  const correctedBy = new Map<string, string[]>();
  for (const j of journals) {
    if (j.correctsJournalId === null) continue;
    const list = correctedBy.get(j.correctsJournalId) ?? [];
    list.push(j.id);
    correctedBy.set(j.correctsJournalId, list);
  }

  const hasActiveInChain = (startId: string): boolean => {
    const visited = new Set<string>();
    const queue = [startId];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (visited.has(id)) continue;
      visited.add(id);
      if (byId.get(id)?.status === "active") return true;
      queue.push(...(correctedBy.get(id) ?? []));
    }
    return false;
  };

  const registered = links.some((l) => l.revokedAt === null && hasActiveInChain(l.journalId));
  if (registered) return "registered";
  return statement.excludedAt === null ? "unprocessed" : "excluded";
}
