import fc from "fast-check";
import { addDays, daysBetween } from "../src/dates.ts";
import { INDIVIDUAL_ACCOUNTS } from "../src/seed/accounts.individual.ts";
import type {
  Account,
  DeferredAmortization,
  DeferredAsset,
  FiscalPeriod,
  FixedAsset,
  HomeUseAllocation,
  JournalDraft,
  LineDraft,
  OpeningBalance,
  Partner,
  PostedLine,
} from "../src/types.ts";
import { amountArb, dateInPeriodArb, makeFiscalPeriod } from "./arbitraries.ts";

/**
 * 青色申告決算書（003）のプロパティテスト用のジェネレーター。
 * 個人の初期セットの科目で、1年分（2025 年）の帳簿を作る。
 * 返す値は buildBlueReturn（決算書）と 001 の buildProfitAndLoss・buildBalanceSheet にそのまま渡せる形。
 */

export const LEDGER_YEAR = 2025;

/** 初期セットの科目コードから決まる科目 ID（生成のたびに同じ ID になる。homeUseArb と揃う） */
export const accountIdOf = (code: string) => `0000000a-0000-7000-8000-${code.padStart(12, "0")}`;

/** 個人の初期セットの科目（ID は accountIdOf(code)） */
export const INDIVIDUAL_ACCOUNT_LIST: readonly Account[] = INDIVIDUAL_ACCOUNTS.map((a) => ({
  ...a,
  id: accountIdOf(a.code),
  isSystem: false,
  isActive: true,
}));

const ACCOUNT_NAMES = new Map(INDIVIDUAL_ACCOUNT_LIST.map((a) => [a.id, a.name]));

const CODE = {
  cash: "1010",
  bank: "1020",
  receivable: "1030",
  equipment: "1060",
  loan: "2010",
  unpaid: "2020",
  deposit: "2050",
  drawings: "3090",
  contribution: "3010",
  capital: "3020",
  sales: "4010",
  misc: "4020",
} as const;

const EXPENSE_CODES = INDIVIDUAL_ACCOUNTS.filter((a) => a.category === "expense").map(
  (a) => a.code,
);

const id = (code: string) => accountIdOf(code);

