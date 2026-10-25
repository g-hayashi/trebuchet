import {
  type BillingTerms,
  type BillingTermsInput,
  type BillingTermsView,
  type InvoiceDetail,
  type InvoiceDraft,
  type InvoiceDraftRequest,
  type InvoiceDraftResponse,
  type InvoiceInput,
  type InvoiceListResponse,
  type InvoiceListStatus,
  type InvoiceSettings,
  type InvoiceSettingsInput,
  type InvoiceSummary,
  type InvoicingVoidInput,
  isHalfStep,
  type JournalOrigin,
  MAX_INVOICE_ITEMS,
  type OutstandingByPartner,
  type PaymentInput,
  type PaymentView,
  type WorkHoursEntry,
  type WorkHoursInput,
  YEN_LIMIT,
} from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import { isValidDate, monthEnd } from "../dates.ts";
import { itemAmount } from "../invoicing/amounts.ts";
import { buildInvoiceDetail, buildInvoiceSummary, toPaymentView } from "../invoicing/detail.ts";
import { buildInvoiceDraft } from "../invoicing/draft.ts";
import { dueDate } from "../invoicing/due-date.ts";
import {
  invoiceJournalDraft,
  paymentJournalDraft,
  reversalDraft,
} from "../invoicing/journal-drafts.ts";
import { formatInvoiceNo } from "../invoicing/number.ts";
import { invoiceStatus } from "../invoicing/status.ts";
import { defaultSalesTaxCategory, effectiveTaxDisplay, itemTaxRate } from "../invoicing/tax.ts";
import { checkPeriod } from "../journal.ts";
import type { Clock, IdGenerator, InvoicingStore, InvoicingUnitOfWork } from "../ports.ts";
import {
  domainError,
  err,
  type InvoiceItemRecord,
  type InvoiceRecord,
  type Journal,
  ok,
  type Partner,
  type PaymentRecord,
  type Result,
  validation,
} from "../types.ts";
import { createJournal, loadContext } from "./create-journal.ts";
import { checkReason, type LedgerDeps } from "./journal-edit.ts";
import { voidJournal } from "./void-journal.ts";

/** 請求書（005）のユースケースの依存。読み取りも UnitOfWork 越しに行う（同じ接続・トランザクション） */
export type InvoicingSettingsDeps = {
  uow: InvoicingUnitOfWork;
  ids: IdGenerator;
  clock: Clock;
};

/** 請求書のユースケース全般の依存（設定・工数・案・発行・取消・一覧） */
export type InvoicingDeps = InvoicingSettingsDeps;

export type InvoiceSettingsView = {
  settings: InvoiceSettings | null;
  /** 次の通し番号の下限 = 発行済みの最大の `seq` + 1（なければ 1。R6） */
  minimumNextSeq: number;
};

/** 発行の前提となる発行者の項目（R5） */
export type IssuerField = "issuerName" | "address" | "contact" | "bankAccount";

const ISSUER_FIELDS: readonly IssuerField[] = ["issuerName", "address", "contact", "bankAccount"];

/** 発行者の設定が発行できる状態か。空（空白だけを含む）の必須の項目を `missing` で返す */
export function isIssuerComplete(settings: InvoiceSettings | null): {
  complete: boolean;
  missing: IssuerField[];
} {
  const missing = ISSUER_FIELDS.filter(
    (field) => settings === null || settings[field].trim() === "",
  );
  return { complete: missing.length === 0, missing };
}

/** 発行者の設定と、次の通し番号の下限。設定がなければ `settings: null` */
export function getInvoiceSettings(
  deps: Pick<InvoicingSettingsDeps, "uow">,
): Result<InvoiceSettingsView> {
  return deps.uow.run(({ invoicing }) =>
    ok({
      settings: invoicing.getInvoiceSettings(),
      minimumNextSeq: (invoicing.maxInvoiceSeq() ?? 0) + 1,
    }),
  );
}

/**
 * 発行者の設定を保存する（1 行を上書き）。`nextSeq` が発行済みの最大の `seq` 以下なら
 * `INVOICE_SEQ_TOO_LOW`（`details.minimum`。R6）。変更は `invoicing_audit_log` に残す（R23）
 */
