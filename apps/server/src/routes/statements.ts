import {
  acknowledgeChange,
  approveBulk,
  approveCandidate,
  buildCandidates,
  commitStatementImport,
  deleteStatementSource,
  detectStatementLayout,
  excludeStatement,
  getStatementSettings,
  inferWithAi,
  listRules,
  listStatementAccounts,
  listStatementBatches,
  listStatementSources,
  listStatements,
  pauseRule,
  previewStatementImport,
  renameStatementSource,
  resumeRule,
  ruleHistory,
  saveStatementAccount,
  saveStatementSettings,
  seedRulesFromJournals,
  suggestStatementColumns,
  unexcludeStatement,
  unlinkStatement,
  updateRule,
} from "@trebuchet/domain";
import {
  ApproveBulkInput,
  ApproveInput,
  BuildCandidatesInput,
  ExcludeInput,
  InferenceRuleListQuery,
  InferenceRuleUpdateInput,
  InferInput,
  SeedRulesInput,
  StatementAccountInput,
  StatementColumnSuggestionOptions,
  StatementCommitOptions,
  StatementLayoutOptions,
  StatementListQuery,
  StatementPreviewOptions,
  StatementReasonInput,
  StatementSettingsInput,
  StatementSourceRenameInput,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { type RouteOptions, type SuggestionProviders, statementDeps } from "../deps.ts";
import { fail, respond } from "../errors.ts";
import { type AiRuntime, LOCAL_AI_MODEL } from "../lib/ai-runtime.ts";
import { decodeStatementBytes, statementInputSha256 } from "../lib/statement-input.ts";
import { readJsonField, readUpload, uploadLimit } from "../lib/upload.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/**
 * 取込の `file` を文字列にし（`options.encoding` があればその文字コード。007/R1）、domain の入力を作る。
 * 入力のハッシュは R11 の正規の JSON。5 MB 超 → 413、`file`・`options` が不正 → 400（readUpload・readJsonField が投げる）
 */
function statementImportInput(bytes: Uint8Array, options: StatementPreviewOptions) {
  const { text } = decodeStatementBytes(bytes, options.encoding);
  return {
    text,
    origin: options.origin,
    year: options.year,
    mapping: options.mapping,
    fixedAccountName: options.fixedAccountName,
    sha256: statementInputSha256({
      text,
      year: options.year,
      mapping: options.mapping,
      fixedAccountName: options.fixedAccountName,
    }),
  };
}

/**
 * `/api/entities/:entityId` の下の明細の取込と AI 仕訳（006。contracts/http-api.md §2〜§6）。
 * AI の推定（§4.3）は `ai`（設定・キーチェーン・fm から作った端末内・外部の実物）で呼ぶ。`suggestion` を渡すと差し替える
 */
export function statementRoutes({
  clock,
  suggestion,
  ai,
}: RouteOptions & { suggestion?: SuggestionProviders; ai: AiRuntime }) {
  const providers = suggestion ?? ai.providers;
  const deps = (db: TenantEnv["Variables"]["db"]) => statementDeps(db, clock, providers);

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
      // multipart: file と options（JSON 文字列）。007 contracts §2。上限は 5 MB（002 と同じ）
      .post("/statements/imports/layout", uploadLimit, async (c) => {
        const upload = await readUpload(c);
        const options = await readJsonField(c, "options", StatementLayoutOptions);
        const { text, encoding } = decodeStatementBytes(upload.bytes, options.encoding);
        // 取込元の照合（match・headerDiff）は domain。sourceId があればその取込元だけを見る（R8）
        const result = detectStatementLayout(deps(c.var.db), text, {
          delimiter: options.delimiter,
          headerRow: options.headerRow,
          sourceId: options.sourceId,
        });
        return respond(c, result, (detected) => c.json({ ...detected, encoding }, 200));
      })
      // 007 §4.1 列の対応の案。端末内の AI だけを呼ぶ（外部の AI の設定は読まない。FR-018）。設定で無効なら disabled
      .post("/statements/imports/column-suggestion", uploadLimit, async (c) => {
        const upload = await readUpload(c);
        const options = await readJsonField(c, "options", StatementColumnSuggestionOptions);
        const { text } = decodeStatementBytes(upload.bytes, options.encoding);
        const detected = detectStatementLayout(deps(c.var.db), text, {
          delimiter: options.delimiter,
          headerRow: options.headerRow,
        });
        if (!detected.ok) return fail(c, detected.error);
        const provider = ai.settings().get().localEnabled ? ai.columns : undefined;
        return c.json(await suggestStatementColumns({ provider }, detected.value), 200);
      })
      .post("/statements/imports/preview", uploadLimit, async (c) => {
        const upload = await readUpload(c);
        const options = await readJsonField(c, "options", StatementPreviewOptions);
        const result = previewStatementImport(
          deps(c.var.db),
          statementImportInput(upload.bytes, options),
        );
        return respond(c, result, (preview) => c.json(preview, 200));
      })
      .post("/statements/imports", uploadLimit, async (c) => {
        const upload = await readUpload(c);
        const options = await readJsonField(c, "options", StatementCommitOptions);
        // accounts（未対応の口座の対応）・saveSource は取込と同じ UnitOfWork で保存する（INV-47）
        const result = commitStatementImport(deps(c.var.db), {
          ...statementImportInput(upload.bytes, options),
          expected: options.expected,
          accounts: options.accounts,
          saveSource: options.saveSource,
        });
        return respond(c, result, (committed) => c.json(committed, 201));
      })
      .get("/statements/imports", (c) => {
        const result = listStatementBatches(deps(c.var.db));
        return respond(c, result, (batches) => c.json({ batches }, 200));
      })
      // 007 §3 取込元（列の対応の保存）
      .get("/statement-sources", (c) => {
        const result = listStatementSources(deps(c.var.db));
        return respond(c, result, (sources) => c.json({ sources }, 200));
      })
      .patch("/statement-sources/:id", validate("json", StatementSourceRenameInput), (c) => {
        const result = renameStatementSource(
          deps(c.var.db),
          c.req.param("id"),
          c.req.valid("json").name,
        );
        return respond(c, result, (source) => c.json({ source }, 200));
      })
      .delete("/statement-sources/:id", (c) => {
        const result = deleteStatementSource(deps(c.var.db), c.req.param("id"));
        return respond(c, result, () => c.body(null, 204));
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
      .post("/statements/infer", validate("json", InferInput), async (c) => {
        const settings = ai.settings().get();
        const result = await inferWithAi(
          {
            ...deps(c.var.db),
            local: providers.local,
            external: providers.external,
            externalEnabled: settings.externalEnabled,
            models: { local: LOCAL_AI_MODEL, external: settings.externalModel ?? "external" },
          },
          c.req.valid("json").statementIds,
        );
        return respond(c, result, (inferred) => c.json(inferred, 200));
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
        return respond(c, result, ({ journal, link, pairLink, warnings, rule }) =>
          c.json(
            { journal, link, pairLink, warnings, ...(rule === undefined ? {} : { rule }) },
            201,
          ),
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
      // §5 ルール
      .get("/inference-rules", validate("query", InferenceRuleListQuery), (c) => {
        const result = listRules(deps(c.var.db), c.req.valid("query"));
        return respond(c, result, (rules) => c.json({ rules }, 200));
      })
      .post("/inference-rules/seed", validate("json", SeedRulesInput), (c) => {
        const result = seedRulesFromJournals(deps(c.var.db), c.req.valid("json"));
        return respond(c, result, (seeded) => c.json(seeded, 200));
      })
      .patch("/inference-rules/:ruleId", validate("json", InferenceRuleUpdateInput), (c) => {
        const result = updateRule(deps(c.var.db), c.req.param("ruleId"), c.req.valid("json"));
        return respond(c, result, (rule) => c.json({ rule }, 200));
      })
      .post("/inference-rules/:ruleId/pause", (c) => {
        const result = pauseRule(deps(c.var.db), c.req.param("ruleId"));
        return respond(c, result, (rule) => c.json({ rule }, 200));
      })
      .post("/inference-rules/:ruleId/resume", (c) => {
        const result = resumeRule(deps(c.var.db), c.req.param("ruleId"));
        return respond(c, result, (rule) => c.json({ rule }, 200));
      })
      .get("/inference-rules/:ruleId/history", (c) => {
        const result = ruleHistory(deps(c.var.db), c.req.param("ruleId"));
        return respond(c, result, (history) => c.json({ history }, 200));
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