const syntheticPartnerId = (n: number) =>
  `0000000c-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** 取引先（1〜4 件） */
const partnersArb: fc.Arbitrary<Partner[]> = fc.integer({ min: 1, max: 4 }).map((count) =>
  Array.from({ length: count }, (_, i) => ({
    id: syntheticPartnerId(i + 1),
    name: `取引先${i + 1}`,
    honorific: i % 2 === 0 ? ("御中" as const) : null,
    memo: null,
    isActive: true,
  })),
);

const line = (side: "debit" | "credit", code: string, amount: number, partnerId?: string) =>
  ({
    side,
    accountId: id(code),
    amount,
    ...(partnerId === undefined ? {} : { partnerId }),
  }) satisfies LineDraft;

type Form = "business_account" | "owner_only";

/**
 * 期首残高（貸借一致、科目は重複しない）。
 * 資産（現金・普通預金・売掛金・工具器具備品）と負債（借入金・未払金・預り金）の一部に、
 * 元入金で貸借を合わせる。事業用の口座を使わない形では普通預金を持たない
 */
function openingArb(
  form: Form,
): fc.Arbitrary<{ code: string; side: "debit" | "credit"; amount: number }[]> {
  const optional = fc.option(amountArb, { nil: undefined, freq: 2 });
  return fc
    .record({
      liabilities: fc.tuple(optional, optional, optional),
      assets: fc.tuple(optional, optional, optional),
      extra: amountArb,
      empty: fc.boolean(),
    })
    .map(({ liabilities, assets, extra, empty }) => {
      if (empty) return [];
      const [loan, unpaid, deposit] = liabilities;
      const [bank, receivable, equipment] = assets;
      const liabilityRows = [
        { code: CODE.loan, amount: loan },
        { code: CODE.unpaid, amount: unpaid },
        { code: CODE.deposit, amount: deposit },
      ];
      const assetRows = [
        { code: CODE.bank, amount: form === "business_account" ? bank : undefined },
        { code: CODE.receivable, amount: receivable },
        { code: CODE.equipment, amount: equipment },
      ];
      const sum = (rows: { amount: number | undefined }[]) =>
        rows.reduce((s, r) => s + (r.amount ?? 0), 0);
      const liabilityTotal = sum(liabilityRows);
      const otherAssets = sum(assetRows);
      // 現金 = 負債の合計 + extra、元入金 = extra + 他の資産の合計 → 借方 = 貸方
      const cash = liabilityTotal + extra;
      const capital = extra + otherAssets;
      return [
        { code: CODE.cash, side: "debit" as const, amount: cash },
        ...assetRows.flatMap((r) =>
          r.amount === undefined
            ? []
            : [{ code: r.code, side: "debit" as const, amount: r.amount }],
        ),
        ...liabilityRows.flatMap((r) =>
          r.amount === undefined
            ? []
            : [{ code: r.code, side: "credit" as const, amount: r.amount }],
        ),
        { code: CODE.capital, side: "credit" as const, amount: capital },
      ];
    });
}

/** 仕訳 1 件分の行。form に応じて、入出金を普通預金（と現金）か、事業主貸・事業主借で表す */
function linesArb(form: Form, partners: readonly Partner[]): fc.Arbitrary<LineDraft[]> {
  const partnerArb = fc.option(fc.constantFrom(...partners.map((p) => p.id)), { nil: undefined });
  const businessAccount = form === "business_account";
  // 入金の借方・出金の貸方になる科目
  const receiptCode: fc.Arbitrary<string> = businessAccount
    ? fc.constantFrom(CODE.bank, CODE.bank, CODE.cash)
    : fc.constantFrom(CODE.drawings, CODE.drawings, CODE.cash);
  const paymentCode: fc.Arbitrary<string> = businessAccount
    ? fc.constantFrom(CODE.bank, CODE.bank, CODE.cash)
    : fc.constantFrom(CODE.contribution, CODE.contribution, CODE.cash);
  // 事業主貸・事業主借の仕訳の相手（事業主貸の相手に事業主貸・事業主借を使わない）
  const ownerCounterCode: fc.Arbitrary<string> = businessAccount
    ? fc.constantFrom(CODE.bank, CODE.bank, CODE.cash)
    : fc.constant(CODE.cash);
  const expenseCode = fc.constantFrom(...EXPENSE_CODES);
  // 売上の借方は売掛金もあり得る
  const salesDebit = fc.oneof(receiptCode, fc.constant(CODE.receivable));

  const sales = fc
    .tuple(salesDebit, amountArb, partnerArb)
    .map(([debit, amount, partnerId]) => [
      line("debit", debit, amount, partnerId),
      line("credit", CODE.sales, amount, partnerId),
    ]);
  const miscIncome = fc
    .tuple(receiptCode, amountArb)
    .map(([debit, amount]) => [line("debit", debit, amount), line("credit", CODE.misc, amount)]);
  const expense = fc
    .tuple(paymentCode, fc.array(fc.tuple(expenseCode, amountArb), { minLength: 1, maxLength: 3 }))
    .map(([credit, items]) => [
      ...items.map(([code, amount]) => line("debit", code, amount)),
      line(
        "credit",
        credit,
        items.reduce((s, [, amount]) => s + amount, 0),
      ),
    ]);
  const drawings = fc
    .tuple(ownerCounterCode, amountArb)
    .map(([credit, amount]) => [
      line("debit", CODE.drawings, amount),
      line("credit", credit, amount),
    ]);
  const contribution = fc
    .tuple(ownerCounterCode, amountArb)
    .map(([debit, amount]) => [
      line("debit", debit, amount),
      line("credit", CODE.contribution, amount),
    ]);
  const collection = fc
    .tuple(receiptCode, amountArb, partnerArb)
    .map(([debit, amount, partnerId]) => [
      line("debit", debit, amount),
      line("credit", CODE.receivable, amount, partnerId),
    ]);

  return fc.oneof(
    { weight: 4, arbitrary: sales },
    { weight: 1, arbitrary: miscIncome },
    { weight: 5, arbitrary: expense },
    { weight: 1, arbitrary: drawings },
    { weight: 1, arbitrary: contribution },
    { weight: 1, arbitrary: collection },
  );
}

export type YearLedger = {
  /** 事業用の口座（普通預金）で入出金する帳簿か。false は事業主貸・事業主借で入出金する帳簿（FR-032） */
  usesBusinessAccount: boolean;
  /** 個人の初期セットの科目（全部） */
  accounts: Account[];
  partners: Partner[];
  /** 会計期間（2025-01-01〜2025-12-31） */
  period: FiscalPeriod;
  /** 期首残高（貸借一致。空のこともある） */
  opening: OpeningBalance[];
  /** 検証を通る仕訳の下書き（validateJournal に渡せる） */
  journals: JournalDraft[];
  /** journals の行（すべて active）。buildProfitAndLoss・buildBalanceSheet の lines に渡せる */
  lines: PostedLine[];
};

const period = makeFiscalPeriod(LEDGER_YEAR);

/** 1 年分の帳簿（個人の初期セットの科目、取引先、貸借一致の期首残高、期間内の仕訳） */
export const yearLedgerArb: fc.Arbitrary<YearLedger> = fc
  .record({
    form: fc.constantFrom<Form>("business_account", "owner_only"),
    partners: partnersArb,
  })
  .chain(({ form, partners }) =>
    fc.record({
      form: fc.constant(form),
      partners: fc.constant(partners),
      opening: openingArb(form),
      journals: fc.array(
        fc.record({ date: dateInPeriodArb(period), lines: linesArb(form, partners) }),
        { maxLength: 30 },
      ),
    }),
  )
  .map(({ form, partners, opening, journals }): YearLedger => {
    const partnerNames = new Map(partners.map((p) => [p.id, p.name]));
    const lines = journals.flatMap((j, index) =>
      j.lines.map(
        (l, i): PostedLine => ({
          journalId: `journal-${index + 1}`,
          journalNo: index + 1,
          date: j.date,
          memo: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "active",
          lineNo: i + 1,
          side: l.side,
          accountId: l.accountId,
          accountName: ACCOUNT_NAMES.get(l.accountId) ?? "",
          subAccountId: null,
          subAccountName: null,
          amount: l.amount,
          taxCategory: "OUT_OF_SCOPE",
          taxAmount: 0,
          partnerId: l.partnerId ?? null,
          partnerName: l.partnerId === undefined ? null : (partnerNames.get(l.partnerId) ?? null),
          description: null,
        }),
      ),
    );
    return {
      usesBusinessAccount: form === "business_account",
      accounts: [...INDIVIDUAL_ACCOUNT_LIST],
      partners,
      period,
      opening: opening.map((o, i) => ({
        id: `0000000e-0000-7000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
        fiscalPeriodId: period.id,
        accountId: id(o.code),
        subAccountId: null,
        side: o.side,
        amount: o.amount,
      })),
      journals,
      lines,
    };
  });

