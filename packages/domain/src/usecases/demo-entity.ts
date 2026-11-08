import { buildDemoPlan, type DemoLine, type DemoPlan, demoEntityName } from "../demo/plan.ts";
import type { Clock, DemoAssets, IdGenerator, StatementUnitOfWork } from "../ports.ts";
import {
  domainError,
  type EntitySummary,
  err,
  type JournalDraft,
  type LineDraft,
  ok,
  type Result,
} from "../types.ts";
import type { ClosingSettingsDeps } from "./blue-return.ts";
import { saveFixedAsset, saveHomeUseAllocation } from "./blue-return.ts";
import { correctJournal } from "./correct-journal.ts";
import { type CreateEntityDeps, createEntity } from "./create-entity.ts";
import { createJournal } from "./create-journal.ts";
import { saveDeferredAsset } from "./deferred-assets.ts";
import type { EntityLifecycleStore } from "./entity-lifecycle.ts";
import {
  draftInvoices,
  type InvoicingDeps,
  issueInvoice,
  recordPayment,
  saveBillingTerms,
  saveInvoiceSettings,
  saveWorkHours,
} from "./invoicing.ts";
import type { LedgerDeps } from "./journal-edit.ts";
import {
  addSubAccount,
  type MasterDeps,
  replaceOpeningBalances,
  upsertPartner,
} from "./masters.ts";
import { linkReceipt } from "./receipt-links.ts";
import { addReceipt, type ReceiptDeps } from "./receipts.ts";
import { createRecurring, postDueRecurring, type RecurringDeps } from "./recurring.ts";
import { commitStatementImport, previewStatementImport } from "./statements.ts";
import { voidJournal } from "./void-journal.ts";

// デモ事業の作成（014 R1・R2・R7、INV-77）。既存のユースケースを計画（`buildDemoPlan`）の順に呼んで、
// 業務ルール・監査の記録を通常の操作と同じ経路で通す。各ユースケースは自分の UnitOfWork・トランザクションを
// 開くので、この関数は UnitOfWork を開かない（入れ子にしない）。
//
// 全部か無か: 事業体を `preparing`（一覧・取得・バックアップに出ない）で作ってから投入し、全部が成功したら
// `activateEntity`。途中の err・例外は、事業体ごと `purgeEntityData` で消して `DEMO_FAILED`（R2）。
// AI は呼ばない（R7、INV-45）: deps の型に AI のポートを含めない。明細の取込の確定（`commitStatementImport`）の
// 依存は UnitOfWork・ID・時計だけで、候補の推定（AI）は利用者が明細の画面を開いたときの既存の経路に任せる

/** 明細の取込の依存（AI のポートを持たない） */
export type DemoStatementDeps = { uow: StatementUnitOfWork; ids: IdGenerator; clock: Clock };

/** 作った事業体（テナント）に対するユースケースの依存。server が事業体の DB から組み立てる */
export type DemoTenantDeps = {
  /** 補助科目・取引先・期首残高 */
  masters: MasterDeps;
  /** 仕訳の登録・訂正・取消 */
  journals: LedgerDeps;
  /** 家事按分・固定資産・開業費 */
  closing: ClosingSettingsDeps;
  /** 請求の設定・取引先の請求の条件・工数・請求書・入金 */
  invoicing: InvoicingDeps;
  recurring: RecurringDeps;
  /** 証憑。`files.digest` は明細の入力のハッシュにも使う */
  receipts: ReceiptDeps;
  statements: DemoStatementDeps;
};

/** 事業体の削除（`purgeEntityData`: テナントの DB・証憑のディレクトリ・registry の行）と、名前の確認のための一覧 */
export type DemoEntityStore = Pick<EntityLifecycleStore, "purgeEntityData"> & {
  /** アーカイブ済み・削除中の事業体（名前が重ならないようにする。`listEntities` は `active` だけ） */
  listArchivedEntities(): readonly Pick<EntitySummary, "name">[];
};

export type DemoEntityDeps = {
  /** `createEntity` の依存。`registry` は `activateEntity`・`listPreparingEntities` にも使う */
  create: CreateEntityDeps;
  entities: DemoEntityStore;
  /** 作った事業体のユースケースの依存 */
  tenant: (entityId: string) => DemoTenantDeps;
  assets: DemoAssets;
};

const notAvailable = () =>
  err(domainError("DEMO_NOT_AVAILABLE", "事業体があるため、デモ事業は作れません"));

