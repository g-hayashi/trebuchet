import { randomUUIDv7 } from "node:crypto";
import {
  DrizzleLedgerRepository,
  DrizzleMasterRepository,
  DrizzleRegistryRepository,
  openRegistry,
  type TenantDb,
} from "@trebuchet/db";
import type { Clock, IdGenerator, JournalDeps, MasterDeps } from "@trebuchet/domain";

/** R8: 主キーは UUIDv7 */
export const ids: IdGenerator = { next: () => randomUUIDv7() };

export const clock: Clock = { now: () => new Date().toISOString() };

export const registryRepository = () => new DrizzleRegistryRepository(openRegistry());

/** リクエストの事業体の DB（c.var.db）に対するマスタのユースケースの依存 */
export function masterDeps(db: TenantDb): MasterDeps {
  return { repo: new DrizzleMasterRepository(db), ids, clock };
}

/** リクエストの事業体の DB に対する仕訳のユースケースの依存 */
export function journalDeps(db: TenantDb): JournalDeps {
  return {
    ledger: new DrizzleLedgerRepository(db),
    masters: new DrizzleMasterRepository(db),
    ids,
    clock,
  };
}
