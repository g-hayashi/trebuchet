import { type CandidateMethod, type StatementAccount, TaxCategoryCode } from "@trebuchet/schema";
import type {
  Clock,
  StatementUnitOfWork,
  SuggestionContext,
  SuggestionProvider,
} from "../ports.ts";
import { journalShape } from "../statements/journal-shape.ts";
import {
  buildAiPayload,
  buildJournalEntryPayload,
  type JournalEntryInput,
} from "../statements/mask.ts";
import { counterAccounts, type ParsedSuggestion, parseSuggestion } from "../statements/prompt.ts";
import {
  type Account,
  err,
  ok,
  type Result,
  type StatementCandidateRecord,
  type StatementRecord,
  statementNotFoundError,
} from "../types.ts";
import {
  type CandidateBody,
  loadStatementStates,
  noneBody,
  PRIVATE_ACCOUNT_REASON,
  type StatementState,
} from "./statement-candidates.ts";
import { DEFAULT_STATEMENT_SETTINGS } from "./statements.ts";

// AI による推定（006 R8・R10・R11、FR-025〜028）。AI の呼び出しは遅いので、`StatementUnitOfWork` の外で await し、
// 結果の保存だけを 1 つの `uow.run` で書く（読む → AI → 書く。待ちの間に状態が変わった明細は書かない）

export type InferenceDeps = {
  uow: StatementUnitOfWork;
  clock: Clock;
  /** 端末内の AI。`available()` が false なら飛ばす（設定で無効のときは、使えない実装を渡す） */
  local: SuggestionProvider;
  /** 外部の AI。`externalEnabled` かつ `available()`（接続先・キーがそろっている）のときだけ呼ぶ */
  external: SuggestionProvider;
  externalEnabled: boolean;
  /** 候補の `model` に記録する名前 */
  models: { local: string; external: string };
};

export type InferenceResultItem = {
  statementId: string;
  method: CandidateMethod;
  confidence: number | null;
};

/** `POST /statements/infer` の出力（contracts §4.3） */
export type InferenceResult = {
  results: InferenceResultItem[];
  localAvailable: boolean;
  externalUsed: boolean;
};

type AiMethod = "local_ai" | "external_ai";
export type AiWork = { record: StatementRecord; account: StatementAccount };
type Work = AiWork;
export type AiSuggested = { value: ParsedSuggestion; method: AiMethod; model: string };
/** AI を呼んだ結果。`suggestion` がなければ、使える出力がなかった（`failure` に理由） */
export type AiOutcome = { suggestion: AiSuggested | null; failure: string };
type Outcome = AiOutcome & { work: Work };

/**
 * 端末内 → 外部の順で AI を呼ぶ部品（R8）。推定（`inferWithAi`）で使う。
 * AI に渡すのは `buildAiPayload` の結果だけ（INV-45）。端末内の結果がない・確信度が `threshold` より低く、
 * 外部が有効（`externalEnabled` かつ `available()`）なら外部へ
 */
export function createAiSuggester(
  deps: Pick<InferenceDeps, "local" | "external" | "externalEnabled" | "models">,
  env: {
    context: SuggestionContext;
    ledgerAccounts: readonly Account[];
    threshold: number;
  },
) {
  let localChecked: boolean | undefined;
  let externalChecked: boolean | undefined;
  let externalUsed = false;
  let localUsed = false;
  const localAvailable = async (): Promise<boolean> => {
    localChecked ??= await deps.local.available();
    return localChecked;
  };
  const externalReady = async (): Promise<boolean> => {
    externalChecked ??= deps.externalEnabled && (await deps.external.available());
    return externalChecked;
  };

  const attempt = async (
    provider: SuggestionProvider,
    method: AiMethod,
    model: string,
    item: AiWork | JournalEntryInput,
  ): Promise<{ suggestion: AiSuggested } | { failure: string }> => {
    const payload =
      "record" in item ? buildAiPayload(item.record, item.account) : buildJournalEntryPayload(item);
    const response = await provider.suggest(payload, env.context);
    if (!response.ok) return { failure: response.error.message };
    const parsed = parseSuggestion(response.value, env.ledgerAccounts);
    if (!parsed.ok) return { failure: parsed.error.message };
    return { suggestion: { value: parsed.value, method, model } };
  };

  return {
    localAvailable,
    /** 外部を呼んだか */
    externalUsed: () => externalUsed,
    /** 呼んだモデルの名前（端末内、外部の順） */
    usedModels: (): string[] => [
      ...(localUsed ? [deps.models.local] : []),
      ...(externalUsed ? [deps.models.external] : []),
    ],
    /** 1 件の推定（明細、または仕訳の入力）。どちらも呼ばなかったら undefined */
    async suggest(item: AiWork | JournalEntryInput): Promise<AiOutcome | undefined> {
      let suggestion: AiSuggested | null = null;
      let failure = "";
      let called = false;
      if (await localAvailable()) {
        called = true;
        localUsed = true;
        const r = await attempt(deps.local, "local_ai", deps.models.local, item);
        if ("suggestion" in r) suggestion = r.suggestion;
        else failure = r.failure;
      }
      // 端末内の結果がない・確信度がしきい値より低いとき、外部が有効なら外部へ（外部の出力が使えなければ端末内のまま）
      if (
        (suggestion === null || suggestion.value.confidence < env.threshold) &&
        (await externalReady())
      ) {
        called = true;
        externalUsed = true;
        const r = await attempt(deps.external, "external_ai", deps.models.external, item);
        if ("suggestion" in r) suggestion = r.suggestion;
        else if (failure === "") failure = r.failure;
      }
      return called ? { suggestion, failure } : undefined;
    },
  };
}