const failed = (step: string, cause: string, cleanupFailed: boolean) =>
  err(
    domainError(
      "DEMO_FAILED",
      cleanupFailed
        ? "デモ事業を作れませんでした。作りかけのデータを消せませんでした。アプリを再起動してください"
        : "デモ事業を作れませんでした。作りかけのデータは残っていません",
      cleanupFailed ? { step, cause, cleanup: "failed" } : { step, cause },
    ),
  );

/** 投入の途中の失敗（`step` は段階の名前、`code` はエラーコード。金額・摘要は入れない） */
class DemoStepError extends Error {
  readonly step: string;
  readonly code: string;
  constructor(step: string, code: string) {
    super(`${step}: ${code}`);
    this.step = step;
    this.code = code;
  }
}

/** ユースケースを呼び、err・例外を `DemoStepError` にする */
function step<T>(name: string, fn: () => Result<T>): T {
  let result: Result<T>;
  try {
    result = fn();
  } catch (e) {
    if (e instanceof DemoStepError) throw e;
    throw new DemoStepError(name, "EXCEPTION");
  }
  if (!result.ok) throw new DemoStepError(name, result.error.code);
  return result.value;
}

/** 名前から ID を引く（見つからなければ計画と事業体の食い違い） */
function lookup(map: ReadonlyMap<string, string>, name: string, what: string): string {
  const id = map.get(name);
  if (id === undefined) throw new DemoStepError(`lookup:${what}`, "NOT_FOUND");
  return id;
}

type Ids = {
  accounts: ReadonlyMap<string, string>;
  subAccounts: ReadonlyMap<string, string>;
  partners: ReadonlyMap<string, string>;
};

const lineOf = (l: DemoLine, ids: Ids): LineDraft => ({
  side: l.side,
  accountId: lookup(ids.accounts, l.account, "account"),
  ...(l.sub === undefined ? {} : { subAccountId: lookup(ids.subAccounts, l.sub, "subAccount") }),
  amount: l.amount,
  ...(l.partner === undefined ? {} : { partnerId: lookup(ids.partners, l.partner, "partner") }),
  ...(l.description === undefined ? {} : { description: l.description }),
});

/**
 * デモ事業を作る（FR-001〜FR-013）。`today`（`YYYY-MM-DD`）で会計年度と各データの日付が決まる（US3）。
 * `active`・`preparing` の事業体があれば `DEMO_NOT_AVAILABLE`（何も作らない）。
 * 途中の err・例外は、作りかけの事業体ごと消して `DEMO_FAILED`（`details.step`・`details.cause` はどの段階か。
 * 後片づけも失敗したら `details.cleanup = "failed"`。残った `preparing` の行は起動時の `cleanupPreparingEntities` が消す）
 */
export function createDemoEntity(
  deps: DemoEntityDeps,
  input: { today: string },
): Result<EntitySummary> {
  const { registry } = deps.create;
  if (registry.listEntities().length > 0 || registry.listPreparingEntities().length > 0) {
    return notAvailable();
  }
  const { today } = input;
  const plan = buildDemoPlan(today);

  // `createEntity` が最初に採番する ID が事業体の ID。途中で失敗しても（テナントの DB だけ作られて
  // registry への登録で失敗したときも）その ID で後片づけできるよう控える
  let entityId: string | undefined;
  const ids: IdGenerator = {
    next: () => {
      const id = deps.create.ids.next();
      entityId ??= id;
      return id;
    },
  };

  try {
    const entity = populate(deps, { ...deps.create, ids }, plan, today);
    return ok(entity);
  } catch (e) {
    const stepName = e instanceof DemoStepError ? e.step : "unknown";
    const cause = e instanceof DemoStepError ? e.code : "EXCEPTION";
    let cleanupFailed = false;
    if (entityId !== undefined) {
      try {
        deps.entities.purgeEntityData(entityId);
      } catch {
        cleanupFailed = true;
      }
    }
    return failed(stepName, cause, cleanupFailed);
  }
}