/**
 * 家事按分の登録（割合は 0〜10000 の万分率、両端を含む）。
 * 科目は初期セットの経費の科目（accountIdOf で yearLedgerArb の科目と一致する）
 */
export const homeUseArb: fc.Arbitrary<HomeUseAllocation> = fc.record({
  id: fc
    .integer({ min: 1, max: 0xffff })
    .map((n) => `00000010-0000-7000-8000-${n.toString(16).padStart(12, "0")}`),
  fiscalYear: fc.constant(LEDGER_YEAR),
  accountId: fc.constantFrom(...EXPENSE_CODES).map(accountIdOf),
  subAccountId: fc.constant(null),
  businessRatio: fc.oneof(
    { weight: 1, arbitrary: fc.constantFrom(0, 10000) },
    { weight: 4, arbitrary: fc.integer({ min: 0, max: 10000 }) },
  ),
  basis: fc.constantFrom("床面積で按分", "使用時間で按分", "通信量で按分"),
  changeReason: fc.option(fc.constantFrom("前年から変更", "在宅勤務の増加"), { nil: null }),
  createdAt: fc.constant("2026-01-10T00:00:00.000Z"),
  updatedAt: fc.constant("2026-01-10T00:00:00.000Z"),
});

// ---- 009: 定額法・一括償却資産・開業費（specs/009-depreciation-deferred、R15・R17/T008） ----

/** 定額法の償却率の表が始まる日（取得日の下限。R2） */
const ASSET_EPOCH = "2007-04-01";
const ASSET_LAST_ACQUIRED = "2035-12-31";
const ACQUIRED_DAYS = daysBetween(ASSET_EPOCH, ASSET_LAST_ACQUIRED);

const yearOfDate = (date: string) => Number(date.slice(0, 4));

const syntheticSeqId = (prefix: string, seq: number) =>
  `${prefix}-0000-7000-8000-${seq.toString(16).padStart(12, "0")}`;

