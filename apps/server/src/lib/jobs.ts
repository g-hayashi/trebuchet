import { randomUUIDv7 } from "node:crypto";
import type { Result } from "@trebuchet/domain";
import type { JobView } from "@trebuchet/schema";

/**
 * 長い処理のジョブ（006 R13・R17。in-memory）。評価（`startTask`）に使う。動いているジョブは同時に 1 つだけ。
 * 再起動で消える（`JOB_NOT_FOUND`）。ジョブは事業体に結びつけ、ほかの事業体からは見えない
 */

/** 評価のジョブの想定外の例外の理由（元のメッセージは出さない） */
export const EVAL_FAILED_CODE = "EVAL_FAILED";
const EVAL_FAILED_MESSAGE = "評価に失敗しました";

type Job = {
  id: string;
  entityId: string;
  status: JobView["status"];
  error?: NonNullable<JobView["error"]>;
};

export type JobStore = {
  /**
   * 評価などの処理をジョブとして動かす（R17）。`work` が失敗の Result を返すとそのエラーコードで、
   * 例外を投げると `EVAL_FAILED` で `failed` にする。動いているジョブがあれば `undefined`
   * （呼び出し側が `JOB_RUNNING` にする）
   */
  startTask(entityId: string, work: () => Promise<Result<unknown>>): { jobId: string } | undefined;
  /** 事業体が違えば見つからない（`undefined`） */
  view(entityId: string, jobId: string): JobView | undefined;
};

/** 終わったジョブを残す数 */
const KEEP_FINISHED = 5;

export function createJobStore(): JobStore {
  const jobs = new Map<string, Job>();

  const isActive = (job: Job) => job.status === "running";
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
    view(entityId, jobId) {
      const job = find(entityId, jobId);
      if (job === undefined) return undefined;
      return {
        status: job.status,
        ...(job.error === undefined ? {} : { error: job.error }),
      };
    },
  };
}
