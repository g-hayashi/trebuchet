import {
  acknowledgeChange,
  approveBulk,
  approveCandidate,
  buildCandidates,
  commitStatementImport,
  detectStatementLayout,
  domainError,
  excludeStatement,
  getStatementSettings,
  inferWithAi,
  listEvalRuns,
  listRules,
  listStatementAccounts,
  listStatementBatches,
  listStatements,
  pauseRule,
  previewStatementImport,
  resumeRule,
  ruleHistory,
  runEvaluation,
  saveStatementAccount,
  saveStatementSettings,
  seedRulesFromJournals,
  unexcludeStatement,
  unlinkStatement,
  updateRule,
} from "@trebuchet/domain";
import {
  ApproveBulkInput,
  ApproveInput,
  BuildCandidatesInput,
  EvalStartInput,
  ExcludeInput,
  InferenceRuleListQuery,
  InferenceRuleUpdateInput,
  InferInput,
  SeedRulesInput,
  StatementAccountInput,
  StatementCommitOptions,
  StatementLayoutOptions,
  StatementListQuery,
  StatementPreviewOptions,
  StatementReasonInput,
  StatementSettingsInput,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { type RouteOptions, type SuggestionProviders, statementDeps } from "../deps.ts";
import { fail, respond } from "../errors.ts";
import { type AiRuntime, LOCAL_AI_MODEL } from "../lib/ai-runtime.ts";
import { createJobStore, type JobStore } from "../lib/jobs.ts";
import { decodeStatementBytes, statementInputSha256 } from "../lib/statement-input.ts";
import { todayOf } from "../lib/today.ts";
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
  jobs = createJobStore(),
}: RouteOptions & { suggestion?: SuggestionProviders; jobs?: JobStore; ai: AiRuntime }) {
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
        const result = detectStatementLayout(deps(c.var.db), text, {
          delimiter: options.delimiter,
          headerRow: options.headerRow,
        });
        // 取込元の照合（match・headerDiff）は T012。今は常に none
        return respond(c, result, (detected) =>
          c.json({ ...detected, encoding, match: { kind: "none" as const } }, 200),
        );
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
        // accounts（未対応の口座の対応）・saveSource（取込元の保存）は T012・T013 で扱う
        const result = commitStatementImport(deps(c.var.db), {
          ...statementImportInput(upload.bytes, options),
          expected: options.expected,
        });
        return respond(c, result, (committed) => c.json(committed, 201));
      })
      .get("/statements/imports", (c) => {
        const result = listStatementBatches(deps(c.var.db));
        return respond(c, result, (batches) => c.json({ batches }, 200));
      })
      // §3.5 ジョブの状態（評価のジョブ。メモリだけ）
      .get("/jobs/:jobId", (c) => {
        const jobId = c.req.param("jobId");
        const view = jobs.view(c.var.entityId, jobId);
        if (view === undefined) {
          return fail(c, domainError("JOB_NOT_FOUND", "ジョブが見つかりません", { jobId }));
        }
        return c.json(view, 200);
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
      // §6.1・§6.2 評価（ジョブはメモリだけ。結果は eval_runs に保存する）
      .post("/statements/evals", validate("json", EvalStartInput), (c) => {
        const input = c.req.valid("json");
        const settings = ai.settings().get();
        const base = deps(c.var.db);
        const evalDeps = {
          uow: base.uow,
          ids: base.ids,
          clock: base.clock,
          local: providers.local,
          external: providers.external,
          externalEnabled: settings.externalEnabled,
          models: { local: LOCAL_AI_MODEL, external: settings.externalModel ?? "external" },
        };
        const today = todayOf(clock);
        const started = jobs.startTask(c.var.entityId, () =>
          runEvaluation(evalDeps, {
            splitDate: input.splitDate,
            includeAi: input.includeAi,
            today,
          }),
        );
        if (started === undefined) {
          return fail(c, domainError("JOB_RUNNING", "評価のジョブが動いています"));
        }
        return c.json({ jobId: started.jobId }, 202);
      })
      .get("/statements/evals", (c) => {
        const result = listEvalRuns(deps(c.var.db));
        return respond(c, result, (runs) => c.json({ runs }, 200));
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
