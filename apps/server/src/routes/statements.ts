import { sha256Hex } from "@trebuchet/db";
import {
  acknowledgeChange,
  approveBulk,
  approveCandidate,
  buildCandidates,
  commitStatementImport,
  commitStatementRows,
  domainError,
  err,
  excludeStatement,
  getStatementSettings,
  listRules,
  listStatementAccounts,
  listStatementBatches,
  listStatements,
  ok,
  type PastedRow,
  pauseRule,
  previewStatementImport,
  previewStatementRows,
  type Result,
  resumeRule,
  ruleHistory,
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
  ExcludeInput,
  InferenceRuleListQuery,
  InferenceRuleUpdateInput,
  MfmeFetchInput,
  SeedRulesInput,
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
import { createJobStore, type JobStore, type MfmeFetcher } from "../lib/jobs.ts";
import { playwrightFetcher } from "../lib/mfme/fetcher.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

type PasteSource = Extract<StatementImportSource, { kind: "paste" }>;

/**
 * 入力の SHA-256（R14。domain に暗号の関数を入れないので server で計算する）。
 * 貼り付けのテキストと対象の年から決める（年が違えば読んだ行が変わるため）
 */
const inputSha256 = (source: PasteSource): string =>
  sha256Hex(new TextEncoder().encode(`${source.year}\n${source.text}`));

/** 自動取得（§3.4）の取得器とジョブの置き場。`createApp` の options から差し替える（テストは偽の取得器） */
export type MfmeOptions = { fetcher: MfmeFetcher; jobs: JobStore };

/** 取得した行の入力のハッシュ（R14。同じ行なら同じ値。年は日付に含まれる） */
const fetchedSha256 = (rows: readonly PastedRow[]): string =>
  sha256Hex(new TextEncoder().encode(`mfme_fetch\n${JSON.stringify(rows)}`));

/**
 * `mfme_fetch` の入力: ジョブの行。ジョブがない（再起動で消えた・別の事業体を含む）なら `JOB_NOT_FOUND`、
 * 終わっていない・失敗したなら `VALIDATION`（行を持たない）
 */
function fetchedRows(
  jobs: JobStore,
  entityId: string,
  jobId: string,
): Result<{ rows: PastedRow[]; sha256: string }> {
  const rows = jobs.rows(entityId, jobId);
  if (rows === undefined) {
    return err(domainError("JOB_NOT_FOUND", "取得のジョブが見つかりません", { jobId }));
  }
  if (rows === "not_done") {
    return err(validationError([{ path: ["source", "jobId"], message: "取得が完了していません" }]));
  }
  return ok({ rows, sha256: fetchedSha256(rows) });
}

/**
 * `/api/entities/:entityId` の下の明細の取込と AI 仕訳（006。contracts/http-api.md §2〜§6）。
 * このファイルのルートはストーリーごとに足す。AI の実物（`suggestion`）は US5（T025）で差す
 */
export function statementRoutes({
  clock,
  suggestion,
  mfme = { fetcher: playwrightFetcher, jobs: createJobStore() },
}: RouteOptions & { suggestion?: SuggestionProviders; mfme?: MfmeOptions }) {
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
        if (source.kind === "mfme_fetch") {
          const fetched = fetchedRows(mfme.jobs, c.var.entityId, source.jobId);
          if (!fetched.ok) return fail(c, fetched.error);
          const result = previewStatementRows(deps(c.var.db), {
            origin: "mfme_fetch",
            rows: fetched.value.rows,
            unreadable: [],
            sha256: fetched.value.sha256,
          });
          return respond(c, result, (preview) => c.json(preview, 200));
        }
        const result = previewStatementImport(deps(c.var.db), {
          source,
          sha256: inputSha256(source),
        });
        return respond(c, result, (preview) => c.json(preview, 200));
      })
      .post("/statements/imports", validate("json", StatementImportCommitInput), (c) => {
        const { source, expected } = c.req.valid("json");
        if (source.kind === "mfme_fetch") {
          const fetched = fetchedRows(mfme.jobs, c.var.entityId, source.jobId);
          if (!fetched.ok) return fail(c, fetched.error);
          const result = commitStatementRows(deps(c.var.db), {
            origin: "mfme_fetch",
            rows: fetched.value.rows,
            unreadable: [],
            sha256: fetched.value.sha256,
            expected,
          });
          return respond(c, result, (committed) => c.json(committed, 201));
        }
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
      // §3.4・§3.5 MF ME からの取得（ジョブはメモリだけ。行も server のメモリにだけ置く）
      .post("/statements/mfme/fetch", validate("json", MfmeFetchInput), (c) => {
        const started = mfme.jobs.start(c.var.entityId, c.req.valid("json"), mfme.fetcher);
        if (started === undefined) {
          return fail(c, domainError("JOB_RUNNING", "取得のジョブが動いています"));
        }
        return c.json({ jobId: started.jobId }, 202);
      })
      .get("/jobs/:jobId", (c) => {
        const jobId = c.req.param("jobId");
        const view = mfme.jobs.view(c.var.entityId, jobId);
        if (view === undefined) {
          return fail(c, domainError("JOB_NOT_FOUND", "取得のジョブが見つかりません", { jobId }));
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
