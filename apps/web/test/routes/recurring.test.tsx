import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/queries";
import { Route as DetailRoute } from "@/routes/e/$entityId/recurring/$recurringId";
import { Route as ListRoute } from "@/routes/e/$entityId/recurring/index";
import { Route as NewRoute } from "@/routes/e/$entityId/recurring/new";
import { Route as LayoutRoute } from "@/routes/e/$entityId/route";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 005 US3: 定期仕訳の画面と、事業体の画面の上部の知らせ（FR-023〜029。H:§5）

const BASE = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (n: number, name: string, over: Partial<Account> = {}): Account => ({
  id: uuid(n),
  code: String(n),
  name,
  category: "asset",
  normalSide: "debit",
  reportSection: "BS_ASSET",
  reportLine: null,
  sortOrder: n,
  isSystem: false,
  isActive: true,
  ...over,
});
const BANK = account(1020, "普通預金");
const RENT = account(6010, "地代家賃", {
  category: "expense",
  reportSection: "PL_EXPENSE",
});
const ACCOUNTS = [BANK, RENT];

const TAX_CATEGORIES = [
  { code: "OUT_OF_SCOPE", name: "対象外", kind: null },
  { code: "PURCHASE_10", name: "課税仕入 10%", kind: "purchase" },
];

const RECURRING_ID = "00000000-0000-4000-8000-0000000000a1";
const line = (lineNo: number, side: "debit" | "credit", accountId: string) => ({
  lineNo,
  side,
  accountId,
  subAccountId: null,
  amount: 80_000,
  taxCategory: null,
  partnerId: null,
  description: null,
});
const RECURRING = {
  id: RECURRING_ID,
  name: "事務所の家賃",
  memo: null,
  dayOfMonth: 25,
  startMonth: "2026-08",
  endMonth: null,
  status: "active",
  version: 1,
  lines: [line(1, "debit", RENT.id), line(2, "credit", BANK.id)],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const VIEW = { ...RECURRING, nextDate: "2026-11-25", postedCount: 3 };

const journalRef = (n: number, date: string) => ({
  id: uuid(9000 + n),
  journalNo: n,
  date,
  status: "active",
});

const masterRoutes = {
  [`GET ${BASE}/accounts`]: () => ok({ accounts: ACCOUNTS }),
  [`GET ${BASE}/partners`]: () => ok({ partners: [] }),
  [`GET ${BASE}/tags`]: () => ok({ tags: [] }),
  [`GET ${BASE}/tax-settings`]: () => ok({ taxSettings: [] }),
  [`GET ${BASE}/tax-categories`]: () => ok({ taxCategories: TAX_CATEGORIES, taxRates: [] }),
  [`GET ${BASE}/accounts/${BANK.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
  [`GET ${BASE}/accounts/${RENT.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+09:00"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const posts = (calls: ApiCall[], path: string, method = "POST") =>
  calls.filter((c) => c.method === method && c.path === `${BASE}${path}`);

async function fillNewForm(u: ReturnType<typeof userEvent.setup>, day = "25") {
  await u.type(await screen.findByLabelText("名前"), "事務所の家賃");
  await u.selectOptions(screen.getByLabelText("毎月の予定日"), day);
  fireEvent.change(screen.getByLabelText("開始月"), { target: { value: "2026-08" } });
  await u.selectOptions(screen.getByLabelText("1行目の勘定科目"), "地代家賃");
  await u.type(screen.getByLabelText("1行目の金額"), "80000");
  await u.selectOptions(screen.getByLabelText("2行目の貸借"), "貸方");
  await u.selectOptions(screen.getByLabelText("2行目の勘定科目"), "普通預金");
  await u.type(screen.getByLabelText("2行目の金額"), "80000");
}

describe("定期仕訳の作成（FR-023・029）", () => {
  it("予定日は 1〜28 と「末日」（= 31）から選ぶ。開始月の既定は今日の月", async () => {
    mockApi(masterRoutes);
    renderRoute(NewRoute, { path: "/e/$entityId/recurring/new", url: "/e/e1/recurring/new" });

    const day = await screen.findByLabelText("毎月の予定日");
    const options = within(day).getAllByRole("option");
    expect(options).toHaveLength(29);
    expect(options[0]).toHaveTextContent("1 日");
    expect(options[27]).toHaveTextContent("28 日");
    expect(options[28]).toHaveTextContent("末日");
    expect(options[28]).toHaveValue("31");
    expect(screen.getByLabelText("開始月")).toHaveValue("2026-10");
  });

  it("保存で 409 の確認が返ったら件数と月を示し、確認すると confirm つきで再送して詳細へ進む", async () => {
    const months = ["2026-08", "2026-09", "2026-10"];
    let attempt = 0;
    const calls = mockApi({
      ...masterRoutes,
      [`POST ${BASE}/recurring-journals`]: (call) => {
        attempt += 1;
        if ((call.body as { confirm?: boolean }).confirm !== true) {
          return apiError(409, "RECURRING_CONFIRM_REQUIRED", "確認が必要です", {
            count: months.length,
            months,
          });
        }
        return ok(
          { recurring: RECURRING, posted: months.map((m, i) => journalRef(i + 1, `${m}-25`)) },
          201,
        );
      },
    });
    const u = userEvent.setup();
    const { router } = renderRoute(NewRoute, {
      path: "/e/$entityId/recurring/new",
      url: "/e/e1/recurring/new",
    });
    await fillNewForm(u);
    await u.click(screen.getByRole("button", { name: "登録する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("3 件");
    expect(alert).toHaveTextContent("2026-08");
    expect(alert).toHaveTextContent("2026-10");
    expect(posts(calls, "/recurring-journals")).toHaveLength(1);
    expect(posts(calls, "/recurring-journals")[0]?.body).toEqual({
      name: "事務所の家賃",
      dayOfMonth: 25,
      startMonth: "2026-08",
      lines: [
        { side: "debit", accountId: RENT.id, amount: 80_000 },
        { side: "credit", accountId: BANK.id, amount: 80_000 },
      ],
    });

    await u.click(screen.getByRole("button", { name: "確認して登録する" }));
    await waitFor(() => expect(attempt).toBe(2));
    expect(posts(calls, "/recurring-journals")[1]?.body).toMatchObject({
      name: "事務所の家賃",
      confirm: true,
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/e/e1/recurring/${RECURRING_ID}`),
    );
  });

  it("「末日」は dayOfMonth: 31 で送る。終了月が開始月より前なら送らずに知らせる", async () => {
    const calls = mockApi({
      ...masterRoutes,
      [`POST ${BASE}/recurring-journals`]: () =>
        ok({ recurring: { ...RECURRING, dayOfMonth: 31 }, posted: [] }, 201),
    });
    const u = userEvent.setup();
    renderRoute(NewRoute, { path: "/e/$entityId/recurring/new", url: "/e/e1/recurring/new" });
    await fillNewForm(u, "31");

    fireEvent.change(screen.getByLabelText("終了月"), { target: { value: "2026-07" } });
    await u.click(screen.getByRole("button", { name: "登録する" }));
    expect(await screen.findByText("終了月は開始月以降にしてください")).toBeInTheDocument();
    expect(posts(calls, "/recurring-journals")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("終了月"), { target: { value: "" } });
    await u.click(screen.getByRole("button", { name: "登録する" }));
    await waitFor(() => expect(posts(calls, "/recurring-journals")).toHaveLength(1));
    expect(posts(calls, "/recurring-journals")[0]?.body).toMatchObject({ dayOfMonth: 31 });
  });

  it("名前が空のときは送らずに知らせる", async () => {
    const calls = mockApi(masterRoutes);
    const u = userEvent.setup();
    renderRoute(NewRoute, { path: "/e/$entityId/recurring/new", url: "/e/e1/recurring/new" });
    await fillNewForm(u);
    await u.clear(screen.getByLabelText("名前"));
    await u.click(screen.getByRole("button", { name: "登録する" }));
    expect(await screen.findByText("名前を入力してください")).toBeInTheDocument();
    expect(posts(calls, "/recurring-journals")).toHaveLength(0);
  });
});

describe("定期仕訳の一覧", () => {
  it("名前・予定日・期間・状態・次の予定日・登録済みの件数を示す", async () => {
    mockApi({
      [`GET ${BASE}/recurring-journals`]: () =>
        ok({
          recurring: [
            VIEW,
            {
              ...VIEW,
              id: uuid(2),
              name: "月末の保険料",
              dayOfMonth: 31,
              status: "paused",
              nextDate: null,
              postedCount: 0,
              endMonth: "2027-03",
            },
          ],
        }),
    });
    renderRoute(ListRoute, { path: "/e/$entityId/recurring/", url: "/e/e1/recurring/" });

    const row = (await screen.findByRole("link", { name: "事務所の家賃" })).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("毎月 25 日")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("2026-08 から")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("有効")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("2026-11-25")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("3 件")).toBeInTheDocument();

    const paused = screen.getByRole("link", { name: "月末の保険料" }).closest("tr");
    expect(within(paused as HTMLElement).getByText("毎月末日")).toBeInTheDocument();
    expect(within(paused as HTMLElement).getByText("2026-08 〜 2027-03")).toBeInTheDocument();
    expect(within(paused as HTMLElement).getByText("停止中")).toBeInTheDocument();
  });

  it("定義がないときは空の知らせと、作る画面へのリンクを出す", async () => {
    mockApi({});
    renderRoute(ListRoute, { path: "/e/$entityId/recurring/", url: "/e/e1/recurring/" });
    expect(await screen.findByText("定期仕訳はまだありません。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "定期仕訳を作る" })).toHaveAttribute(
      "href",
      "/e/e1/recurring/new",
    );
  });
});

describe("事業体の画面の上部の知らせ（FR-027・028）", () => {
  const STATUS = {
    unacknowledged: [
      {
        runId: uuid(101),
        recurringId: RECURRING_ID,
        name: "事務所の家賃",
        targetMonth: "2026-08",
        journal: journalRef(1, "2026-08-25"),
      },
      {
        runId: uuid(102),
        recurringId: RECURRING_ID,
        name: "事務所の家賃",
        targetMonth: "2026-09",
        journal: journalRef(2, "2026-09-25"),
      },
    ],
    blocked: [
      {
        recurringId: RECURRING_ID,
        name: "事務所の家賃",
        targetMonth: "2026-10",
        date: "2026-10-25",
        reason: "PERIOD_CLOSED",
      },
      {
        recurringId: uuid(2),
        name: "ソフトの利用料",
        targetMonth: "2026-10",
        date: "2026-10-20",
        reason: "JOURNAL_INVALID",
        details: { code: "TAX_SETTING_GAP" },
      },
    ],
  };

  const renderLayout = () => renderRoute(LayoutRoute, { path: "/e/$entityId", url: "/e/e1" });

  it("知らせがなければ何も出さない", async () => {
    const calls = mockApi({ "GET /api/entities": () => ok({ entities: [] }) });
    renderLayout();
    await waitFor(() =>
      expect(calls.some((c) => c.path === `${BASE}/recurring-journals/status`)).toBe(true),
    );
    expect(screen.queryByRole("region", { name: "定期仕訳の知らせ" })).not.toBeInTheDocument();
  });

  it("未確認の自動登録と登録できなかった回を示し、「確認した」で全件を確認済みにする", async () => {
    let acknowledged = false;
    const calls = mockApi({
      "GET /api/entities": () => ok({ entities: [] }),
      [`GET ${BASE}/recurring-journals/status`]: () =>
        ok(acknowledged ? { unacknowledged: [], blocked: STATUS.blocked } : STATUS),
      [`POST ${BASE}/recurring-journals/acknowledge`]: () => {
        acknowledged = true;
        return { status: 204, body: undefined };
      },
    });
    const u = userEvent.setup();
    renderLayout();

    const notice = await screen.findByRole("region", { name: "定期仕訳の知らせ" });
    expect(notice).toHaveTextContent("自動で登録した仕訳が 2 件あります");
    expect(within(notice).getByRole("link", { name: "仕訳 No.1" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${uuid(9001)}`,
    );
    expect(notice).toHaveTextContent("事務所の家賃（2026-09）");
    expect(notice).toHaveTextContent("登録できなかった回が 2 件あります");
    // 理由の文言。JOURNAL_INVALID は元のコードで案内する
    expect(notice).toHaveTextContent("締め済みの会計期間");
    expect(notice).toHaveTextContent("消費税の設定");

    await u.click(within(notice).getByRole("button", { name: "確認した" }));
    await waitFor(() => expect(posts(calls, "/recurring-journals/acknowledge")).toHaveLength(1));
    expect(posts(calls, "/recurring-journals/acknowledge")[0]?.body).toEqual({
      runIds: [uuid(101), uuid(102)],
    });
    await waitFor(() => expect(notice).not.toHaveTextContent("自動で登録した仕訳"));
    // 登録できなかった回は確認しても残る
    expect(notice).toHaveTextContent("登録できなかった回が 2 件あります");
  });

  it("「この回は登録しない」は理由を付けて POST し、理由が空なら REASON_REQUIRED を示す", async () => {
    let skipped = false;
    const calls = mockApi({
      "GET /api/entities": () => ok({ entities: [] }),
      [`GET ${BASE}/recurring-journals/status`]: () =>
        ok({
          unacknowledged: [],
          blocked: skipped ? STATUS.blocked.slice(1) : STATUS.blocked,
        }),
      [`POST ${BASE}/recurring-journals/${RECURRING_ID}/runs/2026-10/skip`]: (call) => {
        if ((call.body as { reason: string }).reason.trim() === "") {
          return apiError(422, "REASON_REQUIRED", "理由を入力してください");
        }
        skipped = true;
        return ok({
          run: {
            targetMonth: "2026-10",
            status: "skipped",
            journalId: null,
            skipReason: "今月は支払わない",
            createdAt: "2026-10-26T01:00:00.000Z",
          },
        });
      },
    });
    const u = userEvent.setup();
    renderLayout();

    const notice = await screen.findByRole("region", { name: "定期仕訳の知らせ" });
    expect(notice).not.toHaveTextContent("自動で登録した仕訳");
    const item = within(notice)
      .getByText("（2026-10、予定日 2026-10-25）")
      .closest("li") as HTMLElement;
    await u.click(within(item).getByRole("button", { name: "この回は登録しない" }));
    await u.click(within(item).getByRole("button", { name: "登録しない" }));
    expect(await within(item).findByText("理由を入力してください")).toBeInTheDocument();

    await u.type(within(item).getByLabelText("理由"), "今月は支払わない");
    await u.click(within(item).getByRole("button", { name: "登録しない" }));
    await waitFor(() => expect(notice).not.toHaveTextContent("締め済みの会計期間"));
    const path = `/recurring-journals/${RECURRING_ID}/runs/2026-10/skip`;
    expect(posts(calls, path).at(-1)?.body).toEqual({ reason: "今月は支払わない" });
    expect(notice).toHaveTextContent("ソフトの利用料");
  });
});

describe("定期仕訳の詳細（停止・再開・登録の記録）", () => {
  const detail = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    recurring: { ...RECURRING, ...over },
    runs: [
      {
        targetMonth: "2026-09",
        status: "posted",
        journalId: uuid(9002),
        skipReason: null,
        createdAt: "2026-09-25T00:00:00.000Z",
      },
      {
        targetMonth: "2026-08",
        status: "skipped",
        journalId: null,
        skipReason: "この月は支払いなし",
        createdAt: "2026-08-25T00:00:00.000Z",
      },
    ],
    blocked: [],
    ...extra,
  });

  const renderDetail = () =>
    renderRoute(DetailRoute, {
      path: "/e/$entityId/recurring/$recurringId",
      url: `/e/e1/recurring/${RECURRING_ID}`,
    });

  it("登録の記録（登録済みの仕訳・登録しなかった回の理由）を示す", async () => {
    mockApi({
      ...masterRoutes,
      [`GET ${BASE}/recurring-journals/${RECURRING_ID}`]: () => ok(detail()),
    });
    renderDetail();

    const runs = await screen.findByRole("table", { name: "登録の記録" });
    const posted = within(runs).getByText("2026-09").closest("tr") as HTMLElement;
    expect(posted).toHaveTextContent("登録済み");
    expect(within(posted).getByRole("link", { name: "仕訳を開く" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${uuid(9002)}`,
    );
    const skipped = within(runs).getByText("2026-08").closest("tr") as HTMLElement;
    expect(skipped).toHaveTextContent("登録しない");
    expect(skipped).toHaveTextContent("この月は支払いなし");
  });

  it("内容を直して保存すると version つきで PUT する", async () => {
    const calls = mockApi({
      ...masterRoutes,
      [`GET ${BASE}/recurring-journals/${RECURRING_ID}`]: () => ok(detail()),
      [`PUT ${BASE}/recurring-journals/${RECURRING_ID}`]: () =>
        ok({ recurring: { ...RECURRING, version: 2 }, posted: [] }),
    });
    const u = userEvent.setup();
    renderDetail();

    const name = await screen.findByLabelText("名前");
    await waitFor(() => expect(name).toHaveValue("事務所の家賃"));
    expect(screen.getByLabelText("毎月の予定日")).toHaveValue("25");
    expect(screen.getByLabelText("開始月")).toHaveValue("2026-08");
    expect(screen.getByLabelText("1行目の金額")).toHaveValue("80000");
    await u.clear(name);
    await u.type(name, "事務所の家賃（改定）");
    await u.click(screen.getByRole("button", { name: "保存する" }));

    await waitFor(() =>
      expect(posts(calls, `/recurring-journals/${RECURRING_ID}`, "PUT")).toHaveLength(1),
    );
    expect(posts(calls, `/recurring-journals/${RECURRING_ID}`, "PUT")[0]?.body).toEqual({
      name: "事務所の家賃（改定）",
      dayOfMonth: 25,
      startMonth: "2026-08",
      version: 1,
      lines: [
        { side: "debit", accountId: RENT.id, amount: 80_000 },
        { side: "credit", accountId: BANK.id, amount: 80_000 },
      ],
    });
  });

  it("停止は version を送る。停止中は「再開」だけが出る", async () => {
    let paused = false;
    const calls = mockApi({
      ...masterRoutes,
      [`GET ${BASE}/recurring-journals/${RECURRING_ID}`]: () =>
        ok(detail(paused ? { status: "paused", version: 2 } : {})),
      [`POST ${BASE}/recurring-journals/${RECURRING_ID}/pause`]: () => {
        paused = true;
        return ok({ recurring: { ...RECURRING, status: "paused", version: 2 } });
      },
    });
    const u = userEvent.setup();
    renderDetail();

    await u.click(await screen.findByRole("button", { name: "停止する" }));
    await waitFor(() =>
      expect(posts(calls, `/recurring-journals/${RECURRING_ID}/pause`)).toHaveLength(1),
    );
    expect(posts(calls, `/recurring-journals/${RECURRING_ID}/pause`)[0]?.body).toEqual({
      version: 1,
    });
    expect(await screen.findByRole("button", { name: "再開する" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止する" })).not.toBeInTheDocument();
  });

  it("再開は再開の月（既定は今日の月）を送り、409 の確認で件数を示して confirm つきで再送する", async () => {
    let resumed = false;
    const calls = mockApi({
      ...masterRoutes,
      [`GET ${BASE}/recurring-journals/${RECURRING_ID}`]: () =>
        ok(detail(resumed ? { version: 3 } : { status: "paused", version: 2 })),
      [`POST ${BASE}/recurring-journals/${RECURRING_ID}/resume`]: (call) => {
        if ((call.body as { confirm?: boolean }).confirm !== true) {
          return apiError(409, "RECURRING_CONFIRM_REQUIRED", "確認が必要です", {
            count: 1,
            months: ["2026-10"],
          });
        }
        resumed = true;
        return ok({
          recurring: { ...RECURRING, version: 3 },
          posted: [journalRef(5, "2026-10-25")],
        });
      },
    });
    const u = userEvent.setup();
    renderDetail();

    const month = await screen.findByLabelText("再開の月");
    expect(month).toHaveValue("2026-10");
    await u.click(screen.getByRole("button", { name: "再開する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 件");
    expect(alert).toHaveTextContent("2026-10");
    const path = `/recurring-journals/${RECURRING_ID}/resume`;
    expect(posts(calls, path)[0]?.body).toEqual({ version: 2, fromMonth: "2026-10" });

    await u.click(screen.getByRole("button", { name: "確認して再開する" }));
    await waitFor(() => expect(posts(calls, path)).toHaveLength(2));
    expect(posts(calls, path)[1]?.body).toEqual({
      version: 2,
      fromMonth: "2026-10",
      confirm: true,
    });
    expect(await screen.findByRole("button", { name: "停止する" })).toBeInTheDocument();
  });

  it("登録できなかった回を示し、理由を付けて登録しない回にできる", async () => {
    const calls = mockApi({
      ...masterRoutes,
      [`GET ${BASE}/recurring-journals/${RECURRING_ID}`]: () =>
        ok(
          detail(
            {},
            {
              blocked: [
                {
                  recurringId: RECURRING_ID,
                  name: "事務所の家賃",
                  targetMonth: "2026-10",
                  date: "2026-10-25",
                  reason: "ACCOUNT_INACTIVE",
                },
              ],
            },
          ),
        ),
      [`POST ${BASE}/recurring-journals/${RECURRING_ID}/runs/2026-10/skip`]: () =>
        ok({
          run: {
            targetMonth: "2026-10",
            status: "skipped",
            journalId: null,
            skipReason: "不要",
            createdAt: "2026-10-26T01:00:00.000Z",
          },
        }),
    });
    const u = userEvent.setup();
    renderDetail();

    const blocked = await screen.findByRole("region", { name: "登録できなかった回" });
    expect(blocked).toHaveTextContent("2026-10");
    expect(blocked).toHaveTextContent("使用停止");
    await u.click(within(blocked).getByRole("button", { name: "この回は登録しない" }));
    await u.type(within(blocked).getByLabelText("理由"), "不要");
    await u.click(within(blocked).getByRole("button", { name: "登録しない" }));
    await waitFor(() =>
      expect(posts(calls, `/recurring-journals/${RECURRING_ID}/runs/2026-10/skip`)).toHaveLength(1),
    );
    expect(posts(calls, `/recurring-journals/${RECURRING_ID}/runs/2026-10/skip`)[0]?.body).toEqual({
      reason: "不要",
    });
  });
});
