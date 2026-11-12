import { describe, expect, it } from "vitest";
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
} from "../../src/usecases/recurring.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import { setupRecurring } from "../recurring-setup.ts";
import { errorOf, must } from "../result.ts";

// 005 US3: 定期仕訳のユースケース（R16・R17・R19〜R21・R23、FR-023〜029、US3 Acceptance 1〜8）

const TODAY = "2026-10-26";

/** 開始 2026-08・25 日の定義を作り、`confirm` つきで保存する */
function created(t: ReturnType<typeof setupRecurring>, over: Parameters<typeof t.input>[0] = {}) {
  return must(createRecurring(t.deps, t.input({ confirm: true, ...over }), TODAY));
}

describe("createRecurring", () => {
  it("開始月が過去で今日以前に登録される回があれば、confirm なしは RECURRING_CONFIRM_REQUIRED（何も保存しない。FR-029）", () => {
    const t = setupRecurring();
    const e = errorOf(createRecurring(t.deps, t.input(), TODAY));
    expect(e.code).toBe("RECURRING_CONFIRM_REQUIRED");
    expect(e.details).toEqual({ count: 3, months: ["2026-08", "2026-09", "2026-10"] });
    expect(t.recurring.listRecurring()).toEqual([]);
    expect(t.recurring.audits).toEqual([]);
  });

  it("confirm: true なら保存する（判定は走らせない。登録は postDueRecurring）", () => {
    const t = setupRecurring();
    const def = created(t);
    expect(def).toMatchObject({
      name: "家賃",
      dayOfMonth: 25,
      startMonth: "2026-08",
      endMonth: null,
      status: "active",
      version: 1,
    });
    expect(def.lines.map((l) => [l.lineNo, l.side, l.amount, l.taxCategory])).toEqual([
      [1, "debit", 80_000, null],
      [2, "credit", 80_000, null],
    ]);
    expect(t.recurring.getRecurring(def.id)).toEqual(def);
    expect(t.journalsOf()).toHaveLength(0);
  });

  it("開始月が未来なら confirm は要らない", () => {
    const t = setupRecurring();
    const def = must(createRecurring(t.deps, t.input({ startMonth: "2026-11" }), TODAY));
    expect(def.startMonth).toBe("2026-11");
  });

  it("開始月の予定日がまだ来ていなければ confirm は要らない", () => {
    const t = setupRecurring();
    must(createRecurring(t.deps, t.input({ startMonth: "2026-10" }), "2026-10-24"));
  });

  it("貸借の不一致は UNBALANCED、存在しない科目は ACCOUNT_NOT_FOUND、使用停止の科目は ACCOUNT_INACTIVE", () => {
    const t = setupRecurring();
    const base = t.input({ confirm: true });
    const unbalanced = {
      ...base,
      lines: base.lines.map((l, i) => (i === 0 ? { ...l, amount: 70_000 } : l)),
    };
    expect(errorOf(createRecurring(t.deps, unbalanced, TODAY)).code).toBe("UNBALANCED");

    const missing = {
      ...base,
      lines: base.lines.map((l, i) => (i === 0 ? { ...l, accountId: "no-such" } : l)),
    };
    expect(errorOf(createRecurring(t.deps, missing, TODAY)).code).toBe("ACCOUNT_NOT_FOUND");

    const rent = t.accountId("地代家賃");
    t.masters.state.accounts = t.masters.state.accounts.map((a) =>
      a.id === rent ? { ...a, isActive: false } : a,
    );
    expect(errorOf(createRecurring(t.deps, base, TODAY)).code).toBe("ACCOUNT_INACTIVE");
    expect(t.recurring.listRecurring()).toEqual([]);
  });

  it("終了月が開始月より前は VALIDATION", () => {
    const t = setupRecurring();
    const e = errorOf(
      createRecurring(t.deps, t.input({ endMonth: "2026-07", confirm: true }), TODAY),
    );
    expect(e.code).toBe("VALIDATION");
    expect(e.details).toMatchObject({ field: "endMonth" });
  });

  it("締め済みの年度に入る開始月も保存できる（登録の段階で blocked になる。Acceptance 6）", () => {
    const t = setupRecurring();
    t.closeYear(2026);
    const def = must(createRecurring(t.deps, t.input(), TODAY));
    expect(def.status).toBe("active");
  });

  it("作成を監査（recurring_journal / create）に残す", () => {
    const t = setupRecurring();
    const def = created(t);
    expect(t.recurring.audits).toHaveLength(1);
    expect(t.recurring.audits[0]).toMatchObject({
      targetType: "recurring_journal",
      targetId: def.id,
      action: "create",
      beforeJson: null,
    });
  });
});

