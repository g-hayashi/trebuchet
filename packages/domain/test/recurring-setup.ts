import type { RecurringInput } from "@trebuchet/schema";
import { fakeRecurringUnitOfWork, InMemoryRecurringStore } from "./fakes.ts";
import { setupBase } from "./ledger-setup.ts";

/**
 * 定期仕訳（005 US3）のドメインのテストの準備: `setupBase` の会計期間（2025・2026 年度、open）に、
 * RecurringUnitOfWork と取引先 2 件（使用中・使用停止）を足す。税設定は 2025-01-01 から課税事業者（税込経理）
 */
export function setupRecurring(options: { taxable?: boolean } = {}) {
  const t = setupBase({ taxable: options.taxable ?? true });
  const recurring = new InMemoryRecurringStore();
  const uow = fakeRecurringUnitOfWork(t.ledger, t.masters, recurring);
  const deps = { uow, ids: t.ids, clock: t.clock };
  const partner = t.addPartner();
  const inactivePartner = t.addPartner({ isActive: false });

  /** 毎月 25 日・開始 2026-08・借方 地代家賃 / 貸方 普通預金 80,000 円の入力 */
  const input = (over: Partial<RecurringInput> = {}): RecurringInput => ({
    name: "家賃",
    memo: "事務所の家賃",
    dayOfMonth: 25,
    startMonth: "2026-08",
    lines: [
      {
        side: "debit",
        accountId: t.accountId("地代家賃"),
        amount: 80_000,
        partnerId: partner.id,
      },
      { side: "credit", accountId: t.accountId("普通預金"), amount: 80_000 },
    ],
    ...over,
  });
  const journalsOf = () => t.ledger.state.journals;
  return { ...t, recurring, uow, deps, partner, inactivePartner, input, journalsOf };
}
