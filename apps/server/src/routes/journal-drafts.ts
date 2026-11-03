import { deleteJournalDraft, getJournalDraft, replaceJournalDraft } from "@trebuchet/domain";
import { JournalDraft } from "@trebuchet/schema";
import { Hono } from "hono";
import { journalDraftDeps, type RouteOptions } from "../deps.ts";
import { respond } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

export function journalDraftRoutes({ clock }: RouteOptions) {
  return new Hono<TenantEnv>()
    .get("/journal-draft", (c) =>
      respond(c, getJournalDraft(journalDraftDeps(c.var.db, clock)), (v) => c.json(v, 200)),
    )
    .put("/journal-draft", validate("json", JournalDraft), (c) =>
      respond(c, replaceJournalDraft(journalDraftDeps(c.var.db, clock), c.req.valid("json")), (v) =>
        c.json(v, 200),
      ),
    )
    .delete("/journal-draft", (c) =>
      respond(c, deleteJournalDraft(journalDraftDeps(c.var.db, clock)), () => c.body(null, 204)),
    );
}
