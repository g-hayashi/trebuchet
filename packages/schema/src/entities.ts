import { z } from "zod";
import { EntityKind } from "./primitives.ts";

export const ENTITY_NAME_MAX = 100;
const EntityName = z.string().trim().min(1, "名称を入力してください").max(ENTITY_NAME_MAX);

/** 期首月（1〜12） */
export const FISCAL_START_MONTH_MIN = 1;
export const FISCAL_START_MONTH_MAX = 12;
/** 最初の年度（2000〜2100） */
export const FIRST_FISCAL_YEAR_MIN = 2000;
export const FIRST_FISCAL_YEAR_MAX = 2100;

export const EntityCreate = z.object({
  name: EntityName,
  kind: EntityKind,
  fiscalStartMonth: z.number().int().min(FISCAL_START_MONTH_MIN).max(FISCAL_START_MONTH_MAX),
  firstFiscalYear: z.number().int().min(FIRST_FISCAL_YEAR_MIN).max(FIRST_FISCAL_YEAR_MAX),
});
export type EntityCreate = z.infer<typeof EntityCreate>;

export const EntityPatch = z.object({ name: EntityName });
export type EntityPatch = z.infer<typeof EntityPatch>;
