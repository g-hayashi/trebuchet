import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/journals/index";
import { advance, fakeClockUser, useFakeClock } from "../fake-timers";
import { assetAccount, ENTITY, uuid } from "../fixtures";
import { type ApiCall, type ApiReply, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// src の定数（journals/index.tsx の検索条件の反映待ち 300ms）。export されていない
const SEARCH_DEBOUNCE_MS = 300;

const bank = assetAccount(1020, "普通預金");
const owner = assetAccount(1900, "事業主貸");
const receivable = assetAccount(1100, "売掛金");
const sales = assetAccount(4010, "売上高", { isActive: false });

type LineSpec = [side: "debit" | "credit", accountId: string, amount: number, description?: string];

const journal = (
  journalNo: number,
  date: string,
  lines: LineSpec[],
  rest: { memo?: string; status?: "active" | "voided" } = {},
) => ({
  id: uuid(9000 + journalNo),
  journalNo,
  date,
  fiscalPeriodId: "p2026",
  memo: rest.memo ?? null,
  status: rest.status ?? "active",
  correctsJournalId: null,
  source: "manual",
  version: 1,
  createdAt: "2026-10-31T09:00:00.000Z",
  updatedAt: "2026-10-31T09:00:00.000Z",
  lines: lines.map(([side, accountId, amount, description], i) => ({
    id: uuid(9100 + journalNo * 10 + i),
    lineNo: i + 1,
    side,
    accountId,
    subAccountId: null,
    amount,
    taxCategory: "OUT_OF_SCOPE",
    taxAmount: 0,
    partnerId: null,
    description: description ?? null,
    tagIds: [],
  })),
});

const partnerA = { id: uuid(7001), name: "取引先A", honorific: "御中", memo: null, isActive: true };
const tagA = { id: uuid(8001), name: "定期" };

function mockListApi(
  journals: (call: ApiCall) => ApiReply | Promise<ApiReply>,
  extra: Parameters<typeof mockApi>[0] = {},
) {
  return mockApi({
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [bank, owner, receivable, sales] }),
    [`GET ${ENTITY}/partners`]: () => ok({ partners: [partnerA] }),
    [`GET ${ENTITY}/tags`]: () => ok({ tags: [tagA] }),
    [`GET ${ENTITY}/journals`]: journals,
    ...extra,
  });
}

function renderJournals(url = "/e/e1/journals") {
  return renderRoute(Route, { path: "/e/$entityId/journals/", url });
}

const journalCalls = (calls: ApiCall[]) => calls.filter((c) => c.path === `${ENTITY}/journals`);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  useFakeClock("2026-10-31T12:00:00+09:00");
});

describe("仕訳の一覧（US2）", () => {
  it("API の順（新しい順）に、日付・仕訳番号・借方と貸方の科目と金額・摘要を表示する", async () => {
    mockListApi(() =>
      ok({
        journals: [
          journal(
            3,
            "2026-11-30",
            [
              ["debit", bank.id, 487_037],
              ["debit", owner.id, 7963, "源泉所得税"],
              ["credit", receivable.id, 495_000],
            ],
            { memo: "10月分の入金" },
          ),
          journal(1, "2026-10-31", [
            ["debit", receivable.id, 495_000, "10月分"],
            ["credit", sales.id, 495_000],
          ]),
          journal(
            2,
            "2026-10-01",
            [
              ["debit", receivable.id, 1000],
              ["credit", sales.id, 1000],
            ],
            { status: "voided" },
          ),
        ],
        nextCursor: null,
      }),
    );
    renderJournals();

    const table = await screen.findByRole("table", { name: "仕訳の一覧" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[1]?.textContent)).toEqual([
      "3",
      "1",
      "2",
    ]);
    const first = rows[0];
    if (!first) throw new Error("行がない");
    expect(first).toHaveTextContent("2026-11-30");
    expect(first).toHaveTextContent("普通預金487,037");
    expect(first).toHaveTextContent("事業主貸7,963");
    expect(first).toHaveTextContent("売掛金495,000");
    expect(first).toHaveTextContent("10月分の入金");
    expect(first).toHaveTextContent("源泉所得税");
    // 使用停止の科目でも名称を表示する
    expect(rows[1]).toHaveTextContent("売上高495,000");
    expect(rows[2]).toHaveTextContent("取消済み");
    expect(rows[1]).not.toHaveTextContent("取消済み");
  });

  it("仕訳がなければその旨を表示し、入力画面へのリンクを出す", async () => {
    mockListApi(() => ok({ journals: [], nextCursor: null }));
    renderJournals();

    expect(await screen.findByText(/仕訳がありません/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "仕訳を入力" })).toHaveAttribute(
      "href",
      "/e/e1/journals/new",
    );
  });
});

