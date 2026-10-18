import { z } from "zod";
import {
  AccountCategory,
  AccountingMethod,
  DateString,
  Id,
  ReportSection,
  Side,
  TaxpayerStatus,
  Yen,
} from "./primitives.ts";

const Name = z.string().trim().min(1, "名称を入力してください").max(100);

export const AccountCreate = z.object({
  name: Name,
  category: AccountCategory,
  reportSection: ReportSection,
  reportLine: z.number().int().positive().optional(),
});
export type AccountCreate = z.infer<typeof AccountCreate>;

export const AccountPatch = z
  .object({ name: Name.optional(), isActive: z.boolean().optional() })
  .refine(
    (v) => v.name !== undefined || v.isActive !== undefined,
    "変更する項目を指定してください",
  );
export type AccountPatch = z.infer<typeof AccountPatch>;

export const SubAccountCreate = z.object({ name: Name });
export type SubAccountCreate = z.infer<typeof SubAccountCreate>;

export const PartnerInput = z.object({
  name: Name,
  honorific: z.enum(["様", "御中"]).nullable(),
  memo: z.string().max(1000).optional(),
});
export type PartnerInput = z.infer<typeof PartnerInput>;

export const TagCreate = z.object({ name: z.string().trim().min(1).max(50) });
export type TagCreate = z.infer<typeof TagCreate>;

export const TaxSettingInput = z.object({
  effectiveFrom: DateString,
  taxpayerStatus: TaxpayerStatus,
  accountingMethod: AccountingMethod,
});
export type TaxSettingInput = z.infer<typeof TaxSettingInput>;

export const TaxSettingsPut = z.array(TaxSettingInput).min(1, "設定を1件以上入力してください");
export type TaxSettingsPut = z.infer<typeof TaxSettingsPut>;

export const OpeningBalanceInput = z.object({
  accountId: Id,
  subAccountId: Id.optional(),
  side: Side,
  amount: Yen,
});
export type OpeningBalanceInput = z.infer<typeof OpeningBalanceInput>;

export const OpeningBalancesPut = z.array(OpeningBalanceInput);
export type OpeningBalancesPut = z.infer<typeof OpeningBalancesPut>;
