import { queryOptions } from "@tanstack/react-query";
import type {
  BillingTermsView,
  InvoiceCalculationInput,
  InvoiceDetail,
  InvoiceListStatus,
} from "@trebuchet/schema";
import { api, unwrap } from "@/lib/api";

// 請求の設定・取引先の請求の条件の API（005 contracts/http-api.md §2）

const entityApi = api.api.entities[":entityId"];

/** クエリのキー。保存のあとは事業体の請求の設定・条件を読み直す */
export const invoicingKeys = {
  settings: (entityId: string) => ["entities", entityId, "invoice-settings"] as const,
  billingTerms: (entityId: string) => ["entities", entityId, "billing-terms"] as const,
};

/** 発行者の設定と、次の通し番号の下限（§2.1） */
export const invoiceSettingsQuery = (entityId: string) =>
  queryOptions({
    queryKey: invoicingKeys.settings(entityId),
    queryFn: async () => unwrap(await entityApi["invoice-settings"].$get({ param: { entityId } })),
  });

/** 請求の条件の一覧（§2.3。取引先の名前・敬称・使用中かつき） */
export const billingTermsQuery = (entityId: string) =>
  queryOptions({
    queryKey: invoicingKeys.billingTerms(entityId),
    queryFn: async () =>
      (await unwrap(await entityApi["billing-terms"].$get({ param: { entityId } }))).terms,
  });

export type BillingTermsRow = BillingTermsView;

export const putInvoiceSettings = async (
  entityId: string,
  json: Parameters<(typeof entityApi)["invoice-settings"]["$put"]>[0]["json"],
) => unwrap(await entityApi["invoice-settings"].$put({ param: { entityId }, json }));

const termsApi = entityApi.partners[":partnerId"]["billing-terms"];

export const putBillingTerms = async (
  entityId: string,
  partnerId: string,
  json: Parameters<typeof termsApi.$put>[0]["json"],
) => unwrap(await termsApi.$put({ param: { entityId, partnerId }, json }));

/** 敬称だけを直す（001 の `PATCH /partners/:partnerId`。名称とメモはそのまま送る） */
export const patchPartnerHonorific = async (
  entityId: string,
  partner: { id: string; name: string; memo: string | null },
  honorific: "様" | "御中" | null,
) =>
  unwrap(
    await entityApi.partners[":partnerId"].$patch({
      param: { entityId, partnerId: partner.id },
      json: {
        name: partner.name,
        honorific,
        ...(partner.memo === null || partner.memo === "" ? {} : { memo: partner.memo }),
      },
    }),
  );

/** 条件を外す（204）。失敗のときは ApiError を投げる */
export const deleteBillingTerms = async (entityId: string, partnerId: string) => {
  await unwrap(await termsApi.$delete({ param: { entityId, partnerId } }));
};

// ---- 工数・請求書（US1。contracts §3、§6.1） ----

export const invoiceKeys = {
  /** 全ての月の工数（取引先を登録・編集したあとの読み直し用の接頭辞） */
  workHoursAll: (entityId: string) => ["entities", entityId, "work-hours"] as const,
  workHours: (entityId: string, month: string) =>
    ["entities", entityId, "work-hours", month] as const,
  invoices: (entityId: string) => ["entities", entityId, "invoices"] as const,
  invoiceList: (entityId: string, filters: InvoiceFilters) =>
    ["entities", entityId, "invoices", "list", filters] as const,
  invoice: (entityId: string, invoiceId: string) =>
    ["entities", entityId, "invoices", "detail", invoiceId] as const,
  journalOrigin: (entityId: string, journalId: string) =>
    ["entities", entityId, "journals", journalId, "origin"] as const,
};

export type InvoiceFilters = {
  partnerId?: string | undefined;
  month?: string | undefined;
  status?: InvoiceListStatus | undefined;
};

