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
  type InvoiceSettings,
  type InvoiceSettingsInput,
  type InvoicingVoidInput,
  type JournalOrigin,
  type WorkHoursEntry,
  type WorkHoursInput,
  YEN_LIMIT,
} from "@trebuchet/schema";
import { isValidDate } from "../dates.ts";
import { itemAmount } from "../invoicing/amounts.ts";
import { buildInvoiceDetail, buildInvoiceSummary } from "../invoicing/detail.ts";
import { buildInvoiceDraft } from "../invoicing/draft.ts";
import { dueDate, monthEnd } from "../invoicing/due-date.ts";
import { invoiceJournalDraft, reversalDraft } from "../invoicing/journal-drafts.ts";
import { formatInvoiceNo } from "../invoicing/number.ts";
import { runInTransaction } from "../invoicing/rollback.ts";
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
  type Result,
} from "../types.ts";
import { createJournal, loadContext } from "./create-journal.ts";
import { checkReason } from "./journal-edit.ts";
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
  return deps.uow.transaction(({ invoicing }) =>
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
  return deps.uow.transaction(({ invoicing }) => {
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
    invoicing.appendInvoicingAudit({
      id: deps.ids.next(),
      occurredAt: now,
      targetType: "invoice_settings",
      targetId: "1",
      action: before === null ? "create" : "update",
      reason: null,
      beforeJson: before === null ? null : JSON.stringify(before),
      afterJson: JSON.stringify(saved),
    });
    return ok(saved);
  });
}