/** 事業体を `preparing` で作り、計画の順に投入し、最後に `active` にする。失敗は `DemoStepError` で投げる */
function populate(
  deps: DemoEntityDeps,
  createDeps: CreateEntityDeps,
  plan: DemoPlan,
  today: string,
): EntitySummary {
  const name = demoEntityName(deps.entities.listArchivedEntities().map((e) => e.name));
  const created = step("createEntity", () =>
    createEntity(createDeps, {
      name,
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear: plan.fiscalYear,
      status: "preparing",
      demo: true,
    }),
  );
  const tenant = deps.tenant(created.id);
  const fiscalYear = plan.fiscalYear;

  const accounts = new Map(tenant.masters.repo.listAccounts().map((a) => [a.name, a.id]));
  const subAccounts = new Map<string, string>();
  const partners = new Map<string, string>();
  const ids: Ids = { accounts, subAccounts, partners };
  const account = (n: string) => lookup(accounts, n, "account");

  // 1. 補助科目・期首残高・取引先（請求の条件つき）
  for (const sub of plan.subAccounts) {
    const added = step("addSubAccount", () =>
      addSubAccount(tenant.masters, account(sub.account), sub.name),
    );
    subAccounts.set(sub.name, added.id);
  }
  step("replaceOpeningBalances", () =>
    replaceOpeningBalances(
      tenant.masters,
      fiscalYear,
      plan.openingBalances.map((o) => ({
        accountId: account(o.account),
        subAccountId: o.sub === undefined ? null : lookup(subAccounts, o.sub, "subAccount"),
        side: o.side,
        amount: o.amount,
      })),
    ),
  );
  for (const p of plan.partners) {
    const partner = step("upsertPartner", () =>
      upsertPartner(tenant.masters, { name: p.name, honorific: p.honorific }),
    );
    partners.set(p.name, partner.id);
    const terms = p.billingTerms;
    if (terms !== undefined) {
      step("saveBillingTerms", () => saveBillingTerms(tenant.invoicing, partner.id, terms));
    }
  }

  // 2. 仕訳（登録 → 訂正 → 取消）
  const journals = new Map<string, { id: string; version: number }>();
  const draftOf = (date: string, memo: string, lines: DemoLine[]): JournalDraft => ({
    date,
    memo,
    lines: lines.map((l) => lineOf(l, ids)),
  });
  for (const j of plan.journals) {
    const created = step("createJournal", () =>
      createJournal(tenant.journals, draftOf(j.date, j.memo, j.lines)),
    );
    journals.set(j.key, { id: created.journal.id, version: created.journal.version });
  }
  const journalOf = (key: string) => {
    const found = journals.get(key);
    if (found === undefined) throw new DemoStepError("lookup:journal", "NOT_FOUND");
    return found;
  };
  for (const c of plan.corrections) {
    const target = journalOf(c.key);
    const corrected = step("correctJournal", () =>
      correctJournal(tenant.journals, target.id, {
        ...draftOf(c.date, c.memo, c.lines),
        reason: c.reason,
        version: target.version,
      }),
    );
    journals.set(c.key, { id: corrected.id, version: corrected.version });
  }
  for (const v of plan.voids) {
    const target = journalOf(v.key);
    step("voidJournal", () =>
      voidJournal(tenant.journals, target.id, { reason: v.reason, version: target.version }),
    );
  }

  // 3. 家事按分・固定資産・開業費
  for (const h of plan.homeUse) {
    step("saveHomeUseAllocation", () =>
      saveHomeUseAllocation(tenant.closing, {
        fiscalYear,
        accountId: account(h.account),
        businessRatio: h.businessRatio,
        basis: h.basis,
      }),
    );
  }
  for (const a of plan.fixedAssets) {
    step("saveFixedAsset", () =>
      saveFixedAsset(tenant.closing, {
        name: a.name,
        acquiredOn: a.acquiredOn,
        acquisitionCost: a.acquisitionCost,
        method: a.method,
        usefulLifeYears: a.usefulLifeYears ?? null,
        priorAccumulated: 0,
        businessRatio: 10_000,
        assetAccountId: account(a.account),
        linkedJournalId: a.linkedJournalKey === undefined ? null : journalOf(a.linkedJournalKey).id,
      }),
    );
  }
  for (const d of plan.deferredAssets) {
    step("saveDeferredAsset", () =>
      saveDeferredAsset(tenant.closing, {
        name: d.name,
        totalAmount: d.totalAmount,
        openedOn: d.openedOn,
        priorAccumulated: 0,
        accountId: account(d.account),
      }),
    );
  }

  // 4. 定期仕訳（定義 → 期日の分を計上。計上できなかった回があれば失敗）
  const r = plan.recurring;
  step("createRecurring", () =>
    createRecurring(
      tenant.recurring,
      {
        name: r.name,
        dayOfMonth: r.dayOfMonth,
        startMonth: r.startMonth,
        ...(r.endMonth === undefined ? {} : { endMonth: r.endMonth }),
        lines: r.lines.map((l) => lineOf(l, ids)),
        confirm: true,
      },
      today,
    ),
  );
  const due = step("postDueRecurring", () => ok(postDueRecurring(tenant.recurring, today)));
  if (due.failed.length > 0 || due.posted.length === 0) {
    throw new DemoStepError("postDueRecurring", "RECURRING_NOT_POSTED");
  }

  // 5. 請求（設定・工数 → 発行 → 入金）
  step("saveInvoiceSettings", () => saveInvoiceSettings(tenant.invoicing, plan.invoicing.settings));
  for (const w of plan.invoicing.workHours) {
    step("saveWorkHours", () =>
      saveWorkHours(tenant.invoicing, w.month, {
        entries: [{ partnerId: lookup(partners, w.partner, "partner"), hours: w.hours }],
      }),
    );
  }
  for (const inv of plan.invoicing.invoices) {
    const partnerId = lookup(partners, inv.partner, "partner");
    const draft = step("draftInvoices", () =>
      draftInvoices(tenant.invoicing, { month: inv.month, partnerIds: [partnerId] }, today),
    ).drafts[0];
    if (draft === undefined) throw new DemoStepError("draftInvoices", "NO_DRAFT");
    const issued = step("issueInvoice", () =>
      issueInvoice(
        tenant.invoicing,
        {
          partnerId,
          ...(draft.priceMode === undefined ? {} : { priceMode: draft.priceMode }),
          targetMonth: draft.targetMonth,
          issueDate: inv.issueDate,
          salesDate: draft.salesDate,
          items: draft.items,
        },
        today,
      ),
    );
    const payment = inv.payment;
    if (payment !== undefined) {
      const withholding = issued.invoice.withholdingTax;
      step("recordPayment", () =>
        recordPayment(
          tenant.invoicing,
          issued.invoice.id,
          {
            receivedOn: payment.receivedOn,
            amount: issued.invoice.total - withholding,
            depositAccountId: account(payment.account),
            depositSubAccountId: lookup(subAccounts, payment.sub, "subAccount"),
            withholdingAmount: withholding,
          },
          today,
        ),
      );
    }
  }

  // 6. 証憑（画像を追加して仕訳に結びつける。寸法は server が先に調べた `assets.receiptProbe`）
  for (const rc of plan.receipts) {
    const receipt = step("addReceipt", () =>
      addReceipt(tenant.receipts, {
        bytes: deps.assets.receiptImage(rc.asset),
        originalName: rc.originalName,
        channel: "local",
        options: {
          category: rc.category,
          transactionDate: rc.date,
          amount: rc.amount,
          partnerName: rc.partnerName,
          memo: null,
        },
        probe: deps.assets.receiptProbe(rc.asset),
      }),
    );
    step("linkReceipt", () =>
      linkReceipt(tenant.receipts, receipt.id, { journalId: journalOf(rc.journalKey).id }),
    );
  }

  // 7. 明細（取り込むだけ。承認しない。AI は呼ばない）
  const s = plan.statement;
  const text = s.csv;
  const sha256 = tenant.receipts.files.digest(new TextEncoder().encode(text));
  const statementInput = {
    text,
    origin: "file" as const,
    year: fiscalYear,
    mapping: s.mapping,
    fixedAccountName: s.fixedAccountName,
    sha256,
  };
  const preview = step("previewStatementImport", () =>
    previewStatementImport(tenant.statements, statementInput),
  );
  step("commitStatementImport", () =>
    commitStatementImport(tenant.statements, {
      ...statementInput,
      expected: { inputSha256: preview.inputSha256, countNew: preview.countNew },
      accounts: [
        {
          name: s.fixedAccountName,
          input: {
            usage: s.account.usage,
            kind: s.account.kind,
            accountId: account(s.account.account),
            subAccountId: lookup(subAccounts, s.account.sub, "subAccount"),
          },
        },
      ],
      saveSource: { name: s.sourceName },
    }),
  );

  // 8. 有効にする（ここまで成功して初めて一覧に出る）
  try {
    createDeps.registry.activateEntity(created.id);
  } catch {
    throw new DemoStepError("activateEntity", "EXCEPTION");
  }
  return {
    id: created.id,
    name: created.name,
    kind: created.kind,
    createdAt: created.createdAt,
    demo: true,
  };
}

/**
 * 投入中のまま残った事業体（`preparing`）を消す（起動時、解錠の後。プロセスが途中で落ちたときの後始末。014 R2）。
 * 1 件の削除が失敗しても残りを続ける。`active`・`archived` は触らない
 */
export function cleanupPreparingEntities(deps: {
  create: Pick<CreateEntityDeps, "registry">;
  entities: Pick<EntityLifecycleStore, "purgeEntityData">;
}): { purged: number; failed: number } {
  let purged = 0;
  let failed = 0;
  for (const entity of deps.create.registry.listPreparingEntities()) {
    try {
      deps.entities.purgeEntityData(entity.id);
      purged += 1;
    } catch {
      failed += 1;
    }
  }
  return { purged, failed };
}