export function saveInvoiceSettings(
  deps: InvoicingSettingsDeps,
  input: InvoiceSettingsInput,
): Result<InvoiceSettings> {
  return deps.uow.run(({ invoicing }) => {
    const minimum = (invoicing.maxInvoiceSeq() ?? 0) + 1;
    if (input.nextSeq < minimum) {
      return err(
        domainError(
          "INVOICE_SEQ_TOO_LOW",
          `次の通し番号は ${minimum} 以上にしてください（発行済みの番号より大きくします）`,
          { minimum },
        ),
      );
    }
    const before = invoicing.getInvoiceSettings();
    const now = deps.clock.now();
    const saved: InvoiceSettings = {
      issuerName: input.issuerName,
      tradeName: emptyToNull(input.tradeName),
      address: input.address,
      contact: input.contact,
      bankAccount: input.bankAccount,
      registrationNumber: emptyToNull(input.registrationNumber),
      taxDisplay: input.taxDisplay,
      nextSeq: input.nextSeq,
      updatedAt: now,
    };
    invoicing.upsertInvoiceSettings(saved);
    invoicing.appendInvoicingAudit(
      auditEntry(deps, {
        targetType: "invoice_settings",
        targetId: "1",
        action: before === null ? "create" : "update",
        before,
        after: saved,
        at: now,
      }),
    );
    return ok(saved);
  });
}

/** 請求の条件の一覧（取引先の名前・敬称・使用中かを付ける）。取引先の名前の順 */
export function listBillingTerms(
  deps: Pick<InvoicingSettingsDeps, "uow">,
): Result<BillingTermsView[]> {
  return deps.uow.run(({ invoicing, masters }) => {
    const partners = new Map(masters.listPartners().map((p) => [p.id, p]));
    const rows: BillingTermsView[] = [];
    for (const terms of invoicing.listBillingTerms()) {
      const partner = partners.get(terms.partnerId);
      if (partner === undefined) continue;
      rows.push({
        ...terms,
        partnerName: partner.name,
        honorific: partner.honorific,
        partnerActive: partner.isActive,
      });
    }
    return ok(
      rows.sort(
        (a, b) =>
          a.partnerName.localeCompare(b.partnerName) || a.partnerId.localeCompare(b.partnerId),
      ),
    );
  });
}

/**
 * 取引先の請求の条件を保存する（時間単価型は `unitPrice`、月額定額型は `monthlyAmount` だけ。FR-001・FR-002）。
 * 取引先がなければ `VALIDATION`（`details.field = "partnerId"`）。変更は記録に残す
 */
export function saveBillingTerms(
  deps: InvoicingSettingsDeps,
  partnerId: string,
  input: BillingTermsInput,
): Result<BillingTerms> {
  const mismatch = amountMismatch(input);
  if (mismatch !== null) return err(mismatch);
  return deps.uow.run(({ invoicing, masters }) => {
    if (!masters.listPartners().some((p) => p.id === partnerId)) {
      return err(
        domainError("VALIDATION", "取引先が見つかりません", {
          field: "partnerId",
          partnerId,
        }),
      );
    }
    const before = invoicing.getBillingTerms(partnerId);
    const now = deps.clock.now();
    const saved: BillingTerms = {
      partnerId,
      billingType: input.billingType,
      unitPrice: input.billingType === "hourly" ? (input.unitPrice ?? null) : null,
      monthlyAmount: input.billingType === "monthly" ? (input.monthlyAmount ?? null) : null,
      dueMonthsAfter: input.dueMonthsAfter,
      dueDay: input.dueDay,
      defaultItemName: input.defaultItemName,
      billingName: emptyToNull(input.billingName),
      updatedAt: now,
    };
    invoicing.upsertBillingTerms(saved);
    invoicing.appendInvoicingAudit(
      auditEntry(deps, {
        targetType: "billing_terms",
        targetId: partnerId,
        action: before === null ? "create" : "update",
        before,
        after: saved,
        at: now,
      }),
    );
    return ok(saved);
  });
}

/**
 * 請求の条件を外す。発行済みの請求書は写しを持つので変わらない。条件がなければ何もしない。
 * 外したことは `void` の記録（変更前の内容つき）に残す（`invoicing_audit_log` に削除の操作がないため）
 */
export function deleteBillingTerms(deps: InvoicingSettingsDeps, partnerId: string): Result<null> {
  return deps.uow.run(({ invoicing }) => {
    const before = invoicing.getBillingTerms(partnerId);
    if (before === null) return ok(null);
    invoicing.deleteBillingTerms(partnerId);
    invoicing.appendInvoicingAudit(
      auditEntry(deps, {
        targetType: "billing_terms",
        targetId: partnerId,
        action: "void",
        before,
      }),
    );
    return ok(null);
  });
}

// ---- 工数（US1。H:§3.1・§3.2） ----

const byName = (a: Partner, b: Partner) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** 工数を入れる取引先 = 時間単価型の請求の条件がある有効な取引先（名前の順） */
function hourlyPartners(
  partners: readonly Partner[],
  terms: readonly BillingTerms[],
): Map<string, Partner> {
  const hourly = new Set(terms.filter((t) => t.billingType === "hourly").map((t) => t.partnerId));
  const map = new Map<string, Partner>();
  for (const p of [...partners].sort(byName)) {
    if (p.isActive && hourly.has(p.id)) map.set(p.id, p);
  }
  return map;
}

