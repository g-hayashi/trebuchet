import {
  type Clock,
  correctJournal,
  createJournal,
  type DomainError,
  getJournalDetail,
  getJournalHistory,
  voidJournal,
} from "@trebuchet/domain";
import { JournalCorrection, JournalInput, JournalQuery, VoidInput } from "@trebuchet/schema";
import { type Context, Hono } from "hono";
import { invoicingDeps, journalDeps, type RouteOptions } from "../deps.ts";
import { fail, respond } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/**
 * 仕訳のエラーを返す。`JOURNAL_LINKED` は domain が `journalId` だけを返すので、
 * 請求・入金の起点を引いて `invoiceId`・`paymentId` を補う（005 H:§1、R13）。起点が見つからなければ補わない
 */
function failJournal(c: Context<TenantEnv>, clock: Clock, error: DomainError) {
  if (error.code !== "JOURNAL_LINKED") return fail(c, error);
  const journalId = error.details?.journalId;
  if (typeof journalId !== "string") return fail(c, error);
  const origin = invoicingDeps(c.var.db, clock).invoicing.originOfJournal(journalId);
  if (origin === null || origin.kind === "recurring") return fail(c, error);
  const { invoiceId } = origin;
  const paymentId = origin.kind === "payment" ? origin.paymentId : undefined;
  return fail(c, {
    ...error,
    details: { ...error.details, invoiceId, ...(paymentId === undefined ? {} : { paymentId }) },
  });
}

/** `/api/entities/:entityId` の下の仕訳（FR-013〜023） */
export function journalRoutes({ clock }: RouteOptions) {
  return new Hono<TenantEnv>()
    .get("/journals", validate("query", JournalQuery), (c) => {
      const page = journalDeps(c.var.db, clock).ledger.findJournals(c.req.valid("query"));
      return c.json({ journals: page.items, nextCursor: page.nextCursor }, 200);
    })
    .post("/journals", validate("json", JournalInput), (c) => {
      const result = createJournal(journalDeps(c.var.db, clock), c.req.valid("json"));
      if (!result.ok) return failJournal(c, clock, result.error);
      return c.json(result.value, 201);
    })
    .get("/journals/:journalId", (c) => {
      const result = getJournalDetail(journalDeps(c.var.db, clock), c.req.param("journalId"));
      return respond(c, result, (detail) => c.json(detail, 200));
    })
    .put("/journals/:journalId", validate("json", JournalCorrection), (c) => {
      const result = correctJournal(
        journalDeps(c.var.db, clock),
        c.req.param("journalId"),
        c.req.valid("json"),
      );
      if (!result.ok) return failJournal(c, clock, result.error);
      return c.json({ journal: result.value }, 200);
    })
    .post("/journals/:journalId/void", validate("json", VoidInput), (c) => {
      const result = voidJournal(
        journalDeps(c.var.db, clock),
        c.req.param("journalId"),
        c.req.valid("json"),
      );
      if (!result.ok) return failJournal(c, clock, result.error);
      return c.json({ journal: result.value }, 200);
    })
    .get("/journals/:journalId/history", (c) => {
      const result = getJournalHistory(journalDeps(c.var.db, clock), c.req.param("journalId"));
      return respond(c, result, (history) => c.json({ history }, 200));
    });
}