describe("仕訳の検索（US3, FR-023）", () => {
  const rows = () =>
    within(screen.getByRole("table", { name: "仕訳の一覧" }))
      .getAllByRole("row")
      .slice(1);
  const j = (n: number, date: string) =>
    journal(n, date, [
      ["debit", receivable.id, n * 1000],
      ["credit", sales.id, n * 1000],
    ]);

  it("URL の検索パラメータを条件として API に渡し、フォームに表示する", async () => {
    const calls = mockListApi(() => ok({ journals: [j(1, "2026-06-15")], nextCursor: null }));
    renderJournals(
      `/e/e1/journals?dateFrom=2026-06-01&dateTo=2026-06-30&amountMin=100000&partnerId=${partnerA.id}&includeVoided=true`,
    );

    await screen.findByRole("table", { name: "仕訳の一覧" });
    expect(journalCalls(calls).at(-1)?.query).toEqual({
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
      amountMin: "100000",
      partnerId: partnerA.id,
      includeVoided: "true",
    });
    const form = screen.getByRole("search", { name: "仕訳の検索" });
    expect(within(form).getByLabelText("日付（から）")).toHaveValue("2026-06-01");
    expect(within(form).getByLabelText("日付（まで）")).toHaveValue("2026-06-30");
    expect(within(form).getByLabelText("金額（以上）")).toHaveValue("100000");
    await waitFor(() => expect(within(form).getByLabelText("取引先")).toHaveValue(partnerA.id));
    expect(within(form).getByLabelText("取消済みも表示")).toBeChecked();
  });

  it("US3-4: 条件を組み合わせて検索すると URL に残し、その条件で API を呼ぶ。クリアで条件を外す", async () => {
    const calls = mockListApi(() => ok({ journals: [j(1, "2026-06-15")], nextCursor: null }));
    const u = fakeClockUser();
    const { router } = renderJournals();
    const form = await screen.findByRole("search", { name: "仕訳の検索" });
    await screen.findByRole("table", { name: "仕訳の一覧" });
    expect(journalCalls(calls).at(-1)?.query).toEqual({});

    await u.type(within(form).getByLabelText("日付（から）"), "2026-06-01");
    await u.type(within(form).getByLabelText("金額（以上）"), "１００,０００");
    await u.type(within(form).getByLabelText("金額（以下）"), "400000");
    await waitFor(() =>
      expect(within(form).getByRole("option", { name: "売掛金" })).toBeInTheDocument(),
    );
    await u.selectOptions(within(form).getByLabelText("勘定科目"), "売掛金");
    await u.selectOptions(within(form).getByLabelText("タグ"), "定期");
    await u.type(within(form).getByLabelText("摘要・メモ"), "10月分");

    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        dateFrom: "2026-06-01",
        amountMin: 100000,
        amountMax: 400000,
        accountId: receivable.id,
        tagId: tagA.id,
        q: "10月分",
      }),
    );
    await waitFor(() =>
      expect(journalCalls(calls).at(-1)?.query).toEqual({
        dateFrom: "2026-06-01",
        amountMin: "100000",
        amountMax: "400000",
        accountId: receivable.id,
        tagId: tagA.id,
        q: "10月分",
      }),
    );

    await u.click(within(form).getByRole("button", { name: "条件をクリア" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(within(form).getByLabelText("日付（から）")).toHaveValue(""));
  });

  it("金額が数値でなければ検索せず、項目にエラーを表示する", async () => {
    mockListApi(() => ok({ journals: [], nextCursor: null }));
    const u = fakeClockUser();
    const { router } = renderJournals();
    const form = await screen.findByRole("search", { name: "仕訳の検索" });
    const min = within(form).getByLabelText("金額（以上）");
    await u.type(min, "abc");

    await waitFor(() => expect(min).toHaveAttribute("aria-invalid", "true"));
    expect(router.state.location.search).toEqual({});
  });

  it("次のページがあれば「さらに読み込む」で cursor を付けて続きを読み込む", async () => {
    const calls = mockListApi((call) =>
      call.query.cursor === "2026-10-04_4"
        ? ok({ journals: [j(3, "2026-10-03")], nextCursor: null })
        : ok({ journals: [j(5, "2026-10-05"), j(4, "2026-10-04")], nextCursor: "2026-10-04_4" }),
    );
    const u = fakeClockUser();
    renderJournals(`/e/e1/journals?accountId=${receivable.id}`);

    await screen.findByRole("table", { name: "仕訳の一覧" });
    expect(rows()).toHaveLength(2);
    await u.click(screen.getByRole("button", { name: "さらに読み込む" }));

    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(journalCalls(calls).at(-1)?.query).toEqual({
      accountId: receivable.id,
      cursor: "2026-10-04_4",
    });
    expect(screen.queryByRole("button", { name: "さらに読み込む" })).not.toBeInTheDocument();
  });

  it("各行のボタンをキーボードで開き、その場で訂正を開始できる", async () => {
    const entry = j(3, "2026-10-03");
    mockListApi(
      () => ok({ journals: [entry], nextCursor: null, summary: { count: 1, amount: 3000 } }),
      {
        [`GET ${ENTITY}/journals/${entry.id}`]: () =>
          ok({ journal: entry, correctsJournal: null, correctingJournals: [] }),
        [`GET ${ENTITY}/journals/${entry.id}/history`]: () => ok({ history: [] }),
        [`GET ${ENTITY}/tax-settings`]: () => ok({ taxSettings: [] }),
        [`GET ${ENTITY}/tax-categories`]: () =>
          ok({ taxCategories: [{ code: "OUT_OF_SCOPE", name: "対象外", kind: null }] }),
      },
    );
    const u = fakeClockUser();
    const { router } = renderJournals();
    const open = await screen.findByRole("button", { name: "仕訳 No.3 の詳細" });
    open.focus();
    await u.keyboard("{Enter}");
    const sheet = await screen.findByRole("dialog", { name: "仕訳の詳細" });
    expect(router.state.location.pathname).toBe("/e/e1/journals");
    await u.click(await within(sheet).findByRole("button", { name: "訂正する" }));
    expect(within(sheet).getByRole("form", { name: "仕訳" })).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    await u.click(within(sheet).getByRole("button", { name: "閉じる" }));
    await waitFor(() => expect(open).toHaveFocus());
  });

  it("今期を初期期間にし、summaryの全件数と金額をページの件数と別に表示する", async () => {
    const calls = mockListApi(
      () =>
        ok({
          journals: [j(3, "2026-10-03")],
          nextCursor: null,
          summary: { count: 250, amount: 12345678 },
        }),
      {
        [`GET ${ENTITY}/fiscal-periods`]: () =>
          ok({
            fiscalPeriods: [
              {
                id: "p2026",
                fiscalYear: 2026,
                startDate: "2026-04-01",
                endDate: "2027-03-31",
                status: "open",
                closedAt: null,
              },
            ],
          }),
      },
    );
    renderJournals();
    expect(await screen.findByLabelText("日付（から）")).toHaveValue("2026-04-01");
    expect(screen.getByLabelText("日付（まで）")).toHaveValue("2027-03-31");
    await waitFor(() =>
      expect(journalCalls(calls).at(-1)?.query).toEqual({
        dateFrom: "2026-04-01",
        dateTo: "2027-03-31",
      }),
    );
    const summary = await screen.findByLabelText("検索結果の集計");
    expect(summary).toHaveTextContent("250 件");
    expect(summary).toHaveTextContent("12,345,678 円");
  });

  it("検索ボタンを出さず、変更300ms後に再検索し、続く編集で入力位置を失わない", async () => {
    const calls = mockListApi(() =>
      ok({ journals: [], nextCursor: null, summary: { count: 0, amount: 0 } }),
    );
    const u = fakeClockUser();
    renderJournals();
    const memo = await screen.findByLabelText("摘要・メモ");
    expect(screen.queryByRole("button", { name: "検索" })).not.toBeInTheDocument();
    const initial = journalCalls(calls).length;
    await u.type(memo, "月");
    expect(journalCalls(calls)).toHaveLength(initial);
    await advance(SEARCH_DEBOUNCE_MS);
    await waitFor(() => expect(journalCalls(calls).at(-1)?.query.q).toBe("月"));
    expect(memo).toHaveFocus();
    await u.type(memo, "額");
    await waitFor(() => expect(journalCalls(calls).at(-1)?.query.q).toBe("月額"));
  });
});