function workHoursEntries(
  invoicing: Pick<InvoicingStore, "listWorkHours" | "listBillingTerms">,
  partners: readonly Partner[],
  month: string,
): WorkHoursEntry[] {
  const saved = new Map(invoicing.listWorkHours(month).map((w) => [w.partnerId, w.halfHours]));
  return [...hourlyPartners(partners, invoicing.listBillingTerms()).keys()].map((partnerId) => {
    const half = saved.get(partnerId);
    return { partnerId, hours: half === undefined ? null : half / 2 };
  });
}

/** 対象月の工数（時間単価型の有効な取引先。未入力は `hours: null`。FR-005） */
export function getWorkHours(
  deps: Pick<InvoicingDeps, "uow">,
  month: string,
): Result<WorkHoursEntry[]> {
  return deps.uow.run(({ invoicing, masters }) =>
    ok(workHoursEntries(invoicing, masters.listPartners(), month)),
  );
}

/**
 * 対象月の工数を保存する（上書き）。時間単価型でない・使用停止・存在しない取引先、
 * 0.5 の倍数でない工数は `VALIDATION` で、何も保存しない。保存は `work_hours` の記録に残す（R23）
 */
export function saveWorkHours(
  deps: InvoicingDeps,
  month: string,
  input: WorkHoursInput,
): Result<WorkHoursEntry[]> {
  return deps.uow.run(({ invoicing, masters }) => {
    const partners = masters.listPartners();
    const allowed = hourlyPartners(partners, invoicing.listBillingTerms());
    for (const entry of input.entries) {
      if (!allowed.has(entry.partnerId)) {
        return err(
          domainError(
            "VALIDATION",
            "工数を入れられない取引先です（時間単価型の有効な取引先だけ）",
            {
              field: "partnerId",
              partnerId: entry.partnerId,
            },
          ),
        );
      }
      if (!isHalfStep(entry.hours) || entry.hours < 0) {
        return err(
          domainError("VALIDATION", "工数は 0.5 時間単位で入力してください", {
            field: "hours",
            partnerId: entry.partnerId,
          }),
        );
      }
    }
    const now = deps.clock.now();
    for (const entry of input.entries) {
      const before = invoicing.getWorkHours(entry.partnerId, month);
      const row = {
        partnerId: entry.partnerId,
        targetMonth: month,
        halfHours: entry.hours * 2,
        updatedAt: now,
      };
      invoicing.upsertWorkHours(row);
      invoicing.appendInvoicingAudit(
        auditEntry(deps, {
          targetType: "work_hours",
          targetId: `${entry.partnerId}:${month}`,
          action: before === null ? "create" : "update",
          before,
          after: row,
          at: now,
        }),
      );
    }
    return ok(workHoursEntries(invoicing, masters.listPartners(), month));
  });
}

// ---- 請求書の案（US1。H:§3.3） ----

/**
 * 請求書の案を作る（保存しない。R3）。`partnerIds` 省略で、請求の条件のある有効な取引先すべて。
 * 指定した取引先に条件がなければ `BILLING_TERMS_MISSING`、存在しなければ `VALIDATION`、
 * 使用停止の取引先は対象外。工数がない・0 の時間単価型は `skipped` に入れる
 */
export function draftInvoices(
  deps: Pick<InvoicingDeps, "uow">,
  request: InvoiceDraftRequest,
  today: string,
): Result<InvoiceDraftResponse> {
  return deps.uow.run(({ invoicing, masters }) => {
    const partners = masters.listPartners();
    const terms = new Map(invoicing.listBillingTerms().map((t) => [t.partnerId, t]));

    let targets: Partner[];
    if (request.partnerIds === undefined) {
      targets = partners.filter((p) => p.isActive && terms.has(p.id));
    } else {
      targets = [];
      for (const partnerId of new Set(request.partnerIds)) {
        const partner = partners.find((p) => p.id === partnerId);
        if (partner === undefined) {
          return err(
            domainError("VALIDATION", "取引先が見つかりません", { field: "partnerId", partnerId }),
          );
        }
        if (!terms.has(partnerId)) {
          return err(
            domainError(
              "BILLING_TERMS_MISSING",
              `${partner.name} の請求の条件が設定されていません`,
              {
                partnerId,
              },
            ),
          );
        }
        if (partner.isActive) targets.push(partner);
      }
    }
    targets.sort(byName);

    const settings = invoicing.getInvoiceSettings();
    const ctx = loadContext(masters);
    const hours = new Map(
      invoicing.listWorkHours(request.month).map((w) => [w.partnerId, w.halfHours]),
    );
    const drafts: InvoiceDraft[] = [];
    const skipped: InvoiceDraftResponse["skipped"] = [];
    for (const partner of targets) {
      const partnerTerms = terms.get(partner.id);
      if (partnerTerms === undefined) continue;
      const outcome = buildInvoiceDraft({
        terms: partnerTerms,
        partner,
        halfHours: hours.get(partner.id) ?? null,
        month: request.month,
        settings,
        today,
        activeInvoices: invoicing.listActiveInvoices(partner.id, request.month),
        ctx,
      });
      if (outcome.kind === "draft") drafts.push(outcome.draft);
      else skipped.push({ partnerId: partner.id, reason: outcome.reason });
    }
    return ok({ drafts, skipped });
  });
}

