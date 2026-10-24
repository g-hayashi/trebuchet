import type {
  BillingTerms,
  BillingTermsInput,
  BillingTermsView,
  InvoiceSettings,
  InvoiceSettingsInput,
} from "@trebuchet/schema";
import type { Clock, IdGenerator, InvoicingUnitOfWork } from "../ports.ts";
import { domainError, err, ok, type Result } from "../types.ts";

/** 請求書（005）の設定と条件のユースケースの依存。読み取りも UnitOfWork 越しに行う（同じ接続・トランザクション） */
export type InvoicingSettingsDeps = {
  uow: InvoicingUnitOfWork;
  ids: IdGenerator;
  clock: Clock;
};

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
