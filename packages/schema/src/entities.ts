import { z } from "zod";
import { EntityKind } from "./primitives.ts";

const EntityName = z.string().trim().min(1, "名称を入力してください").max(100);

export const EntityCreate = z.object({
  name: EntityName,
  kind: EntityKind,
  fiscalStartMonth: z.number().int().min(1).max(12),
  firstFiscalYear: z.number().int().min(2000).max(2100),
});
export type EntityCreate = z.infer<typeof EntityCreate>;

export const EntityPatch = z.object({ name: EntityName });
export type EntityPatch = z.infer<typeof EntityPatch>;
