import {
  acknowledgeRuns,
  createRecurring,
  getRecurringDetail,
  listRecurring,
  pauseRecurring,
  postDueRecurring,
  recurringStatus,
  resumeRecurring,
  skipRecurringRun,
  updateRecurring,
} from "@trebuchet/domain";
import {
  AcknowledgeInput,
  type JournalRef,
  PauseInput,
  RecurringInput,
  RecurringUpdate,
  ResumeInput,
  SkipRunInput,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { type RouteOptions, recurringDeps } from "../deps.ts";
import { respond } from "../errors.ts";
import { todayOf } from "../lib/today.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/**
 * `/api/entities/:entityId` の下の定期仕訳（005 US3。H:§5）。
 * `clock` は更新日時と「今日」（`todayOf`。R22）の元になる
 */
export function recurringRoutes({ clock }: RouteOptions) {
  const deps = (db: TenantEnv["Variables"]["db"]) => recurringDeps(db, clock);

  /**
   * 保存・再開の直後に、その事業体の判定を走らせる（R18）。応答の `posted` は、この定義で登録された仕訳。
   * ほかの定義の回が登録されることもあるが、それは `status` の未確認の知らせに出る。
   * 回の保存の失敗（例外）はそのまま投げる（定義の保存は済んでいる）
   */
  const postDue = (db: TenantEnv["Variables"]["db"], recurringId: string): JournalRef[] =>
    postDueRecurring(deps(db), todayOf(clock))
      .posted.filter((p) => p.recurringId === recurringId)
      .map(({ journal }) => ({
        id: journal.id,
        journalNo: journal.journalNo,
        date: journal.date,
        status: journal.status,
      }));

  return (
    new Hono<TenantEnv>()
      // 5.1
      .get("/recurring-journals", (c) => {
        const result = listRecurring(deps(c.var.db), todayOf(clock));
        return respond(c, result, (recurring) => c.json({ recurring }, 200));
      })
      // 5.2
      .post("/recurring-journals", validate("json", RecurringInput), (c) => {
        const result = createRecurring(deps(c.var.db), c.req.valid("json"), todayOf(clock));
        return respond(c, result, (recurring) => {
          const posted = postDue(c.var.db, recurring.id);
          return c.json({ recurring, posted }, 201);
        });
      })
      // 5.8・5.9 は `/:id` より先に登録する（Hono のルートの順）
      .get("/recurring-journals/status", (c) => {
        const result = recurringStatus(deps(c.var.db), todayOf(clock));
        return respond(c, result, (status) => c.json(status, 200));
      })
      .post("/recurring-journals/acknowledge", validate("json", AcknowledgeInput), (c) => {
        const result = acknowledgeRuns(deps(c.var.db), c.req.valid("json").runIds);
        return respond(c, result, () => c.body(null, 204));
      })
      // 5.3
      .get("/recurring-journals/:id", (c) => {
        const result = getRecurringDetail(deps(c.var.db), c.req.param("id"), todayOf(clock));
        return respond(c, result, (detail) => c.json(detail, 200));
      })
      // 5.4
      .put("/recurring-journals/:id", validate("json", RecurringUpdate), (c) => {
        const result = updateRecurring(
          deps(c.var.db),
          c.req.param("id"),
          c.req.valid("json"),
          todayOf(clock),
        );
        return respond(c, result, (recurring) => {
          const posted = postDue(c.var.db, recurring.id);
          return c.json({ recurring, posted }, 200);
        });
      })
      // 5.5
      .post("/recurring-journals/:id/pause", validate("json", PauseInput), (c) => {
        const result = pauseRecurring(deps(c.var.db), c.req.param("id"), c.req.valid("json"));
        return respond(c, result, (recurring) => c.json({ recurring }, 200));
      })
      // 5.6
      .post("/recurring-journals/:id/resume", validate("json", ResumeInput), (c) => {
        const result = resumeRecurring(
          deps(c.var.db),
          c.req.param("id"),
          c.req.valid("json"),
          todayOf(clock),
        );
        return respond(c, result, (recurring) => {
          const posted = postDue(c.var.db, recurring.id);
          return c.json({ recurring, posted }, 200);
        });
      })
      // 5.7
      .post("/recurring-journals/:id/runs/:month/skip", validate("json", SkipRunInput), (c) => {
        const result = skipRecurringRun(
          deps(c.var.db),
          c.req.param("id"),
          c.req.param("month"),
          c.req.valid("json"),
          todayOf(clock),
        );
        return respond(c, result, (run) => c.json({ run }, 200));
      })
  );
}
