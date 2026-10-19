import { DateString, Id, ReportCompare } from "@trebuchet/schema";
import { z } from "zod";

/** URL の検索パラメータ。不正な値は無視して既定の条件にする */
export const RangeSearch = z.object({
  from: DateString.optional().catch(undefined),
  to: DateString.optional().catch(undefined),
});

export const CompareSearch = z.object({
  compare: ReportCompare.optional().catch(undefined),
});

export const LedgerSearch = RangeSearch.extend({
  accountId: Id.optional().catch(undefined),
  subAccountId: Id.optional().catch(undefined),
});

export const AsOfSearch = CompareSearch.extend({
  asOf: DateString.optional().catch(undefined),
});
