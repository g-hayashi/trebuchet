import {
  DateString,
  Id,
  JournalBookOrder,
  JournalBookSort,
  ReportCompare,
} from "@trebuchet/schema";
import { z } from "zod";

/** URL の検索パラメータ。不正な値は無視して既定の条件にする */
export const RangeSearch = z.object({
  from: DateString.optional().catch(undefined),
  to: DateString.optional().catch(undefined),
});

/** 仕訳帳の並び（011/FR-038）。URL になければ取引日の昇順 */
export const JournalBookSearch = RangeSearch.extend({
  sort: JournalBookSort.optional().catch(undefined),
  order: JournalBookOrder.optional().catch(undefined),
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