// ---- 発行（US1。H:§3.4。R6・R9・R10・R11） ----

export type IssuedInvoice = { invoice: InvoiceDetail; journal: Journal };

/**
 * 請求書を発行する。検査（発行者の設定 → 取引先 → 重複 → 明細 → 日付）→ 売上の仕訳（`createJournal`、
 * `source = invoice`）→ 通し番号を +1 → 請求書 → 明細 → 記録、の順に 1 トランザクションで書く（R9）。
 * 通し番号は検査の段階で読む（番号を仕訳の摘要に使うため）が、書くのは仕訳の後。
 * 仕訳の `err`（`PERIOD_CLOSED`・`OUT_OF_PERIOD`・`TAX_SETTING_GAP`・`TAX_METHOD_UNSUPPORTED` など）は
 * そのまま返す。`err` と例外は UnitOfWork が全体を巻き戻す
 */
export function issueInvoice(
  deps: InvoicingDeps,
  input: InvoiceInput,
  today: string,
): Result<IssuedInvoice> {
  return deps.uow.run(({ ledger, masters, invoicing }) => {
    // (1) 読み取りと検査
    const settings = invoicing.getInvoiceSettings();
    const issuerCheck = isIssuerComplete(settings);
    if (settings === null || !issuerCheck.complete) {
      return err(
        domainError("INVOICE_ISSUER_INCOMPLETE", "発行者の情報を設定してください", {
          fields: issuerCheck.missing,
        }),
      );
    }
    const partner = masters.listPartners().find((p) => p.id === input.partnerId);
    if (partner === undefined) {
      return validation("取引先が見つかりません", {
        field: "partnerId",
        partnerId: input.partnerId,
      });
    }
    if (!partner.isActive) {
      return err(
        domainError("PARTNER_INACTIVE", `${partner.name} は使用停止の取引先です`, {
          partnerId: partner.id,
        }),
      );
    }
    const terms = invoicing.getBillingTerms(partner.id);
    if (terms === null) {
      return err(
        domainError("BILLING_TERMS_MISSING", `${partner.name} の請求の条件が設定されていません`, {
          partnerId: partner.id,
        }),
      );
    }

    const active = invoicing.listActiveInvoices(partner.id, input.targetMonth);
    if (active.length > 0 && input.confirmDuplicate !== true) {
      return err(
        domainError(
          "INVOICE_DUPLICATE_MONTH",
          `${partner.name} の ${input.targetMonth} 分の請求書がすでにあります`,
          { invoices: active.map((i) => i.invoiceNo) },
        ),
      );
    }

    const issueDate = input.issueDate ?? today;
    const salesDate = input.salesDate ?? monthEnd(input.targetMonth);
    if (!isValidDate(issueDate))
      return validation("発行日が正しい日付ではありません", { field: "issueDate" });
    if (!isValidDate(salesDate)) {
      return validation("売上の計上日が正しい日付ではありません", { field: "salesDate" });
    }

    if (input.items.length < 1 || input.items.length > MAX_INVOICE_ITEMS) {
      return validation(`明細は 1〜${MAX_INVOICE_ITEMS} 行にしてください`, { field: "items" });
    }
    const ctx = loadContext(masters);
    const defaultCategory = defaultSalesTaxCategory(salesDate, ctx.taxSettings);
    const records: Omit<InvoiceItemRecord, "id" | "invoiceId">[] = [];
    for (const [index, item] of input.items.entries()) {
      const field = `items.${index}`;
      if (item.name.trim() === "") return validation("品名を入力してください", { field, index });
      if (!Number.isSafeInteger(item.amount) || item.amount < 1 || item.amount >= YEN_LIMIT) {
        return validation("金額は 1 円以上 1 兆円未満の整数で入力してください", { field, index });
      }
      let quantityHalves: number | null = null;
      if (item.quantity !== undefined) {
        const halves = item.quantity * 2;
        if (!isHalfStep(item.quantity) || halves < 1) {
          return validation("数量は 0.5 単位の正の数で入力してください", { field, index });
        }
        quantityHalves = halves;
      }
      const unitPrice = item.unitPrice ?? null;
      if (
        quantityHalves !== null &&
        unitPrice !== null &&
        item.amount !== itemAmount(quantityHalves, unitPrice)
      ) {
        return validation("金額が数量 × 単価と一致しません", { field, index });
      }
      const taxCategory = item.taxCategory ?? defaultCategory;
      records.push({
        lineNo: index + 1,
        name: item.name.trim(),
        quantityHalves,
        unit: item.unit ?? null,
        unitPrice,
        amount: item.amount,
        taxCategory,
        taxRate: itemTaxRate(taxCategory, salesDate, ctx.taxSettings, ctx.taxRates),
      });
    }
    const total = records.reduce((sum, r) => sum + r.amount, 0);
    if (total >= YEN_LIMIT) return validation("合計が大きすぎます", { field: "items" });

    const seq = settings.nextSeq;
    const maxSeq = invoicing.maxInvoiceSeq();
    if (maxSeq !== null && seq <= maxSeq) {
      return err(
        domainError("INVOICE_SEQ_TOO_LOW", "次の通し番号が発行済みの番号以下です", {
          minimum: maxSeq + 1,
        }),
      );
    }
    const invoiceNo = formatInvoiceNo(issueDate, seq);
    const journalDraft = invoiceJournalDraft(
      { invoiceNo, partnerId: partner.id, salesDate, items: records },
      ctx.accounts,
    );
    if (!journalDraft.ok) return journalDraft;

    // (2) 最初の書き込みは売上の仕訳。その err はそのまま返す
    const posted = createJournal(
      { ledger, masters, ids: deps.ids, clock: deps.clock },
      journalDraft.value,
      { source: "invoice" },
    );
    if (!posted.ok) return posted;
    const journal = posted.value.journal;

    // (3) 以降の書き込み（失敗は err・例外とも UnitOfWork が全体を巻き戻す）
    const now = deps.clock.now();
    invoicing.upsertInvoiceSettings({ ...settings, nextSeq: seq + 1, updatedAt: now });
    const invoice: InvoiceRecord = {
      id: deps.ids.next(),
      invoiceNo,
      seq,
      partnerId: partner.id,
      targetMonth: input.targetMonth,
      issueDate,
      salesDate,
      dueDate: dueDate(input.targetMonth, terms.dueMonthsAfter, terms.dueDay),
      recipientName: terms.billingName ?? partner.name,
      recipientHonorific: partner.honorific ?? "御中",
      issuer: {
        issuerName: settings.issuerName,
        tradeName: settings.tradeName,
        address: settings.address,
        contact: settings.contact,
        bankAccount: settings.bankAccount,
        registrationNumber: settings.registrationNumber,
      },
      taxDisplay: effectiveTaxDisplay(settings.taxDisplay, salesDate, ctx.taxSettings),
      total,
      journalId: journal.id,
      createdAt: now,
      voidedAt: null,
      voidReason: null,
      voidJournalId: null,
    };
    invoicing.insertInvoice(invoice);
    const items: InvoiceItemRecord[] = records.map((r) => ({
      ...r,
      id: deps.ids.next(),
      invoiceId: invoice.id,
    }));
    invoicing.insertInvoiceItems(items);
    invoicing.appendInvoicingAudit(
      auditEntry(deps, {
        targetType: "invoice",
        targetId: invoice.id,
        action: "create",
        after: { invoice, items },
        at: now,
      }),
    );
    return ok({ invoice: buildInvoiceDetail(invoice, items, [], today), journal });
  });
}

