import { sha256Hex } from "@trebuchet/db";
import {
  acknowledgeChange,
  approveBulk,
  approveCandidate,
  buildCandidates,
  commitStatementImport,
  excludeStatement,
  getStatementSettings,
  listStatementAccounts,
  listStatementBatches,
  listStatements,
  previewStatementImport,
  saveStatementAccount,
  saveStatementSettings,
  unexcludeStatement,
  unlinkStatement,
} from "@trebuchet/domain";
import {
  ApproveBulkInput,
  ApproveInput,
  BuildCandidatesInput,
  ExcludeInput,
  StatementAccountInput,
  StatementImportCommitInput,
  StatementImportPreviewInput,
  type StatementImportSource,
  StatementListQuery,
  StatementReasonInput,
  StatementSettingsInput,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { type RouteOptions, type SuggestionProviders, statementDeps } from "../deps.ts";
import { fail, respond, validationError } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

type PasteSource = Extract<StatementImportSource, { kind: "paste" }>;

/**
 * 入力の SHA-256（R14。domain に暗号の関数を入れないので server で計算する）。
 * 貼り付けのテキストと対象の年から決める（年が違えば読んだ行が変わるため）
 */
const inputSha256 = (source: PasteSource): string =>
  sha256Hex(new TextEncoder().encode(`${source.year}\n${source.text}`));

/** 自動取得（`mfme_fetch`）は US4（T022〜T024）まで未対応 */
const unsupportedSource = validationError([
  { path: ["source", "kind"], message: "mfme_fetch は未対応です" },
]);

/**
 * `/api/entities/:entityId` の下の明細の取込と AI 仕訳（006。contracts/http-api.md §2〜§6）。
 * このファイルのルートはストーリーごとに足す。AI の実物（`suggestion`）は US5（T025）で差す
 */
export function statementRoutes({
  clock,
  suggestion,
}: RouteOptions & { suggestion?: SuggestionProviders }) {
  const deps = (db: TenantEnv["Variables"]["db"]) => statementDeps(db, clock, suggestion);

  return (
    new Hono<TenantEnv>()
      // §2 取込元の口座
      .get("/statement-accounts", (c) => {
        const result = listStatementAccounts(deps(c.var.db));
        return respond(c, result, (accounts) => c.json({ accounts }, 200));
      })
      .put("/statement-accounts/:name", validate("json", StatementAccountInput), (c) => {
        const result = saveStatementAccount(
          deps(c.var.db),
          c.req.param("name"),
          c.req.valid("json"),
        );
        return respond(c, result, (saved) => c.json(saved, 200));
      })
      // §3 取込
      .post("/statements/imports/preview", validate("json", StatementImportPreviewInput), (c) => {
        const { source } = c.req.valid("json");
        if (source.kind !== "paste") return fail(c, unsupportedSource);
        const result = previewStatementImport(deps(c.var.db), {
          source,
          sha256: inputSha256(source),
        });
        return respond(c, result, (preview) => c.json(preview, 200));
      })
      .post("/statements/imports", validate("json", StatementImportCommitInput), (c) => {
        const { source, expected } = c.req.valid("json");
        if (source.kind !== "paste") return fail(c, unsupportedSource);
        const result = commitStatementImport(deps(c.var.db), {
          source,
          sha256: inputSha256(source),
          expected,
        });
        return respond(c, result, (committed) => c.json(committed, 201));
      })
      .get("/statements/imports", (c) => {
        const result = listStatementBatches(deps(c.var.db));
        return respond(c, result, (batches) => c.json({ batches }, 200));
      })
      // §4 明細と候補
      .get("/statements", validate("query", StatementListQuery), (c) => {
        const result = listStatements(deps(c.var.db), c.req.valid("query"));
        return respond(c, result, (statements) => c.json({ statements }, 200));
      })
      .post("/statements/candidates", validate("json", BuildCandidatesInput), (c) => {
        const result = buildCandidates(deps(c.var.db), c.req.valid("json").statementIds);
        return respond(c, result, (built) => c.json(built, 200));
      })
      .post("/statements/approve-bulk", validate("json", ApproveBulkInput), (c) => {
        const result = approveBulk(deps(c.var.db), c.req.valid("json"));
        return respond(c, result, (bulk) => c.json(bulk, 200));
      })
      .post("/statements/:statementId/approve", validate("json", ApproveInput), (c) => {
        const result = approveCandidate(
          deps(c.var.db),
          c.req.param("statementId"),
          c.req.valid("json"),
        );
        return respond(c, result, ({ journal, link, pairLink, warnings }) =>
          c.json({ journal, link, pairLink, warnings }, 201),
        );
      })
      .post("/statements/:statementId/exclude", validate("json", ExcludeInput), (c) => {
        const result = excludeStatement(
          deps(c.var.db),
          c.req.param("statementId"),
          c.req.valid("json"),
        );
        return respond(c, result, (statement) => c.json({ statement }, 200));
      })
      .post("/statements/:statementId/unexclude", validate("json", StatementReasonInput), (c) => {
        const result = unexcludeStatement(
          deps(c.var.db),
          c.req.param("statementId"),
          c.req.valid("json"),
        );
        return respond(c, result, (statement) => c.json({ statement }, 200));
      })
      .post("/statements/:statementId/acknowledge-change", (c) => {
        const result = acknowledgeChange(deps(c.var.db), c.req.param("statementId"));
        return respond(c, result, (statement) => c.json({ statement }, 200));
      })
      .post("/statements/:statementId/unlink", validate("json", StatementReasonInput), (c) => {
        const result = unlinkStatement(
          deps(c.var.db),
          c.req.param("statementId"),
          c.req.valid("json"),
        );
        return respond(c, result, (statement) => c.json({ statement }, 200));
      })
      // §6.3 設定
      .get("/statement-settings", (c) => {
        const result = getStatementSettings(deps(c.var.db));
        return respond(c, result, (settings) => c.json({ settings }, 200));
      })
      .put("/statement-settings", validate("json", StatementSettingsInput), (c) => {
        const result = saveStatementSettings(deps(c.var.db), c.req.valid("json"));
        return respond(c, result, (settings) => c.json({ settings }, 200));
      })
  );
}
