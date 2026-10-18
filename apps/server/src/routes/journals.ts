import { createJournal, domainError } from "@trebuchet/domain";
import { JournalInput, JournalListQuery } from "@trebuchet/schema";
import { Hono } from "hono";
import { journalDeps } from "../deps.ts";
import { fail } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

const DEFAULT_LIMIT = 50;

/** `/api/entities/:entityId` の下の仕訳（FR-013〜018） */
export const journalRoutes = new Hono<TenantEnv>()
  .get("/journals", validate("query", JournalListQuery), (c) => {
    const { limit = DEFAULT_LIMIT } = c.req.valid("query");
    return c.json({ journals: journalDeps(c.var.db).ledger.recentJournals(limit) }, 200);
  })
  .post("/journals", validate("json", JournalInput), (c) => {
    const result = createJournal(journalDeps(c.var.db), c.req.valid("json"));
    if (!result.ok) return fail(c, result.error);
    return c.json(result.value, 201);
  })
  .get("/journals/:journalId", (c) => {
    const journalId = c.req.param("journalId");
    const journal = journalDeps(c.var.db).ledger.getJournal(journalId);
    if (journal === undefined) {
      return fail(c, domainError("JOURNAL_NOT_FOUND", "仕訳が見つかりません", { journalId }));
    }
    return c.json({ journal }, 200);
  });