// ---- 取消（US1。H:§3.7。R12） ----

/**
 * 請求書を取り消す。理由は 001 の `checkReason`。取消済みは `INVOICE_VOIDED`、取消でない消し込みが
 * あれば `INVOICE_HAS_PAYMENTS`（`details.paymentIds`）。元の仕訳の期間が未締めなら 001 の
 * `voidJournal(…, { linked: true })`、締め済みなら今日付の逆仕訳（`createJournal`）を起票する
 * （今日の期間がなければ 001 のエラー）。請求書に取消の列を書き、記録を残す。番号は再利用しない。
 * 返す `journal` は、取り消した元の仕訳、または起票した逆仕訳
 */
export function voidInvoice(
  deps: InvoicingDeps,
  invoiceId: string,
  input: InvoicingVoidInput,
  today: string,
): Result<IssuedInvoice> {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;

  return deps.uow.run(({ ledger, masters, invoicing }) => {
    // (1) 読み取りと検査
    const invoice = invoicing.getInvoice(invoiceId);
    if (invoice === null) return err(invoiceNotFound(invoiceId));
    if (invoice.voidedAt !== null) {
      return err(
        domainError("INVOICE_VOIDED", "この請求書はすでに取り消されています", { invoiceId }),
      );
    }
    const payments = invoicing.listPayments(invoiceId);
    const live = payments.filter((p) => p.voidedAt === null);
    if (live.length > 0) {
      return err(
        domainError(
          "INVOICE_HAS_PAYMENTS",
          "入金の消し込みがあるため取り消せません。先に消し込みを取り消してください",
          { invoiceId, paymentIds: live.map((p) => p.id) },
        ),
      );
    }
    const original = ledger.getJournal(invoice.journalId);
    if (original === undefined) {
      return err(
        domainError("JOURNAL_NOT_FOUND", "請求書の仕訳が見つかりません", {
          journalId: invoice.journalId,
        }),
      );
    }

    // (2) 最初の書き込みは仕訳。未締めなら取消、締め済みなら今日付の逆仕訳
    const undone = undoLinkedJournal(
      { ledger, masters, ids: deps.ids, clock: deps.clock },
      original,
      reason.value,
      today,
    );
    if (!undone.ok) return undone;
    const { journal, voidJournalId } = undone.value;

    // (3) 以降の書き込み（失敗は err・例外とも UnitOfWork が全体を巻き戻す）
    const now = deps.clock.now();
    invoicing.markInvoiceVoided(invoiceId, {
      voidedAt: now,
      voidReason: reason.value,
      voidJournalId,
    });
    const voidedInvoice: InvoiceRecord = {
      ...invoice,
      voidedAt: now,
      voidReason: reason.value,
      voidJournalId,
    };
    invoicing.appendInvoicingAudit(
      auditEntry(deps, {
        targetType: "invoice",
        targetId: invoiceId,
        action: "void",
        reason: reason.value,
        before: invoice,
        after: voidedInvoice,
        at: now,
      }),
    );
    return ok({
      invoice: buildInvoiceDetail(
        voidedInvoice,
        invoicing.listInvoiceItems(invoiceId),
        payments,
        today,
      ),
      journal,
    });
  });
}