/** 対象月の工数（§3.1）。時間単価型の有効な取引先ごと。未入力は `hours: null` */
export const workHoursQuery = (entityId: string, month: string) =>
  queryOptions({
    queryKey: invoiceKeys.workHours(entityId, month),
    queryFn: async () =>
      (await unwrap(await entityApi["work-hours"].$get({ param: { entityId }, query: { month } })))
        .entries,
  });

export const putWorkHours = async (
  entityId: string,
  month: string,
  entries: { partnerId: string; hours: number }[],
) =>
  (
    await unwrap(
      await entityApi["work-hours"][":month"].$put({
        param: { entityId, month },
        json: { entries },
      }),
    )
  ).entries;

/** 請求書の案（§3.3）。保存しない */
export const postInvoiceDrafts = async (entityId: string, month: string) =>
  unwrap(await entityApi.invoices.drafts.$post({ param: { entityId }, json: { month } }));

export type InvoiceDraftResult = Awaited<ReturnType<typeof postInvoiceDrafts>>;
export type InvoiceDraftView = InvoiceDraftResult["drafts"][number];

export const invoiceCalculationQuery = (entityId: string, input: InvoiceCalculationInput) =>
  queryOptions({
    queryKey: ["entities", entityId, "invoices", "calculation", input] as const,
    queryFn: async () =>
      unwrap(await entityApi.invoices.calculate.$post({ param: { entityId }, json: input })),
    retry: false,
  });

/** 発行（§3.4）。201 `{ invoice, journal }` */
export const postInvoice = async (
  entityId: string,
  json: Parameters<(typeof entityApi.invoices)["$post"]>[0]["json"],
) => unwrap(await entityApi.invoices.$post({ param: { entityId }, json }));

export const invoiceListQuery = (entityId: string, filters: InvoiceFilters) =>
  queryOptions({
    queryKey: invoiceKeys.invoiceList(entityId, filters),
    queryFn: async () =>
      unwrap(
        await entityApi.invoices.$get({
          param: { entityId },
          query: {
            ...(filters.partnerId === undefined ? {} : { partnerId: filters.partnerId }),
            ...(filters.month === undefined ? {} : { month: filters.month }),
            ...(filters.status === undefined ? {} : { status: filters.status }),
          },
        }),
      ),
  });

export const invoiceQuery = (entityId: string, invoiceId: string) =>
  queryOptions({
    queryKey: invoiceKeys.invoice(entityId, invoiceId),
    queryFn: async (): Promise<InvoiceDetail> =>
      unwrap(await entityApi.invoices[":invoiceId"].$get({ param: { entityId, invoiceId } })),
  });

/** 取消（§3.7） */
export const postInvoiceVoid = async (entityId: string, invoiceId: string, reason: string) =>
  unwrap(
    await entityApi.invoices[":invoiceId"].void.$post({
      param: { entityId, invoiceId },
      json: { reason },
    }),
  );

/** 入金の消し込み（§4.1）。201 `{ payment, invoice, journal }` */
export const postPayment = async (
  entityId: string,
  invoiceId: string,
  json: Parameters<(typeof entityApi.invoices)[":invoiceId"]["payments"]["$post"]>[0]["json"],
) =>
  unwrap(
    await entityApi.invoices[":invoiceId"].payments.$post({
      param: { entityId, invoiceId },
      json,
    }),
  );

/** 消し込みの取消（§4.2） */
export const postPaymentVoid = async (
  entityId: string,
  invoiceId: string,
  paymentId: string,
  reason: string,
) =>
  unwrap(
    await entityApi.invoices[":invoiceId"].payments[":paymentId"].void.$post({
      param: { entityId, invoiceId, paymentId },
      json: { reason },
    }),
  );

/** 仕訳の出所（§6.1）。請求書・入金・定期仕訳から作られた仕訳でなければ `origin: null` */
export const journalOriginQuery = (entityId: string, journalId: string) =>
  queryOptions({
    queryKey: invoiceKeys.journalOrigin(entityId, journalId),
    queryFn: async () =>
      (
        await unwrap(
          await entityApi.journals[":journalId"].origin.$get({ param: { entityId, journalId } }),
        )
      ).origin,
  });