/** AI に回す対象か（未処理で 0 円でなく、候補がない・none。前の段で候補ができた明細は呼ばない。R8） */
const needsAi = (state: StatementState, candidate: StatementCandidateRecord | undefined) =>
  state.status === "unprocessed" &&
  state.record.amount !== 0 &&
  (candidate === undefined || candidate.method === "none");

const itemOf = (
  statementId: string,
  candidate: StatementCandidateRecord | undefined,
): InferenceResultItem => ({
  statementId,
  method: candidate?.method ?? "none",
  confidence: candidate?.confidence ?? null,
});

/**
 * 候補が none の明細に、AI の推定を付ける（R8）。端末内が使えればまず端末内、確信度が `external_threshold`
 * （事業体の設定。006/T014）より低く外部が有効なら外部、端末内が使えなければ外部が有効なら外部、どちらも
 * 使えなければ none（候補は変えない）。AI を呼んで使える出力がなければ、理由つきの none を書く。
 * 端末内・外部に渡すのは `buildAiPayload` の結果だけ。未知の明細の ID は `STATEMENT_NOT_FOUND`
 */
export async function inferWithAi(
  deps: InferenceDeps,
  statementIds: readonly string[],
): Promise<Result<InferenceResult>> {
  const ids = [...new Set(statementIds)];

  // 1. 読む
  const read = deps.uow.run((tx) => {
    const states = new Map(loadStatementStates(tx, new Set(ids)).map((s) => [s.record.id, s]));
    const unknown = ids.find((id) => !states.has(id));
    if (unknown !== undefined) {
      return err(statementNotFoundError(unknown));
    }
    const candidates = new Map(
      tx.statements.listStatementCandidates().map((c) => [c.statementId, c]),
    );
    const accounts = new Map(tx.statements.listStatementAccounts().map((a) => [a.id, a]));
    const work: Work[] = [];
    for (const id of ids) {
      const state = states.get(id) as StatementState;
      const account = accounts.get(state.record.statementAccountId);
      if (account !== undefined && needsAi(state, candidates.get(id))) {
        work.push({ record: state.record, account });
      }
    }
    const ledgerAccounts = tx.masters.listAccounts();
    const context: SuggestionContext = {
      accounts: counterAccounts(ledgerAccounts).map((a) => ({ code: a.code, name: a.name })),
      taxCategories: TaxCategoryCode.options,
    };
    const threshold =
      tx.statements.getStatementSettings()?.externalThreshold ??
      DEFAULT_STATEMENT_SETTINGS.externalThreshold;
    return ok({ work, context, ledgerAccounts, threshold });
  });
  if (!read.ok) return read;
  const { work, context, ledgerAccounts, threshold } = read.value;

  // 2. AI を呼ぶ（UnitOfWork の外）
  const suggester = createAiSuggester(deps, { context, ledgerAccounts, threshold });
  const localAvailable = await suggester.localAvailable();
  const outcomes = new Map<string, Outcome>();
  for (const item of work) {
    const outcome = await suggester.suggest(item);
    if (outcome !== undefined) outcomes.set(item.record.id, { work: item, ...outcome });
  }
  const externalUsed = suggester.externalUsed();

  // 3. 書く（待ちの間に状態が変わった明細は書かない）
  const written = deps.uow.run((tx) => {
    const now = deps.clock.now();
    const states = new Map(loadStatementStates(tx, new Set(ids)).map((s) => [s.record.id, s]));
    const candidates = new Map(
      tx.statements.listStatementCandidates().map((c) => [c.statementId, c]),
    );
    const accounts = tx.masters.listAccounts();
    const items: InferenceResultItem[] = [];
    for (const id of ids) {
      const outcome = outcomes.get(id);
      const state = states.get(id) as StatementState;
      if (outcome === undefined || !needsAi(state, candidates.get(id))) {
        items.push(itemOf(id, candidates.get(id)));
        continue;
      }
      const body = candidateBody(outcome, accounts);
      tx.statements.upsertStatementCandidate({ ...body, statementId: id, createdAt: now });
      items.push({ statementId: id, method: body.method, confidence: body.confidence });
    }
    return ok(items);
  });
  if (!written.ok) return written;
  return ok({ results: written.value, localAvailable, externalUsed });
}

/** AI の結果から候補の中身を作る。仕訳の案を作れない・私用の口座の私用の判定は none */
function candidateBody(outcome: Outcome, ledgerAccounts: readonly Account[]): CandidateBody {
  const { work, suggestion } = outcome;
  if (suggestion === null) return noneBody(`AI の推定を使えません（${outcome.failure}）`);
  const s = suggestion.value;
  const shaped = journalShape({
    statement: work.record,
    account: work.account,
    purpose: s.purpose,
    counter: { accountId: s.accountId, taxCategory: s.taxCategory },
    accounts: ledgerAccounts,
  });
  if (!shaped.ok) return noneBody(`AI の推定から仕訳の案を作れません（${shaped.error.message}）`);
  if (shaped.value === null) return noneBody(PRIVATE_ACCOUNT_REASON);
  return {
    method: suggestion.method,
    purpose: s.purpose,
    confidence: s.confidence,
    reason: s.reason,
    draftJson: JSON.stringify(shaped.value.draft),
    ruleId: null,
    model: suggestion.model,
  };
}