/**
 * 請求書・入金の仕訳を取り消す（R12）。元の仕訳の期間が未締めなら 001 の `voidJournal(…, { linked: true })`、
 * 締め済みなら今日付の逆仕訳（`createJournal`。`source` は元と同じ）。`voidJournalId` は逆仕訳の ID
 * （直接の取消なら null）。書くのは仕訳だけなので、`err` のときは何も残らない
 */
function undoLinkedJournal(
  ledgerDeps: LedgerDeps,
  original: Journal,
  reason: string,
  today: string,
): Result<{ journal: Journal; voidJournalId: string | null }> {
  const period = checkPeriod(original.date, ledgerDeps.masters.listFiscalPeriods());
  if (!period.ok && period.error.code !== "PERIOD_CLOSED") return period;
  if (period.ok) {
    const voided = voidJournal(
      ledgerDeps,
      original.id,
      { reason, version: original.version },
      { linked: true },
    );
    if (!voided.ok) return voided;
    return ok({ journal: voided.value, voidJournalId: null });
  }
  const reversal = createJournal(ledgerDeps, reversalDraft(original, today), {
    source: original.source,
  });
  if (!reversal.ok) return reversal;
  return ok({ journal: reversal.value.journal, voidJournalId: reversal.value.journal.id });
}

// ---- 入金の消し込み（US2。H:§4。R12・R14） ----

export type PaymentResult = { payment: PaymentView; invoice: InvoiceDetail; journal: Journal };

/**
 * 入金を消し込む。検査（請求書 → 取消済み `INVOICE_VOIDED` → 入金額・入金日 → 手数料 → 超過
 * `PAYMENT_EXCEEDS_BALANCE`）→ 入金の仕訳（`createJournal`、`source = payment`。001 の検査の `err` は
 * そのまま返す）→ 消し込み → 記録、の順に 1 トランザクションで書く（R9）。
 * `treatDifferenceAsFee` なら手数料 = 残額 − 入金額（0 以下は `VALIDATION`）。充当額 = 入金額 + 手数料
 */