const seqArb = fc.integer({ min: 1, max: 0xffff });

/** 取得日・開業日（2007-04-01〜2035-12-31。両端と年末・年始を含む） */
const acquiredOnArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc.constantFrom(ASSET_EPOCH, "2025-01-01", "2025-12-31", ASSET_LAST_ACQUIRED),
  },
  {
    weight: 4,
    arbitrary: fc.integer({ min: 0, max: ACQUIRED_DAYS }).map((n) => addDays(ASSET_EPOCH, n)),
  },
);

/** 事業専用割合（万分率。0 と 10000 を含む） */
const ratioArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(0, 10000) },
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 10000 }) },
);

/** 1〜max の金額。上限そのものを多めに出す */
const amountUpTo = (max: number): fc.Arbitrary<number> =>
  fc.oneof(
    { weight: 1, arbitrary: fc.constant(max) },
    { weight: 4, arbitrary: fc.integer({ min: 1, max }) },
  );

const NOW_ISO = "2026-01-10T00:00:00.000Z";

/**
 * 定額法・一括償却資産の共通の生成（data-model §1.3 の制約を満たす）。
 * - 供用日: なし、または取得日から 400 日以内（取得日以後。年をまたぐことがある）
 * - 累計: なし、または 1〜`priorCap(取得価額)`。累計の年は供用の年から 8 年後まで
 * - 除却: なし、または供用日（累計があれば累計の年の翌年 1 月 1 日）から 10 年以内。種類は廃棄・売却
 *   （除却の日が台帳の計算の開始年度より前になる資産は作らない）
 */
function assetArb(spec: {
  method: "straight_line" | "lump_sum";
  cost: fc.Arbitrary<number>;
  usefulLife: fc.Arbitrary<number | null>;
  priorCap: (cost: number) => number;
}): fc.Arbitrary<FixedAsset> {
  return fc
    .record({
      seq: seqArb,
      acquiredOn: acquiredOnArb,
      acquisitionCost: spec.cost,
      usefulLifeYears: spec.usefulLife,
      serviceDelay: fc.option(fc.integer({ min: 0, max: 400 }), { nil: undefined }),
      businessRatio: ratioArb,
      assetAccountId: fc.constantFrom("1060", "1070").map(accountIdOf),
      quantity: fc.option(fc.constantFrom("1", "2", "10"), { nil: null }),
      note: fc.option(fc.constantFrom("備考", "リース満了後に購入"), { nil: null }),
    })
    .chain((base) => {
      const inServiceOn =
        base.serviceDelay === undefined ? null : addDays(base.acquiredOn, base.serviceDelay);
      const serviceOn = inServiceOn ?? base.acquiredOn;
      const cap = spec.priorCap(base.acquisitionCost);
      const prior: fc.Arbitrary<{ amount: number; through: number } | null> =
        cap >= 1
          ? fc.option(
              fc
                .record({ amount: amountUpTo(cap), yearsAfter: fc.integer({ min: 0, max: 8 }) })
                .map(({ amount, yearsAfter }) => ({
                  amount,
                  through: yearOfDate(serviceOn) + yearsAfter,
                })),
              { nil: null, freq: 2 },
            )
          : fc.constant(null);
      return prior.chain((p) => {
        const floor =
          p === null || `${p.through + 1}-01-01` < serviceOn ? serviceOn : `${p.through + 1}-01-01`;
        return fc
          .option(
            fc.record({
              days: fc.integer({ min: 0, max: 3650 }),
              kind: fc.constantFrom<"scrap" | "sale">("scrap", "sale"),
            }),
            { nil: null },
          )
          .map(
            (disposal): FixedAsset => ({
              id: syntheticSeqId("00000011", base.seq),
              name: `資産${base.seq}`,
              quantity: base.quantity,
              acquiredOn: base.acquiredOn,
              acquisitionCost: base.acquisitionCost,
              method: spec.method,
              usefulLifeYears: base.usefulLifeYears,
              inServiceOn,
              priorAccumulated: p?.amount ?? 0,
              priorThroughYear: p?.through ?? null,
              businessRatio: base.businessRatio,
              assetAccountId: base.assetAccountId,
              linkedJournalId: null,
              note: base.note,
              disposedOn: disposal === null ? null : addDays(floor, disposal.days),
              disposalKind: disposal?.kind ?? null,
              createdAt: NOW_ISO,
              updatedAt: NOW_ISO,
            }),
          );
      });
    });
}

