import { randomUUIDv7 } from "node:crypto";
import type { PastedRow, Result } from "@trebuchet/domain";
import type { JobView } from "@trebuchet/schema";

/**
 * 長い処理のジョブ（006 R13・R17。in-memory）。MF ME の取得（`start`）と評価（`startTask`）。
 * どちらも合わせて同時に 1 つだけ。取得した行は server のメモリにだけ置き、保存しない（FR-009）。
 * 再起動で消える（`JOB_NOT_FOUND`）。ジョブは事業体に結びつけ、ほかの事業体からは見えない
 */

/** 取得の期間（`YYYY-MM`、両端を含む） */
export type MfmeRange = { from: string; to: string };

/** 取得中の状態の報告（`progress` は画面に見せるだけの値） */
export type MfmeStatusReporter = (status: "waiting_login" | "running", progress?: unknown) => void;

/** 取得器（実物は Playwright の `lib/mfme/fetcher.ts`。テストは偽物を渡す） */
export type MfmeFetcher = {
  fetch(range: MfmeRange, onStatus: MfmeStatusReporter): Promise<PastedRow[]>;
};

/** 取得器が理由つきで失敗を知らせる例外。`message` は画面に出すので、取得した内容を入れない */
export class MfmeFetchError extends Error {
  readonly code: string;
  readonly failedAccounts: string[] | undefined;

  constructor(code: string, message: string, failedAccounts?: string[]) {
    super(message);
    this.name = "MfmeFetchError";
    this.code = code;
    this.failedAccounts = failedAccounts;
  }
}

/** 想定外の例外の理由（元のメッセージにはページの内容が混じりうるので出さない） */
export const FETCH_FAILED_CODE = "MFME_FETCH_FAILED";
const FETCH_FAILED_MESSAGE = "取得に失敗しました。貼り付けで取り込んでください";

/** 評価のジョブの想定外の例外の理由（元のメッセージは出さない） */
export const EVAL_FAILED_CODE = "EVAL_FAILED";
const EVAL_FAILED_MESSAGE = "評価に失敗しました";

type Job = {
  id: string;
  entityId: string;
  status: JobView["status"];
  progress?: unknown;
  error?: NonNullable<JobView["error"]>;
  /** `done` のときだけ持つ */
  rows?: PastedRow[];
};

export type JobStore = {
  /** 動いているジョブがあれば `undefined`（呼び出し側が `JOB_RUNNING` にする） */
  start(entityId: string, range: MfmeRange, fetcher: MfmeFetcher): { jobId: string } | undefined;
  /**
   * 評価などの処理を、行を持たないジョブとして動かす（R17）。`work` が失敗の Result を返すとその
   * エラーコードで、例外を投げると `EVAL_FAILED` で `failed` にする。動いているジョブがあれば `undefined`
   */
  startTask(entityId: string, work: () => Promise<Result<unknown>>): { jobId: string } | undefined;
  /** 事業体が違えば見つからない（`undefined`） */
  view(entityId: string, jobId: string): JobView | undefined;
  /** 取得の行。`done` でないジョブは `"not_done"`、見つからなければ `undefined` */
  rows(entityId: string, jobId: string): PastedRow[] | "not_done" | undefined;
};

/** 終わったジョブを残す数（取得の行をメモリに溜めない） */
const KEEP_FINISHED = 5;

export function createJobStore(): JobStore {
  const jobs = new Map<string, Job>();

  const isActive = (job: Job) => job.status === "waiting_login" || job.status === "running";
  const find = (entityId: string, jobId: string) => {
    const job = jobs.get(jobId);
    return job !== undefined && job.entityId === entityId ? job : undefined;
  };

  const prune = () => {
    const finished = [...jobs.values()].filter((j) => !isActive(j));
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      jobs.delete(job.id);
    }
  };

  const failWith = (job: Job, e: unknown) => {
    job.status = "failed";
    delete job.rows;
    job.error =
      e instanceof MfmeFetchError
        ? {
            code: e.code,
            message: e.message,
            ...(e.failedAccounts === undefined ? {} : { failedAccounts: e.failedAccounts }),
          }
        : { code: FETCH_FAILED_CODE, message: FETCH_FAILED_MESSAGE };
  };

  return {
    startTask(entityId, work) {
      if ([...jobs.values()].some(isActive)) return undefined;
      const job: Job = { id: randomUUIDv7(), entityId, status: "running" };
      jobs.set(job.id, job);
      void Promise.resolve()
        .then(work)
        .then(
          (result) => {
            if (result.ok) {
              job.status = "done";
            } else {
              job.status = "failed";
              job.error = { code: result.error.code, message: result.error.message };
            }
          },
          () => {
            job.status = "failed";
            job.error = { code: EVAL_FAILED_CODE, message: EVAL_FAILED_MESSAGE };
          },
        )
        .finally(prune);
      return { jobId: job.id };
    },
    start(entityId, range, fetcher) {
      if ([...jobs.values()].some(isActive)) return undefined;
      const job: Job = { id: randomUUIDv7(), entityId, status: "running" };
      jobs.set(job.id, job);
      const onStatus: MfmeStatusReporter = (status, progress) => {
        if (!isActive(job)) return;
        job.status = status;
        if (progress !== undefined) job.progress = progress;
      };
      // 取得器の同期の例外も failed にする（Promise の中で呼ぶ）
      void Promise.resolve()
        .then(() => fetcher.fetch(range, onStatus))
        .then(
          (rows) => {
            job.status = "done";
            job.rows = rows;
          },
          (e: unknown) => failWith(job, e),
        )
        .finally(prune);
      return { jobId: job.id };
    },
    view(entityId, jobId) {
      const job = find(entityId, jobId);
      if (job === undefined) return undefined;
      return {
        status: job.status,
        ...(job.progress === undefined ? {} : { progress: job.progress }),
        ...(job.error === undefined ? {} : { error: job.error }),
      };
    },
    rows(entityId, jobId) {
      const job = find(entityId, jobId);
      if (job === undefined) return undefined;
      return job.status === "done" && job.rows !== undefined ? job.rows : "not_done";
    },
  };
}