export function recordPayment(
  deps: InvoicingDeps,
  invoiceId: string,
  input: PaymentInput,
  today: string,
): Result<PaymentResult> {
  return deps.uow.run(({ ledger, masters, invoicing }) => {
    // (1) 読み取りと検査
    const invoice = invoicing.getInvoice(invoiceId);
    if (invoice === null) return err(invoiceNotFound(invoiceId));
    if (invoice.voidedAt !== null) {
      return err(
        domainError("INVOICE_VOIDED", "この請求書はすでに取り消されています", { invoiceId }),
      );
    }
    if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount >= YEN_LIMIT) {
      return validation("入金額は 1 円以上 1 兆円未満の整数で入力してください", {
        field: "amount",
      });
    }
    if (!isValidDate(input.receivedOn)) {
      return validation("入金日が正しい日付ではありません", { field: "receivedOn" });
    }
    const payments = invoicing.listPayments(invoiceId);
    const { remaining } = invoiceStatus(invoice, payments);
    let feeAmount = 0;
    if (input.treatDifferenceAsFee === true) {
      feeAmount = remaining - input.amount;
      if (feeAmount <= 0) {
        return validation("手数料にできる差額がありません（入金額が残額より少ないときだけです）", {
          field: "amount",
          remaining,
        });
      }
    }
    const applied = input.amount + feeAmount;
    if (applied > remaining) {
      return err(
        domainError("PAYMENT_EXCEEDS_BALANCE", "入金額が請求の残額を超えています", {
          invoiceId,
          remaining,
          applied,
        }),
      );
    }
    const ctx = loadContext(masters);
    const draft = paymentJournalDraft(
      {
        invoiceNo: invoice.invoiceNo,
        partnerId: invoice.partnerId,
        receivedOn: input.receivedOn,
        amount: input.amount,
        feeAmount,
        depositAccountId: input.depositAccountId,
        depositSubAccountId: input.depositSubAccountId,
      },
      ctx.accounts,
    );
    if (!draft.ok) return draft;

    // (2) 最初の書き込みは入金の仕訳。その err はそのまま返す
    const posted = createJournal(
      { ledger, masters, ids: deps.ids, clock: deps.clock },
      draft.value,
      { source: "payment" },
    );
    if (!posted.ok) return posted;
    const journal = posted.value.journal;

    // (3) 以降の書き込み（失敗は err・例外とも UnitOfWork が全体を巻き戻す）
    const now = deps.clock.now();
    const payment: PaymentRecord = {
      id: deps.ids.next(),
      invoiceId,
      receivedOn: input.receivedOn,
      amount: input.amount,
      feeAmount,
      depositAccountId: input.depositAccountId,
      depositSubAccountId: input.depositSubAccountId ?? null,
      journalId: journal.id,
      createdAt: now,
      voidedAt: null,
      voidReason: null,
      voidJournalId: null,
    };
    invoicing.insertPayment(payment);
    invoicing.appendInvoicingAudit(
      auditEntry(deps, {
        targetType: "payment",
        targetId: payment.id,
        action: "create",
        after: payment,
        at: now,
      }),
    );
    return ok({
      payment: toPaymentView(payment),
      invoice: buildInvoiceDetail(
        invoice,
        invoicing.listInvoiceItems(invoiceId),
        [...payments, payment],
        today,
      ),
      journal,
    });
  });
}

/**
 * 入金の消し込みを取り消す。理由は 001 の `checkReason`。ない消し込み（別の請求書のものを含む）は
 * `PAYMENT_NOT_FOUND`、取消済みは `PAYMENT_VOIDED`。入金の仕訳の期間が未締めなら 001 の
 * `voidJournal(…, { linked: true })`、締め済みなら今日付の逆仕訳。消し込みに取消の列を書き、記録を残す。
 * 返す `journal` は、取り消した元の仕訳、または起票した逆仕訳
 */
export function voidPayment(
  deps: InvoicingDeps,
  invoiceId: string,
  paymentId: string,
  input: InvoicingVoidInput,
  today: string,
): Result<PaymentResult> {
  const reason = checkReason(input.reason);
  if (!reason.ok) return reason;

  return deps.uow.run(({ ledger, masters, invoicing }) => {
    // (1) 読み取りと検査
    const invoice = invoicing.getInvoice(invoiceId);
    if (invoice === null) return err(invoiceNotFound(invoiceId));
    const payments = invoicing.listPayments(invoiceId);
    const payment = payments.find((p) => p.id === paymentId);
    if (payment === undefined) {
      return err(
        domainError("PAYMENT_NOT_FOUND", "入金の消し込みが見つかりません", {
          invoiceId,
          paymentId,
        }),
      );
    }
    if (payment.voidedAt !== null) {
      return err(
        domainError("PAYMENT_VOIDED", "この消し込みはすでに取り消されています", { paymentId }),
      );
    }
    const original = ledger.getJournal(payment.journalId);
    if (original === undefined) {
      return err(
        domainError("JOURNAL_NOT_FOUND", "入金の仕訳が見つかりません", {
          journalId: payment.journalId,
        }),
      );
    }

    // (2) 最初の書き込みは仕訳。未締めなら取消、締め済みなら今日付の逆仕訳
    const undone = undoLinkedJournal(
      { ledger, masters, ids: deps.ids, clock: deps.clock },
      original,
      reason.value,
      today,
    );
    if (!undone.ok) return undone;
    const { journal, voidJournalId } = undone.value;

    // (3) 以降の書き込み（失敗は err・例外とも UnitOfWork が全体を巻き戻す）
    const now = deps.clock.now();
    invoicing.markPaymentVoided(paymentId, {
      voidedAt: now,
      voidReason: reason.value,
      voidJournalId,
    });
    const voided: PaymentRecord = {
      ...payment,
      voidedAt: now,
      voidReason: reason.value,
      voidJournalId,
    };
    invoicing.appendInvoicingAudit(
      auditEntry(deps, {
        targetType: "payment",
        targetId: paymentId,
        action: "void",
        reason: reason.value,
        before: payment,
        after: voided,
        at: now,
      }),
    );
    return ok({
      payment: toPaymentView(voided),
      invoice: buildInvoiceDetail(
        invoice,
        invoicing.listInvoiceItems(invoiceId),
        payments.map((p) => (p.id === paymentId ? voided : p)),
        today,
      ),
      journal,
    });
  });
}