/**
 * 定額法の資産。取得日 2007-04-01 以後、供用日 ≥ 取得日、取得価額 1〜10^9、耐用年数 2〜50、
 * 割合 0〜10000、累計は取得価額 − 1 以下（取得価額 1 は累計なし）、除却の有無と種類
 */
export const straightLineAssetArb: fc.Arbitrary<FixedAsset> = assetArb({
  method: "straight_line",
  cost: fc.oneof(
    { weight: 1, arbitrary: fc.constantFrom(1, 2, 3, 1_000_000_000) },
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 1_000_000 }) },
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 1_000_000_000 }) },
  ),
  usefulLife: fc.oneof(
    { weight: 1, arbitrary: fc.constantFrom(2, 50) },
    { weight: 4, arbitrary: fc.integer({ min: 2, max: 50 }) },
  ),
  priorCap: (cost) => cost - 1,
});

/** 一括償却資産。取得価額 100,000〜199,999、耐用年数なし、累計は取得価額以下 */
export const lumpSumAssetArb: fc.Arbitrary<FixedAsset> = assetArb({
  method: "lump_sum",
  cost: fc.oneof(
    { weight: 1, arbitrary: fc.constantFrom(100_000, 199_999) },
    { weight: 4, arbitrary: fc.integer({ min: 100_000, max: 199_999 }) },
  ),
  usefulLife: fc.constant(null),
  priorCap: (cost) => cost,
});

/**
 * 開業費。総額 1〜10^9、開業日 2007-04-01〜2035-12-31、累計は 0〜総額（累計の年は開業の年から 8 年後まで）、
 * 勘定は 1080 開業費
 */
export const deferredAssetArb: fc.Arbitrary<DeferredAsset> = fc
  .record({
    seq: seqArb,
    totalAmount: fc.oneof(
      { weight: 1, arbitrary: fc.constantFrom(1, 60, 300_000, 1_000_000_000) },
      { weight: 4, arbitrary: fc.integer({ min: 1, max: 1_000_000_000 }) },
    ),
    openedOn: acquiredOnArb,
    note: fc.option(fc.constantFrom("開業準備の費用", "開業前の広告費"), { nil: null }),
  })
  .chain((base) =>
    fc
      .option(
        fc.record({
          amount: amountUpTo(base.totalAmount),
          yearsAfter: fc.integer({ min: 0, max: 8 }),
        }),
        { nil: null, freq: 2 },
      )
      .map(
        (p): DeferredAsset => ({
          id: syntheticSeqId("00000012", base.seq),
          name: `開業費${base.seq}`,
          totalAmount: base.totalAmount,
          openedOn: base.openedOn,
          priorAccumulated: p?.amount ?? 0,
          priorThroughYear: p === null ? null : yearOfDate(base.openedOn) + p.yearsAfter,
          accountId: accountIdOf("1080"),
          note: base.note,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        }),
      ),
  );

/**
 * 開業費の年度ごとの決定の列。年度は `startYear`（累計の年の翌年、なければ開業の年）から昇順で、
 * 決定のない年度（欠番）を含み得る（最大 8 年分、空もある）。額は 0〜（総額 − 累計）の整数で、
 * その年度の上限（期首の未償却残高）を超え得る。上限の検査（`validateDeferredDecision`、INV-58）は
 * 呼ぶ側のテストが行う
 */
export const deferredDecisionsArb = (
  asset: DeferredAsset,
): fc.Arbitrary<DeferredAmortization[]> => {
  const startYear = (asset.priorThroughYear ?? yearOfDate(asset.openedOn) - 1) + 1;
  const remaining = asset.totalAmount - asset.priorAccumulated;
  const amountArb: fc.Arbitrary<number> = fc.oneof(
    { weight: 1, arbitrary: fc.constant(0) },
    { weight: 1, arbitrary: fc.constant(remaining) },
    { weight: 3, arbitrary: fc.integer({ min: 0, max: remaining }) },
  );
  return fc.array(fc.option(amountArb, { nil: undefined }), { maxLength: 8 }).map((amounts) =>
    amounts.flatMap((amount, i) =>
      amount === undefined
        ? []
        : [
            {
              deferredAssetId: asset.id,
              fiscalYear: startYear + i,
              amount,
              decidedAt: NOW_ISO,
              updatedAt: NOW_ISO,
            },
          ],
    ),
  );
};