/** 請求の条件の一覧（取引先の名前・敬称・使用中かを付ける）。取引先の名前の順 */
export function listBillingTerms(
  deps: Pick<InvoicingSettingsDeps, "uow">,
): Result<BillingTermsView[]> {
  return deps.uow.transaction(({ invoicing, masters }) => {
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
  return deps.uow.transaction(({ invoicing, masters }) => {
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
    invoicing.appendInvoicingAudit({
      id: deps.ids.next(),
      occurredAt: now,
      targetType: "billing_terms",
      targetId: partnerId,
      action: before === null ? "create" : "update",
      reason: null,
      beforeJson: before === null ? null : JSON.stringify(before),
      afterJson: JSON.stringify(saved),
    });
    return ok(saved);
  });
}

/**
 * 請求の条件を外す。発行済みの請求書は写しを持つので変わらない。条件がなければ何もしない。
 * 外したことは `void` の記録（変更前の内容つき）に残す（`invoicing_audit_log` に削除の操作がないため）
 */
export function deleteBillingTerms(deps: InvoicingSettingsDeps, partnerId: string): Result<null> {
  return deps.uow.transaction(({ invoicing }) => {
    const before = invoicing.getBillingTerms(partnerId);
    if (before === null) return ok(null);
    invoicing.deleteBillingTerms(partnerId);
    invoicing.appendInvoicingAudit({
      id: deps.ids.next(),
      occurredAt: deps.clock.now(),
      targetType: "billing_terms",
      targetId: partnerId,
      action: "void",
      reason: null,
      beforeJson: JSON.stringify(before),
      afterJson: null,
    });
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
  return deps.uow.transaction(({ invoicing, masters }) =>
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
  return deps.uow.transaction(({ invoicing, masters }) => {
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
      if (!Number.isInteger(entry.hours * 2) || entry.hours < 0) {
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
      invoicing.appendInvoicingAudit({
        id: deps.ids.next(),
        occurredAt: now,
        targetType: "work_hours",
        targetId: `${entry.partnerId}:${month}`,
        action: before === null ? "create" : "update",
        reason: null,
        beforeJson: before === null ? null : JSON.stringify(before),
        afterJson: JSON.stringify(row),
      });
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
  return deps.uow.transaction(({ invoicing, masters }) => {
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

const MAX_ITEMS = 5;

const validation = (message: string, details: Record<string, unknown>) =>
  err(domainError("VALIDATION", message, details));

/**
 * 請求書を発行する。検査（発行者の設定 → 取引先 → 重複 → 明細 → 日付）→ 売上の仕訳（`createJournal`、
 * `source = invoice`）→ 通し番号を +1 → 請求書 → 明細 → 記録、の順に 1 トランザクションで書く（R9）。
 * 通し番号は検査の段階で読む（番号を仕訳の摘要に使うため）が、書くのは仕訳の後。
 * 仕訳の `err`（`PERIOD_CLOSED`・`OUT_OF_PERIOD`・`TAX_SETTING_GAP`・`TAX_METHOD_UNSUPPORTED` など）は
 * そのまま返す（仕訳の関数は検査の後に書くので、何も残らない）。仕訳より後の失敗は例外で全体を巻き戻す
 */
export function issueInvoice(
  deps: InvoicingDeps,
  input: InvoiceInput,
  today: string,
): Result<IssuedInvoice> {
  return runInTransaction(deps.uow, ({ ledger, masters, invoicing }) => {
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

    if (input.items.length < 1 || input.items.length > MAX_ITEMS) {
      return validation(`明細は 1〜${MAX_ITEMS} 行にしてください`, { field: "items" });
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
        if (!Number.isInteger(halves) || halves < 1) {
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

    // (3) 以降の書き込みの失敗は例外で全体を巻き戻す
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
    invoicing.appendInvoicingAudit({
      id: deps.ids.next(),
      occurredAt: now,
      targetType: "invoice",
      targetId: invoice.id,
      action: "create",
      reason: null,
      beforeJson: null,
      afterJson: JSON.stringify({ invoice, items }),
    });
    return ok({ invoice: buildInvoiceDetail(invoice, items, []), journal });
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

  return runInTransaction(deps.uow, ({ ledger, masters, invoicing }) => {
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
    const period = checkPeriod(original.date, masters.listFiscalPeriods());
    if (!period.ok && period.error.code !== "PERIOD_CLOSED") return period;

    // (2) 最初の書き込みは仕訳。未締めなら取消、締め済みなら今日付の逆仕訳
    const ledgerDeps = { ledger, masters, ids: deps.ids, clock: deps.clock };
    let journal: Journal;
    let voidJournalId: string | null;
    if (period.ok) {
      const voided = voidJournal(
        ledgerDeps,
        original.id,
        { reason: reason.value, version: original.version },
        { linked: true },
      );
      if (!voided.ok) return voided;
      journal = voided.value;
      voidJournalId = null;
    } else {
      const reversal = createJournal(ledgerDeps, reversalDraft(original, today), {
        source: original.source,
      });
      if (!reversal.ok) return reversal;
      journal = reversal.value.journal;
      voidJournalId = journal.id;
    }

    // (3) 以降の書き込みの失敗は例外で全体を巻き戻す
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
    invoicing.appendInvoicingAudit({
      id: deps.ids.next(),
      occurredAt: now,
      targetType: "invoice",
      targetId: invoiceId,
      action: "void",
      reason: reason.value,
      beforeJson: JSON.stringify(invoice),
      afterJson: JSON.stringify(voidedInvoice),
    });
    return ok({
      invoice: buildInvoiceDetail(voidedInvoice, invoicing.listInvoiceItems(invoiceId), payments),
      journal,
    });
  });
}

// ---- 一覧（US1 の基本形。H:§3.5） ----

/**
 * 請求書の一覧の基本形。発行日の降順。各行の `status`・`paid`・`remaining` は消し込みから導く。
 * `overdue` は偽、`outstandingByPartner` は空（期限切れの判定・`status` の絞り込み・
 * 取引先ごとの未回収の合計は US2 の T018）
 */
export function listInvoices(
  deps: Pick<InvoicingDeps, "uow">,
  query: { partnerId?: string | undefined; month?: string | undefined },
  _today: string,
): Result<InvoiceListResponse> {
  return deps.uow.transaction(({ invoicing }) =>
    ok({
      invoices: invoicing
        .listInvoices(query)
        .map((invoice) => buildInvoiceSummary(invoice, invoicing.listPayments(invoice.id))),
      outstandingByPartner: [],
    }),
  );
}

// ---- 詳細・仕訳の起点（US1。H:§3.6・§6.1） ----

/** 請求書の詳細。保存した写しと消し込みだけから作る（INV-38）。なければ `INVOICE_NOT_FOUND` */
export function getInvoiceDetail(
  deps: Pick<InvoicingDeps, "uow">,
  invoiceId: string,
  _today: string,
): Result<InvoiceDetail> {
  return deps.uow.transaction(({ invoicing }) => {
    const invoice = invoicing.getInvoice(invoiceId);
    if (invoice === null) return err(invoiceNotFound(invoiceId));
    return ok(
      buildInvoiceDetail(
        invoice,
        invoicing.listInvoiceItems(invoiceId),
        invoicing.listPayments(invoiceId),
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
  return deps.uow.transaction(({ ledger, invoicing }) => {
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
