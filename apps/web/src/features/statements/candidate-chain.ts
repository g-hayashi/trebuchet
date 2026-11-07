import type { QueryClient } from "@tanstack/react-query";
import { MAX_INFER_BATCH } from "@trebuchet/schema";
import { aiSettingsQuery } from "@/features/ai-settings/api";
import { postBuildCandidates, postInfer, postSeedRules, statementKeys } from "./api";

/** 取込の後の自動の連鎖（011 R9。FR-019）の進み。まだ済んでいない段階は省く */
export type ChainProgress = {
  /** 過去の仕訳から作ったルールの件数 */
  seeded?: number;
  /** 作った候補の件数 */
  built?: number;
  /** AI で推定した件数。`stopped` は途中で失敗して止まったこと */
  ai?: AiProgress;
  /** AI の設定が無効なので、推定を飛ばした */
  aiSkipped?: boolean;
};

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * AI の推定の進み（`stopped` は途中で失敗して止まったこと）。
 * `externalUsed` は外部の AI へ内容を送ったことが 1 回でもあったこと、`localAvailable` は直近の応答で端末内の AI が使えたこと
 */
export type AiProgress = {
  done: number;
  total: number;
  stopped: boolean;
  externalUsed: boolean;
  localAvailable: boolean;
};

/** 推定の結果。`skipped` は AI の設定が無効（端末内も外部も使わない）で呼ばなかったこと。`error` は途中の失敗 */
export type AiRun = { skipped: true } | { skipped: false; done: number; error?: unknown };

/**
 * AI に回す明細（`needsAi`）を、設定で端末内か外部のどちらかが有効なときだけ、`MAX_INFER_BATCH` 件ずつ順に推定する。
 * 失敗したらそこで止める（済んだ分の候補は残る）。結果の一覧の読み直しは呼び出し側が行う。
 * 取込の後の連鎖（`runCandidateChain`）と、明細の一覧を開いたときの候補の作り直しが共有する
 */
export async function inferNeedsAi({
  entityId,
  queryClient,
  needsAi,
  onProgress,
}: {
  entityId: string;
  queryClient: QueryClient;
  needsAi: readonly string[];
  onProgress: (progress: AiProgress) => void;
}): Promise<AiRun> {
  const enabled = await queryClient
    .fetchQuery(aiSettingsQuery())
    .then((s) => s.localEnabled || s.externalEnabled)
    .catch(() => false);
  if (!enabled) return { skipped: true };

  const total = needsAi.length;
  let done = 0;
  let externalUsed = false;
  let localAvailable = true;
  const report = (stopped: boolean) =>
    onProgress({ done, total, stopped, externalUsed, localAvailable });
  report(false);
  try {
    for (const batch of chunks(needsAi, MAX_INFER_BATCH)) {
      const response = await postInfer(entityId, batch);
      done += batch.length;
      externalUsed = externalUsed || response.externalUsed;
      localAvailable = response.localAvailable;
      report(false);
    }
    return { skipped: false, done };
  } catch (error) {
    report(true);
    return { skipped: false, done, error };
  }
}

/** AI の推定の失敗の知らせ（済んだ件数つき） */
export const aiFailureMessage = (done: number, total: number, error: unknown) =>
  `AI の推定に失敗しました（${done} / ${total} 件まで済んでいます）: ${messageOf(error)}`;

/**
 * 取込の確定の後に、ルールの作成 → 候補の作成 → AI の推定の順に呼ぶ。
 * どの段階の失敗も `onError` で知らせて、続けられるところは続ける（ルールの作成の失敗は候補の作成へ、AI の失敗は確認へ）。
 * 候補の作成が失敗したときは、そこで止める。AI は、設定で端末内か外部のどちらかが有効で、AI に回す明細があるときだけ呼ぶ。
 * 呼び出しの順だけを持ち、推定の中身は変えない
 */
export async function runCandidateChain({
  entityId,
  queryClient,
  onProgress,
  onError,
}: {
  entityId: string;
  queryClient: QueryClient;
  onProgress: (progress: ChainProgress) => void;
  onError: (message: string) => void;
}): Promise<void> {
  let progress: ChainProgress = {};
  const update = (patch: ChainProgress) => {
    progress = { ...progress, ...patch };
    onProgress(progress);
  };

  try {
    try {
      const seeded = await postSeedRules(entityId, false);
      update({ seeded: seeded.created });
    } catch (e) {
      onError(`ルールを作れませんでした: ${messageOf(e)}`);
    }

    let needsAi: string[];
    try {
      const built = await postBuildCandidates(entityId);
      needsAi = built.needsAi;
      update({ built: built.built });
    } catch (e) {
      onError(`候補を作れませんでした: ${messageOf(e)}`);
      return;
    }
    if (needsAi.length === 0) return;

    const run = await inferNeedsAi({
      entityId,
      queryClient,
      needsAi,
      onProgress: (ai) => update({ ai }),
    });
    if (run.skipped) update({ aiSkipped: true });
    else if (run.error !== undefined)
      onError(aiFailureMessage(run.done, needsAi.length, run.error));
  } finally {
    // 作った候補・推定の結果を読み直す（失敗しても済んだ分は残る）
    await queryClient.invalidateQueries({ queryKey: statementKeys.all(entityId) });
  }
}