describe("一覧のレビューの指摘（011）", () => {
  const periods = {
    [`GET ${ENTITY}/fiscal-periods`]: () =>
      ok({
        fiscalPeriods: [
          {
            id: "p2026",
            fiscalYear: 2026,
            startDate: "2026-04-01",
            endDate: "2027-03-31",
            status: "open",
            closedAt: null,
          },
        ],
      }),
  };
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const entry = journal(3, "2026-10-03", [
    ["debit", receivable.id, 3000],
    ["credit", bank.id, 3000],
  ]);
  const detailApi = {
    [`GET ${ENTITY}/journals/${entry.id}`]: () =>
      ok({ journal: entry, correctsJournal: null, correctingJournals: [] }),
    [`GET ${ENTITY}/journals/${entry.id}/history`]: () => ok({ history: [] }),
    [`GET ${ENTITY}/tax-settings`]: () => ok({ taxSettings: [] }),
    [`GET ${ENTITY}/tax-categories`]: () =>
      ok({ taxCategories: [{ code: "OUT_OF_SCOPE", name: "対象外", kind: null }] }),
  };

  it("行の日付をクリックして詳細を開き、閉じるとその行の No. ボタンへ戻る", async () => {
    mockListApi(() => ok({ journals: [entry], nextCursor: null }), detailApi);
    const u = fakeClockUser();
    renderJournals();
    const table = await screen.findByRole("table", { name: "仕訳の一覧" });
    const open = within(table).getByRole("button", { name: "仕訳 No.3 の詳細" });
    await u.click(within(table).getByRole("cell", { name: "2026-10-03" }));
    const sheet = await screen.findByRole("dialog", { name: "仕訳の詳細" });
    await u.click(within(sheet).getByRole("button", { name: "閉じる" }));
    await waitFor(() => expect(open).toHaveFocus());
  });

  it("摘要の文字を選択したクリックでは開かず、コピー後も選択を維持する", async () => {
    const noted = { ...entry, memo: "コピーする摘要" };
    mockListApi(() => ok({ journals: [noted], nextCursor: null }), detailApi);
    const u = fakeClockUser();
    renderJournals();
    const note = await screen.findByText("コピーする摘要");
    const selection = window.getSelection();
    if (!selection) throw new Error("Selection がない");
    const range = document.createRange();
    range.selectNodeContents(note);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      // ドラッグ終了時の click。userEvent.click の mousedown は選択を解除する。
      fireEvent.click(note);
      await u.copy();
      expect(selection.toString()).toBe("コピーする摘要");
      expect(screen.queryByRole("dialog", { name: "仕訳の詳細" })).not.toBeInTheDocument();
      selection.removeAllRanges();
      await u.click(note);
      expect(await screen.findByRole("dialog", { name: "仕訳の詳細" })).toBeInTheDocument();
    } finally {
      selection.removeAllRanges();
    }
  });

  it("日付を両方空にして検索すると全期間で探し、API へ日付を送らない", async () => {
    const calls = mockListApi(() => ok({ journals: [entry], nextCursor: null }), periods);
    const u = fakeClockUser();
    const { router } = renderJournals();
    const form = await screen.findByRole("search", { name: "仕訳の検索" });
    await waitFor(() =>
      expect(within(form).getByLabelText("日付（から）")).toHaveValue("2026-04-01"),
    );
    await waitFor(() =>
      expect(journalCalls(calls).at(-1)?.query).toEqual({
        dateFrom: "2026-04-01",
        dateTo: "2027-03-31",
      }),
    );

    await u.clear(within(form).getByLabelText("日付（から）"));
    await u.clear(within(form).getByLabelText("日付（まで）"));
    await waitFor(() => expect(router.state.location.search).toEqual({ allDates: true }));
    await waitFor(() => expect(journalCalls(calls).at(-1)?.query).toEqual({}));
    expect(within(form).getByLabelText("日付（から）")).toHaveValue("");
    expect(within(form).getByLabelText("日付（まで）")).toHaveValue("");

    // 日付を入れると全期間の指定を外す。クリアは既定の期間へ戻す
    await u.type(within(form).getByLabelText("日付（から）"), "2026-06-01");
    await waitFor(() => expect(router.state.location.search).toEqual({ dateFrom: "2026-06-01" }));
    await u.clear(within(form).getByLabelText("日付（から）"));
    await waitFor(() => expect(router.state.location.search).toEqual({ allDates: true }));
    await u.click(within(form).getByRole("button", { name: "条件をクリア" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        dateFrom: "2026-04-01",
        dateTo: "2027-03-31",
      }),
    );
  });

  it("条件を変えて読み直す間は、前の結果の行を表に残す", async () => {
    const next = deferred<ReturnType<typeof ok>>();
    mockListApi((call) => (call.query.q === "新" ? next.promise : ok({ journals: [entry] })));
    const u = fakeClockUser();
    renderJournals();
    await screen.findByRole("table", { name: "仕訳の一覧" });
    await u.type(await screen.findByLabelText("摘要・メモ"), "新");
    await advance(SEARCH_DEBOUNCE_MS);
    expect(screen.getByRole("table", { name: "仕訳の一覧" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "仕訳 No.3 の詳細" })).toBeInTheDocument();
    next.resolve(ok({ journals: [journal(4, "2026-10-04", [["debit", bank.id, 4000]])] }));
    expect(await screen.findByRole("button", { name: "仕訳 No.4 の詳細" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "仕訳 No.3 の詳細" })).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "仕訳の一覧" })).not.toHaveAttribute("aria-busy");
  });

  async function openCorrection(u: ReturnType<typeof userEvent.setup>) {
    mockListApi(() => ok({ journals: [entry], nextCursor: null }), detailApi);
    renderJournals();
    await u.click(await screen.findByRole("button", { name: "仕訳 No.3 の詳細" }));
    const sheet = await screen.findByRole("dialog", { name: "仕訳の詳細" });
    await u.click(await within(sheet).findByRole("button", { name: "訂正する" }));
    await within(sheet).findByRole("form", { name: "仕訳" });
    return sheet;
  }

  it("訂正の入力があるまま Sheet を閉じるときは確認し、キャンセルなら残す", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    const u = fakeClockUser();
    const sheet = await openCorrection(u);
    await u.type(within(sheet).getByLabelText("メモ"), "訂正中");

    await u.click(within(sheet).getByRole("button", { name: "閉じる" }));
    expect(confirm).toHaveBeenLastCalledWith("訂正の入力を破棄して閉じますか？");
    expect(screen.getByRole("dialog", { name: "仕訳の詳細" })).toBeInTheDocument();
    expect(within(sheet).getByLabelText("メモ")).toHaveValue("訂正中");

    await u.keyboard("{Escape}");
    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "仕訳の詳細" })).not.toBeInTheDocument(),
    );
  });

  it("訂正の入力がなければ確認なしで Sheet を閉じる", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const u = fakeClockUser();
    const sheet = await openCorrection(u);

    await u.click(within(sheet).getByRole("button", { name: "閉じる" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "仕訳の詳細" })).not.toBeInTheDocument(),
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});
