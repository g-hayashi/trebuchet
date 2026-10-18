import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/queries";
import { Route } from "@/routes/e/$entityId/journals/index";
import { type ApiCall, type ApiReply, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (n: number, name: string, isActive = true): Account => ({
  id: uuid(n),
  code: String(n),
  name,
  category: "asset",
  normalSide: "debit",
  reportSection: "BS_ASSET",
  reportLine: null,
  sortOrder: n,
  isSystem: false,
  isActive,
});

const bank = account(1020, "普通預金");
const owner = account(1900, "事業主貸");
const receivable = account(1100, "売掛金");
const sales = account(4010, "売上高", false);

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

function mockListApi(journals: (call: ApiCall) => ApiReply) {
  return mockApi({
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [bank, owner, receivable, sales] }),
    [`GET ${ENTITY}/partners`]: () => ok({ partners: [partnerA] }),
    [`GET ${ENTITY}/tags`]: () => ok({ tags: [tagA] }),
    [`GET ${ENTITY}/journals`]: journals,
  });
}

function renderJournals(url = "/e/e1/journals") {
  return renderRoute(Route, { path: "/e/$entityId/journals/", url });
}

const journalCalls = (calls: ApiCall[]) => calls.filter((c) => c.path === `${ENTITY}/journals`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    const u = userEvent.setup();
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
    await u.click(within(form).getByRole("button", { name: "検索" }));

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
    const u = userEvent.setup();
    const { router } = renderJournals();
    const form = await screen.findByRole("search", { name: "仕訳の検索" });
    const min = within(form).getByLabelText("金額（以上）");
    await u.type(min, "abc");
    await u.click(within(form).getByRole("button", { name: "検索" }));

    await waitFor(() => expect(min).toHaveAttribute("aria-invalid", "true"));
    expect(router.state.location.search).toEqual({});
  });

  it("次のページがあれば「さらに読み込む」で cursor を付けて続きを読み込む", async () => {
    const calls = mockListApi((call) =>
      call.query.cursor === "2026-10-04_4"
        ? ok({ journals: [j(3, "2026-10-03")], nextCursor: null })
        : ok({ journals: [j(5, "2026-10-05"), j(4, "2026-10-04")], nextCursor: "2026-10-04_4" }),
    );
    const u = userEvent.setup();
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

  it("各行から仕訳の詳細を開ける", async () => {
    mockListApi(() => ok({ journals: [j(3, "2026-10-03")], nextCursor: null }));
    renderJournals();
    expect(await screen.findByRole("link", { name: "仕訳 No.3 の詳細" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${uuid(9003)}`,
    );
  });
});
