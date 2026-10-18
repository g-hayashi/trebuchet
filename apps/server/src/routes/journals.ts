import {
  correctJournal,
  createJournal,
  getJournalDetail,
  getJournalHistory,
  voidJournal,
} from "@trebuchet/domain";
import { JournalCorrection, JournalInput, JournalQuery, VoidInput } from "@trebuchet/schema";
import { Hono } from "hono";
import { journalDeps } from "../deps.ts";
import { fail } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** `/api/entities/:entityId` の下の仕訳（FR-013〜023） */
export const journalRoutes = new Hono<TenantEnv>()
  .get("/journals", validate("query", JournalQuery), (c) => {
    const page = journalDeps(c.var.db).ledger.findJournals(c.req.valid("query"));
    return c.json({ journals: page.items, nextCursor: page.nextCursor }, 200);
  })
  .post("/journals", validate("json", JournalInput), (c) => {
    const result = createJournal(journalDeps(c.var.db), c.req.valid("json"));
    if (!result.ok) return fail(c, result.error);
    return c.json(result.value, 201);
  })
  .get("/journals/:journalId", (c) => {
    const result = getJournalDetail(journalDeps(c.var.db), c.req.param("journalId"));
    if (!result.ok) return fail(c, result.error);
    return c.json(result.value, 200);
  })
  .put("/journals/:journalId", validate("json", JournalCorrection), (c) => {
    const result = correctJournal(
      journalDeps(c.var.db),
      c.req.param("journalId"),
      c.req.valid("json"),
    );
    if (!result.ok) return fail(c, result.error);
    return c.json({ journal: result.value }, 200);
  })
  .post("/journals/:journalId/void", validate("json", VoidInput), (c) => {
    const result = voidJournal(
      journalDeps(c.var.db),
      c.req.param("journalId"),
      c.req.valid("json"),
    );
    if (!result.ok) return fail(c, result.error);
    return c.json({ journal: result.value }, 200);
  })
  .get("/journals/:journalId/history", (c) => {
    const result = getJournalHistory(journalDeps(c.var.db), c.req.param("journalId"));
    if (!result.ok) return fail(c, result.error);
    return c.json({ history: result.value }, 200);
  });
