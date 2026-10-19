import { randomUUIDv7 } from "node:crypto";
import {
  DrizzleLedgerRepository,
  DrizzleMasterRepository,
  DrizzleRegistryRepository,
  openRegistry,
  type TenantDb,
} from "@trebuchet/db";
import type { Clock, IdGenerator, LedgerDeps, MasterDeps, ReportDeps } from "@trebuchet/domain";

/** R8: 主キーは UUIDv7 */
export const ids: IdGenerator = { next: () => randomUUIDv7() };

export const clock: Clock = { now: () => new Date().toISOString() };

export const registryRepository = () => new DrizzleRegistryRepository(openRegistry());

/** リクエストの事業体の DB（c.var.db）に対するマスタのユースケースの依存 */
export function masterDeps(db: TenantDb): MasterDeps {
  return { repo: new DrizzleMasterRepository(db), ids, clock };
}

/** リクエストの事業体の DB に対する仕訳のユースケース（登録・訂正・取消・参照）の依存 */
export function journalDeps(db: TenantDb): LedgerDeps {
  return {
    ledger: new DrizzleLedgerRepository(db),
    masters: new DrizzleMasterRepository(db),
    ids,
    clock,
  };
}

/** リクエストの事業体の DB に対する帳票のユースケースの依存 */
export function reportDeps(db: TenantDb): ReportDeps {
  return { masters: new DrizzleMasterRepository(db), reports: new DrizzleLedgerRepository(db) };
}