// ---- 一覧（US1 の基本形。H:§3.5） ----

/**
 * 請求書の一覧。発行日の降順。各行の `status`・`paid`・`remaining` は消し込みから導き、
 * `overdue` は `today` で判定する（`isOverdue`）。`status` は絞り込み（`overdue` は判定が真のもの）。
 * `outstandingByPartner` は `status` の絞り込みに関わらず、`partnerId`・`month` で絞った請求書のうち
 * 取消でなく残額のあるものを取引先ごとに合計する（取引先名の昇順。残額 0 の取引先は含めない。FR-022）
 */
export function listInvoices(
  deps: Pick<InvoicingDeps, "uow">,
  query: {
    partnerId?: string | undefined;
    month?: string | undefined;
    status?: InvoiceListStatus | undefined;
  },
  today: string,
): Result<InvoiceListResponse> {
  return deps.uow.run(({ invoicing, masters }) => {
    const { status, ...filter } = query;
    const all = invoicing
      .listInvoices(filter)
      .map((invoice) => buildInvoiceSummary(invoice, invoicing.listPayments(invoice.id), today));

    const partnerNames = new Map(masters.listPartners().map((p) => [p.id, p.name]));
    const totals = new Map<string, OutstandingByPartner>();
    for (const summary of all) {
      if (summary.remaining === 0) continue; // 取消の請求書は残額 0
      const entry = totals.get(summary.partnerId) ?? {
        partnerId: summary.partnerId,
        partnerName: partnerNames.get(summary.partnerId) ?? summary.recipientName,
        outstanding: 0,
        overdue: 0,
      };
      entry.outstanding += summary.remaining;
      if (summary.overdue) entry.overdue += summary.remaining;
      totals.set(summary.partnerId, entry);
    }

    const matches = (summary: InvoiceSummary) =>
      status === undefined
        ? true
        : status === "overdue"
          ? summary.overdue
          : summary.status === status;
    return ok({
      invoices: all.filter(matches),
      outstandingByPartner: [...totals.values()].sort((x, y) =>
        x.partnerName < y.partnerName ? -1 : x.partnerName > y.partnerName ? 1 : 0,
      ),
    });
  });
}

// ---- 詳細・仕訳の起点（US1。H:§3.6・§6.1） ----

/** 請求書の詳細。保存した写しと消し込みだけから作る（INV-38）。なければ `INVOICE_NOT_FOUND` */
export function getInvoiceDetail(
  deps: Pick<InvoicingDeps, "uow">,
  invoiceId: string,
  today: string,
): Result<InvoiceDetail> {
  return deps.uow.run(({ invoicing }) => {
    const invoice = invoicing.getInvoice(invoiceId);
    if (invoice === null) return err(invoiceNotFound(invoiceId));
    return ok(
      buildInvoiceDetail(
        invoice,
        invoicing.listInvoiceItems(invoiceId),
        invoicing.listPayments(invoiceId),
        today,
      ),
    );
  });
}

const invoiceNotFound = (invoiceId: string) =>
  domainError("INVOICE_NOT_FOUND", "請求書が見つかりません", { invoiceId });

/** 仕訳の起点（請求書・入金・定期仕訳）。ふつうの仕訳は `null`、仕訳がなければ `JOURNAL_NOT_FOUND` */
export function getJournalOrigin(
  deps: Pick<InvoicingDeps, "uow">,
  journalId: string,
): Result<JournalOrigin | null> {
  return deps.uow.run(({ ledger, invoicing }) => {
    if (ledger.getJournal(journalId) === undefined) {
      return err(domainError("JOURNAL_NOT_FOUND", "仕訳が見つかりません", { journalId }));
    }
    return ok(invoicing.originOfJournal(journalId));
  });
}

const emptyToNull = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value;

/** 型に合わない金額（`hourly` に月額、`monthly` に単価、または必要な金額がない）。HTTP では Zod が先に止める */
function amountMismatch(input: BillingTermsInput) {
  const [need, forbid] =
    input.billingType === "hourly"
      ? (["unitPrice", "monthlyAmount"] as const)
      : (["monthlyAmount", "unitPrice"] as const);
  if (input[need] === undefined) {
    return domainError("VALIDATION", "請求の型に合う金額を入力してください", { field: need });
  }
  if (input[forbid] !== undefined) {
    return domainError("VALIDATION", "請求の型に合わない金額は指定できません", { field: forbid });
  }
  return null;
}
