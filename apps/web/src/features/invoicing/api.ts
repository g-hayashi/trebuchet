import { queryOptions } from "@tanstack/react-query";
import type { BillingTermsView } from "@trebuchet/schema";
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