describe("postDueRecurring", () => {
  it("8・9・10 月の 25 日付の 3 件を登録し、出所は recurring（Acceptance 1）", () => {
    const t = setupRecurring();
    const def = created(t);
    const result = postDueRecurring(t.deps, TODAY);
    expect(result.failed).toEqual([]);
    expect(result.posted.map((p) => [p.recurringId, p.targetMonth, p.journal.date])).toEqual([
      [def.id, "2026-08", "2026-08-25"],
      [def.id, "2026-09", "2026-09-25"],
      [def.id, "2026-10", "2026-10-25"],
    ]);
    expect(t.journalsOf().map((j) => [j.source, j.date, j.memo])).toEqual([
      ["recurring", "2026-08-25", "事務所の家賃"],
      ["recurring", "2026-09-25", "事務所の家賃"],
      ["recurring", "2026-10-25", "事務所の家賃"],
    ]);
    const runs = t.recurring.listRuns(def.id);
    expect(runs.map((r) => [r.targetMonth, r.status, r.acknowledgedAt])).toEqual([
      ["2026-08", "posted", null],
      ["2026-09", "posted", null],
      ["2026-10", "posted", null],
    ]);
    expect(runs.map((r) => r.journalId)).toEqual(result.posted.map((p) => p.journal.id));
  });

  it("もう一度走らせても、同じ日に何度走っても増えない（Acceptance 2）", () => {
    const t = setupRecurring();
    created(t);
    postDueRecurring(t.deps, TODAY);
    expect(postDueRecurring(t.deps, TODAY).posted).toEqual([]);
    expect(postDueRecurring(t.deps, "2026-10-27").posted).toEqual([]);
    expect(t.journalsOf()).toHaveLength(3);
    expect(t.recurring.state.runs).toHaveLength(3);
  });

  it("月が進むと、その月の回だけ増える", () => {
    const t = setupRecurring();
    created(t);
    postDueRecurring(t.deps, TODAY);
    const next = postDueRecurring(t.deps, "2026-11-25");
    expect(next.posted.map((p) => p.targetMonth)).toEqual(["2026-11"]);
    expect(t.journalsOf()).toHaveLength(4);
  });

  it("予定日が末日の定義は月ごとの末日付になる（Acceptance 3）", () => {
    const t = setupRecurring();
    created(t, { dayOfMonth: 31, startMonth: "2026-01" });
    postDueRecurring(t.deps, "2026-04-30");
    expect(t.journalsOf().map((j) => j.date)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("登録した仕訳を取り消しても、再び登録されない（R19）", () => {
    const t = setupRecurring();
    created(t, { startMonth: "2026-10" });
    const first = postDueRecurring(t.deps, TODAY).posted[0]?.journal;
    expect(first).toBeDefined();
    if (first === undefined) return;
    must(
      voidJournal({ ledger: t.ledger, masters: t.masters, ids: t.ids, clock: t.clock }, first.id, {
        reason: "誤り",
        version: first.version,
      }),
    );
    expect(postDueRecurring(t.deps, "2026-10-30").posted).toEqual([]);
    expect(t.recurring.state.runs).toHaveLength(1);
    expect(t.journalsOf()).toHaveLength(1);
  });

  it("締め済みの回は登録せず、締めを解くと次の判定で登録される（blocked は保存しない。Acceptance 6）", () => {
    const t = setupRecurring();
    created(t);
    t.closeYear(2026);
    const first = postDueRecurring(t.deps, TODAY);
    expect(first.posted).toEqual([]);
    expect(t.recurring.state.runs).toEqual([]);
    const p = t.masters.getFiscalPeriodByYear(2026);
    if (p === undefined) throw new Error("期間がない");
    t.masters.updateFiscalPeriod({ ...p, status: "open", closedAt: null });
    expect(postDueRecurring(t.deps, TODAY).posted).toHaveLength(3);
  });

  it("停止中の定義は登録しない。終了月を過ぎても登録しない（Acceptance 5）", () => {
    const t = setupRecurring();
    const def = created(t, { endMonth: "2026-09" });
    postDueRecurring(t.deps, "2026-12-31");
    expect(t.recurring.listRuns(def.id).map((r) => r.targetMonth)).toEqual(["2026-08", "2026-09"]);

    const t2 = setupRecurring();
    const def2 = created(t2);
    must(pauseRecurring(t2.deps, def2.id, { version: 1 }));
    expect(postDueRecurring(t2.deps, TODAY).posted).toEqual([]);
    expect(t2.journalsOf()).toHaveLength(0);
  });

  it("複数の定義を順に登録し、1 つの定義の blocked が他を止めない", () => {
    const t = setupRecurring();
    created(t, { name: "家賃", startMonth: "2026-10" });
    // 2025 年度の開始・2026-10 を含む定義 B。使用停止の取引先の行 → blocked
    created(t, {
      name: "外注",
      startMonth: "2026-10",
      lines: [
        {
          side: "debit",
          accountId: t.accountId("地代家賃"),
          amount: 5_000,
          partnerId: t.inactivePartner.id,
        },
        { side: "credit", accountId: t.accountId("普通預金"), amount: 5_000 },
      ],
    });
    const result = postDueRecurring(t.deps, TODAY);
    expect(result.posted).toHaveLength(1);
    const status = must(recurringStatus(t.deps, TODAY));
    expect(status.blocked.map((b) => [b.name, b.reason])).toEqual([["外注", "PARTNER_INACTIVE"]]);
  });

  it("run の保存で例外になると、仕訳も巻き戻る（R9・R19）", () => {
    const t = setupRecurring();
    created(t, { startMonth: "2026-10" });
    t.recurring.insertRun = () => {
      throw new Error("UNIQUE constraint failed: recurring_runs");
    };
    expect(() => postDueRecurring(t.deps, TODAY)).toThrow("UNIQUE");
    expect(t.journalsOf()).toHaveLength(0);
    expect(t.recurring.audits.filter((a) => a.targetType === "recurring_run")).toEqual([]);
  });

  it("登録を recurring_run / create で監査に残す", () => {
    const t = setupRecurring();
    created(t, { startMonth: "2026-10" });
    postDueRecurring(t.deps, TODAY);
    const runAudits = t.recurring.audits.filter((a) => a.targetType === "recurring_run");
    expect(runAudits).toHaveLength(1);
    expect(runAudits[0]).toMatchObject({ action: "create", beforeJson: null });
  });
});

describe("updateRecurring（Acceptance 4）", () => {
  it("変更は次に登録される回から効き、登録済みの仕訳は変わらない", () => {
    const t = setupRecurring();
    const def = created(t, { startMonth: "2026-10" });
    postDueRecurring(t.deps, TODAY);
    const input = t.input({ startMonth: "2026-10" });
    const updated = must(
      updateRecurring(
        t.deps,
        def.id,
        {
          name: input.name,
          dayOfMonth: input.dayOfMonth,
          startMonth: input.startMonth,
          lines: input.lines.map((l) => ({ ...l, amount: 90_000 })),
          version: def.version,
        },
        TODAY,
      ),
    );
    expect(updated.version).toBe(2);
    expect(updated.memo).toBeNull();
    expect(updated.lines.map((l) => l.amount)).toEqual([90_000, 90_000]);
    postDueRecurring(t.deps, "2026-11-25");
    expect(t.journalsOf().map((j) => j.lines.map((l) => l.amount))).toEqual([
      [80_000, 80_000],
      [90_000, 90_000],
    ]);
    expect(t.recurring.audits.map((a) => [a.targetType, a.action])).toContainEqual([
      "recurring_journal",
      "update",
    ]);
  });

  it("version が古いと VERSION_CONFLICT（details に recurringId と currentVersion）", () => {
    const t = setupRecurring();
    const def = created(t);
    const input = t.input();
    const e = errorOf(
      updateRecurring(
        t.deps,
        def.id,
        { ...input, version: 2, confirm: true, lines: input.lines },
        TODAY,
      ),
    );
    expect(e.code).toBe("VERSION_CONFLICT");
    expect(e.details).toEqual({ recurringId: def.id, currentVersion: 1 });
  });

  it("開始月を過去へ広げて登録される回が増えるときは confirm が要る（FR-029）", () => {
    const t = setupRecurring();
    const def = created(t, { startMonth: "2026-10" });
    postDueRecurring(t.deps, TODAY);
    const input = t.input({ startMonth: "2026-08" });
    const body = {
      name: input.name,
      dayOfMonth: input.dayOfMonth,
      startMonth: "2026-08",
      lines: input.lines,
      version: 1,
    };
    const e = errorOf(updateRecurring(t.deps, def.id, body, TODAY));
    expect(e.code).toBe("RECURRING_CONFIRM_REQUIRED");
    expect(e.details).toEqual({ count: 2, months: ["2026-08", "2026-09"] });
    expect(t.recurring.getRecurring(def.id)?.version).toBe(1);
    must(updateRecurring(t.deps, def.id, { ...body, confirm: true }, TODAY));
  });

  it("存在しない定義は RECURRING_NOT_FOUND", () => {
    const t = setupRecurring();
    const input = t.input();
    const e = errorOf(
      updateRecurring(
        t.deps,
        "nope",
        { name: input.name, dayOfMonth: 25, startMonth: "2026-08", lines: input.lines, version: 1 },
        TODAY,
      ),
    );
    expect(e.code).toBe("RECURRING_NOT_FOUND");
  });
});

describe("pauseRecurring / resumeRecurring（Acceptance 5・8）", () => {
  it("停止の version が古いと VERSION_CONFLICT。停止すると version が進む", () => {
    const t = setupRecurring();
    const def = created(t, { startMonth: "2026-10" });
    expect(errorOf(pauseRecurring(t.deps, def.id, { version: 9 })).code).toBe("VERSION_CONFLICT");
    const paused = must(pauseRecurring(t.deps, def.id, { version: 1 }));
    expect(paused).toMatchObject({ status: "paused", version: 2 });
    expect(t.recurring.audits.at(-1)).toMatchObject({ action: "pause", targetId: def.id });
  });

  it("再開で停止の間の月は登録しない（開始月は今日の月に進む）", () => {
    const t = setupRecurring();
    const def = created(t);
    postDueRecurring(t.deps, TODAY); // 8・9・10 月
    must(pauseRecurring(t.deps, def.id, { version: 1 }));
    const resumed = must(resumeRecurring(t.deps, def.id, { version: 2 }, "2026-12-10"));
    expect(resumed).toMatchObject({ status: "active", startMonth: "2026-12", version: 3 });
    expect(postDueRecurring(t.deps, "2026-12-10").posted).toEqual([]);
    const next = postDueRecurring(t.deps, "2026-12-26");
    expect(next.posted.map((p) => p.targetMonth)).toEqual(["2026-12"]);
    // 11 月（停止の間）は登録されていない
    expect(t.recurring.listRuns(def.id).map((r) => r.targetMonth)).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-12",
    ]);
  });

  it("再開で今日以前に登録される回があれば RECURRING_CONFIRM_REQUIRED。confirm で再開できる", () => {
    const t = setupRecurring();
    const def = created(t, { startMonth: "2026-10" });
    postDueRecurring(t.deps, TODAY);
    must(pauseRecurring(t.deps, def.id, { version: 1 }));
    const e = errorOf(
      resumeRecurring(t.deps, def.id, { version: 2, fromMonth: "2026-11" }, "2026-12-26"),
    );
    expect(e.code).toBe("RECURRING_CONFIRM_REQUIRED");
    expect(e.details).toEqual({ count: 2, months: ["2026-11", "2026-12"] });
    expect(t.recurring.getRecurring(def.id)?.status).toBe("paused");
    const resumed = must(
      resumeRecurring(
        t.deps,
        def.id,
        { version: 2, fromMonth: "2026-11", confirm: true },
        "2026-12-26",
      ),
    );
    expect(resumed.startMonth).toBe("2026-11");
  });

  it("再開の月より前の回は対象外。開始月より前の fromMonth は開始月のまま（max）", () => {
    const t = setupRecurring();
    const def = created(t, { startMonth: "2026-10" });
    postDueRecurring(t.deps, TODAY);
    must(pauseRecurring(t.deps, def.id, { version: 1 }));
    const resumed = must(
      resumeRecurring(t.deps, def.id, { version: 2, fromMonth: "2026-01" }, TODAY),
    );
    expect(resumed.startMonth).toBe("2026-10");
  });

  it("再開の月が終了月より後なら VALIDATION（fromMonth）", () => {
    const t = setupRecurring();
    const def = created(t, { endMonth: "2026-10" });
    must(pauseRecurring(t.deps, def.id, { version: 1 }));
    const e = errorOf(resumeRecurring(t.deps, def.id, { version: 2, confirm: true }, "2026-12-01"));
    expect(e.code).toBe("VALIDATION");
    expect(e.details).toMatchObject({ field: "fromMonth" });
  });

  it("停止中でない定義の再開は VALIDATION、存在しない定義は RECURRING_NOT_FOUND", () => {
    const t = setupRecurring();
    const def = created(t, { startMonth: "2026-10" });
    expect(errorOf(resumeRecurring(t.deps, def.id, { version: 1 }, TODAY)).code).toBe("VALIDATION");
    expect(errorOf(resumeRecurring(t.deps, "nope", { version: 1 }, TODAY)).code).toBe(
      "RECURRING_NOT_FOUND",
    );
    expect(errorOf(pauseRecurring(t.deps, "nope", { version: 1 })).code).toBe(
      "RECURRING_NOT_FOUND",
    );
  });
});

describe("skipRecurringRun（FR-027）", () => {
  it("未登録の回を理由つきで skipped にし、以後の判定で登録しない", () => {
    const t = setupRecurring();
    const def = created(t);
    const run = must(skipRecurringRun(t.deps, def.id, "2026-09", { reason: "休業" }, TODAY));
    expect(run).toMatchObject({
      targetMonth: "2026-09",
      status: "skipped",
      journalId: null,
      skipReason: "休業",
    });
    const posted = postDueRecurring(t.deps, TODAY).posted.map((p) => p.targetMonth);
    expect(posted).toEqual(["2026-08", "2026-10"]);
    expect(t.recurring.audits.filter((a) => a.action === "skip")).toEqual([
      expect.objectContaining({
        targetType: "recurring_run",
        targetId: expect.any(String),
        reason: "休業",
      }),
    ]);
  });

  it("blocked の回（締め済み）も飛ばせる", () => {
    const t = setupRecurring();
    const def = created(t);
    t.closeYear(2026);
    must(skipRecurringRun(t.deps, def.id, "2026-08", { reason: "締め済みのため" }, TODAY));
    expect(must(recurringStatus(t.deps, TODAY)).blocked.map((b) => b.targetMonth)).toEqual([
      "2026-09",
      "2026-10",
    ]);
  });

  it("対象外の月（未来・登録済み・飛ばし済み・開始月より前・終了月より後）は VALIDATION（month）", () => {
    const t = setupRecurring();
    const def = created(t, { endMonth: "2026-09" });
    const skip = (month: string) =>
      skipRecurringRun(t.deps, def.id, month, { reason: "理由" }, "2026-10-26");
    const expectInvalid = (month: string) => {
      const e = errorOf(skip(month));
      expect(e.code).toBe("VALIDATION");
      expect(e.details).toMatchObject({ field: "month" });
    };
    expectInvalid("2026-07"); // 開始月より前
    expectInvalid("2026-10"); // 終了月より後
    expectInvalid("2026-13"); // 月の形式が不正
    expectInvalid("abc");
    must(skip("2026-08"));
    expectInvalid("2026-08"); // 飛ばし済み
    postDueRecurring(t.deps, "2026-10-26");
    expectInvalid("2026-09"); // 登録済み

    const t2 = setupRecurring();
    const def2 = created(t2);
    const e = errorOf(skipRecurringRun(t2.deps, def2.id, "2026-11", { reason: "理由" }, TODAY));
    expect(e.code).toBe("VALIDATION"); // 予定日が今日より後
    expect(e.details).toMatchObject({ field: "month" });
  });

  it("空の理由は REASON_REQUIRED", () => {
    const t = setupRecurring();
    const def = created(t);
    expect(errorOf(skipRecurringRun(t.deps, def.id, "2026-09", { reason: "  " }, TODAY)).code).toBe(
      "REASON_REQUIRED",
    );
  });
});

describe("recurringStatus / acknowledgeRuns（FR-028、Acceptance 7）", () => {
  it("未確認の登録の回を件数と一覧で返し、確認すると消える", () => {
    const t = setupRecurring();
    const def = created(t);
    postDueRecurring(t.deps, TODAY);
    const status = must(recurringStatus(t.deps, TODAY));
    expect(status.blocked).toEqual([]);
    expect(
      status.unacknowledged.map((u) => [u.recurringId, u.name, u.targetMonth, u.journal.date]),
    ).toEqual([
      [def.id, "家賃", "2026-08", "2026-08-25"],
      [def.id, "家賃", "2026-09", "2026-09-25"],
      [def.id, "家賃", "2026-10", "2026-10-25"],
    ]);
    expect(status.unacknowledged[0]?.journal).toMatchObject({ status: "active" });

    const [a, b] = status.unacknowledged;
    must(acknowledgeRuns(t.deps, [a?.runId ?? "", b?.runId ?? ""]));
    const after = must(recurringStatus(t.deps, TODAY));
    expect(after.unacknowledged.map((u) => u.targetMonth)).toEqual(["2026-10"]);
    expect(t.recurring.audits.filter((x) => x.action === "acknowledge")).toHaveLength(2);

    // 確認済みの回をもう一度確認しても失敗しない（監査も増えない）
    must(acknowledgeRuns(t.deps, [a?.runId ?? ""]));
    expect(t.recurring.audits.filter((x) => x.action === "acknowledge")).toHaveLength(2);
  });

  it("存在しない回の ID は VALIDATION（runIds）で、何も確認しない", () => {
    const t = setupRecurring();
    created(t, { startMonth: "2026-10" });
    postDueRecurring(t.deps, TODAY);
    const [u] = must(recurringStatus(t.deps, TODAY)).unacknowledged;
    const e = errorOf(acknowledgeRuns(t.deps, [u?.runId ?? "", "nope"]));
    expect(e.code).toBe("VALIDATION");
    expect(e.details).toMatchObject({ field: "runIds" });
    expect(must(recurringStatus(t.deps, TODAY)).unacknowledged).toHaveLength(1);
  });

  it("blocked の JOURNAL_INVALID は元のコードを details.code に持つ", () => {
    const t = setupRecurring();
    created(t);
    t.masters.replaceTaxSettings([
      {
        id: "ts-1",
        effectiveFrom: "2026-09-01",
        taxpayerStatus: "general",
        accountingMethod: "tax_included",
      },
    ]);
    const status = must(recurringStatus(t.deps, TODAY));
    expect(status.blocked).toEqual([
      {
        recurringId: expect.any(String),
        name: "家賃",
        targetMonth: "2026-08",
        date: "2026-08-25",
        reason: "JOURNAL_INVALID",
        details: { code: "TAX_SETTING_GAP" },
      },
    ]);
  });
});

describe("listRecurring / getRecurringDetail", () => {
  it("一覧は次の予定日と登録済みの件数を持つ。停止中の次の予定日は null", () => {
    const t = setupRecurring();
    const def = created(t);
    postDueRecurring(t.deps, TODAY);
    const [row] = must(listRecurring(t.deps, TODAY));
    expect(row).toMatchObject({ id: def.id, nextDate: "2026-11-25", postedCount: 3 });
    must(pauseRecurring(t.deps, def.id, { version: 1 }));
    expect(must(listRecurring(t.deps, TODAY))[0]?.nextDate).toBeNull();
  });

  it("終了月を過ぎた定義の次の予定日は null", () => {
    const t = setupRecurring();
    created(t, { endMonth: "2026-10" });
    expect(must(listRecurring(t.deps, "2026-10-26"))[0]?.nextDate).toBeNull();
  });

  it("詳細は回（登録・飛ばした）と blocked を返す", () => {
    const t = setupRecurring();
    const def = created(t);
    must(skipRecurringRun(t.deps, def.id, "2026-08", { reason: "休業" }, TODAY));
    postDueRecurring(t.deps, "2026-09-26");
    t.closeYear(2026);
    const detail = must(getRecurringDetail(t.deps, def.id, TODAY));
    expect(detail.recurring.id).toBe(def.id);
    expect(detail.runs.map((r) => [r.targetMonth, r.status])).toEqual([
      ["2026-08", "skipped"],
      ["2026-09", "posted"],
    ]);
    expect(detail.blocked.map((b) => [b.targetMonth, b.reason])).toEqual([
      ["2026-10", "PERIOD_CLOSED"],
    ]);
    expect(errorOf(getRecurringDetail(t.deps, "nope", TODAY)).code).toBe("RECURRING_NOT_FOUND");
  });
});
