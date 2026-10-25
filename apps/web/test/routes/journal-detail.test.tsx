import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/queries";
import { Route } from "@/routes/e/$entityId/journals/$journalId";
import { type ApiCall, type ApiReply, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (
  n: number,
  name: string,
  rest: Pick<Account, "category" | "normalSide" | "reportSection"> & Partial<Account>,
): Account => ({
  id: uuid(n),
  code: String(n),
  name,
  reportLine: null,
  sortOrder: n,
  isSystem: false,
  isActive: true,
  ...rest,
});

const asset = { category: "asset", normalSide: "debit", reportSection: "BS_ASSET" } as const;
const bank = account(1020, "普通預金", asset);
/** 使用停止だが、訂正元の仕訳で使っている */
const receivable = account(1100, "売掛金", { ...asset, isActive: false });
const sales = account(4010, "売上高", {
  category: "revenue",
  normalSide: "credit",
  reportSection: "PL_SALES",
});
const accounts = [bank, receivable, sales];

const periods = (closed2025: boolean) => [
  {
    id: "p2025",
    fiscalYear: 2025,
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    status: closed2025 ? "closed" : "open",
    closedAt: closed2025 ? "2026-03-15T00:00:00.000Z" : null,
  },
  {
    id: "p2026",
    fiscalYear: 2026,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    status: "open",
    closedAt: null,
  },
];

type LineSpec = [side: "debit" | "credit", accountId: string, amount: number];

const journal = (
  journalNo: number,
  date: string,
  lines: LineSpec[],
  rest: Partial<{
    memo: string | null;
    status: "active" | "voided";
    version: number;
    correctsJournalId: string | null;
  }> = {},
) => ({
  id: uuid(9000 + journalNo),
  journalNo,
  date,
  fiscalPeriodId: date.startsWith("2025") ? "p2025" : "p2026",
  memo: null,
  status: "active",
  correctsJournalId: null,
  source: "manual",
  version: 1,
  createdAt: "2026-10-31T09:00:00.000Z",
  updatedAt: "2026-10-31T09:00:00.000Z",
  ...rest,
  lines: lines.map(([side, accountId, amount], i) => ({
    id: uuid(9100 + journalNo * 10 + i),
    lineNo: i + 1,
    side,
    accountId,
    subAccountId: null,
    amount,
    taxCategory: "OUT_OF_SCOPE",
    taxAmount: 0,
    partnerId: null,
    description: null,
    tagIds: [],
  })),
});

const j1 = journal(
  1,
  "2026-10-31",
  [
    ["debit", receivable.id, 495_000],
    ["credit", sales.id, 495_000],
  ],
  { memo: "10月分", version: 2 },
);
const j1v1 = { ...j1, memo: "10月分", version: 1, date: "2026-10-30" };
const ref = (j: ReturnType<typeof journal>) => ({
  id: j.id,
  journalNo: j.journalNo,
  date: j.date,
  status: j.status,
});

const history = [
  {
    occurredAt: "2026-10-30T09:00:00.000Z",
    action: "create",
    reason: null,
    before: null,
    after: j1v1,
  },
  {
    occurredAt: "2026-10-31T09:00:00.000Z",
    action: "correct",
    reason: "日付の誤り",
    before: j1v1,
    after: j1,
  },
];

type Detail = {
  journal: ReturnType<typeof journal>;
  correctsJournal: ReturnType<typeof ref> | null;
  correctingJournals: ReturnType<typeof ref>[];
};

function mockDetailApi(
  detail: Detail,
  {
    closed2025 = false,
    put,
    voidReply,
    origin,
  }: {
    origin?: unknown;
    closed2025?: boolean;
    put?: (call: ApiCall) => ApiReply;
    voidReply?: (call: ApiCall) => ApiReply;
  } = {},
) {
  const path = `${ENTITY}/journals/${detail.journal.id}`;
  return mockApi({
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
    [`GET ${ENTITY}/partners`]: () => ok({ partners: [] }),
    [`GET ${ENTITY}/tags`]: () => ok({ tags: [] }),
    [`GET ${ENTITY}/tax-settings`]: () =>
      ok({
        taxSettings: [
          {
            id: "t1",
            effectiveFrom: "2025-01-01",
            taxpayerStatus: "exempt",
            accountingMethod: "tax_included",
          },
        ],
      }),
    [`GET ${ENTITY}/tax-categories`]: () =>
      ok({ taxCategories: [{ code: "OUT_OF_SCOPE", name: "対象外", kind: null }], taxRates: [] }),
    [`GET ${ENTITY}/fiscal-periods`]: () => ok({ fiscalPeriods: periods(closed2025) }),
    ...Object.fromEntries(
      accounts.map((a) => [
        `GET ${ENTITY}/accounts/${a.id}/sub-accounts`,
        () => ok({ subAccounts: [] }),
      ]),
    ),
    [`GET ${path}`]: () => ok(detail),
    [`GET ${path}/history`]: () => ok({ history }),
    ...(origin !== undefined && { [`GET ${path}/origin`]: () => ok({ origin }) }),
    ...(put && { [`PUT ${path}`]: put }),
    ...(voidReply && { [`POST ${path}/void`]: voidReply }),
  });
}

function renderDetail(journalId: string) {
  return renderRoute(Route, {
    path: "/e/$entityId/journals/$journalId",
    url: `/e/e1/journals/${journalId}`,
  });
}

const user = () => userEvent.setup();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("仕訳の詳細（US3）", () => {
  it("仕訳の内容と、変更履歴（日時・操作・理由・変更前後）を表示する", async () => {
    mockDetailApi({ journal: j1, correctsJournal: null, correctingJournals: [] });
    renderDetail(j1.id);

    expect(await screen.findByRole("heading", { name: "仕訳 No.1" })).toBeInTheDocument();
    const lines = await screen.findByRole("table", { name: "仕訳の内容" });
    expect(lines).toHaveTextContent("売掛金");
    expect(lines).toHaveTextContent("495,000");
    expect(screen.getByText("10月分")).toBeInTheDocument();
    expect(screen.queryByText("取消済み")).not.toBeInTheDocument();

    const items = within(await screen.findByRole("list", { name: "変更履歴" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("登録");
    expect(items[0]?.querySelector("time")).toHaveAttribute("datetime", "2026-10-30T09:00:00.000Z");
    expect(items[1]).toHaveTextContent("訂正");
    expect(items[1]).toHaveTextContent("理由: 日付の誤り");
    expect(items[1]).toHaveTextContent("日付: 2026-10-30 → 2026-10-31");
  });

  it("FR-020: 訂正は理由の入力を求め、理由と version を付けて PUT する", async () => {
    let body: unknown;
    const calls = mockDetailApi(
      { journal: j1, correctsJournal: null, correctingJournals: [] },
      {
        put: (call) => {
          body = call.body;
          return ok({ journal: { ...j1, memo: "10月分（訂正）", version: 3 } });
        },
      },
    );
    const u = user();
    renderDetail(j1.id);

    await u.click(await screen.findByRole("button", { name: "訂正する" }));
    // 訂正元の仕訳で使っている使用停止の科目は選べる
    expect(await screen.findByLabelText("1行目の勘定科目")).toHaveValue(receivable.id);
    expect(screen.getByLabelText("日付")).toHaveValue("2026-10-31");
    const memo = screen.getByLabelText("メモ");
    await u.clear(memo);
    await u.type(memo, "10月分（訂正）");
    await u.click(screen.getByRole("button", { name: "訂正を保存" }));

    const dialog = await screen.findByRole("dialog", { name: "訂正の理由" });
    const confirm = within(dialog).getByRole("button", { name: "訂正を確定" });
    expect(confirm).toBeDisabled();
    await u.type(within(dialog).getByLabelText("理由"), "メモの誤り");
    await u.click(confirm);

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({
      date: "2026-10-31",
      memo: "10月分（訂正）",
      reason: "メモの誤り",
      version: 2,
      lines: [
        { side: "debit", accountId: receivable.id, amount: 495_000 },
        { side: "credit", accountId: sales.id, amount: 495_000 },
      ],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("訂正の理由のダイアログを閉じると送らない。API のエラーはフォームに表示する", async () => {
    const calls = mockDetailApi(
      { journal: j1, correctsJournal: null, correctingJournals: [] },
      {
        put: () =>
          apiError(409, "VERSION_CONFLICT", "ほかの操作で仕訳が更新されています", {
            journalId: j1.id,
            currentVersion: 3,
          }),
      },
    );
    const u = user();
    renderDetail(j1.id);

    await u.click(await screen.findByRole("button", { name: "訂正する" }));
    await u.click(await screen.findByRole("button", { name: "訂正を保存" }));
    let dialog = await screen.findByRole("dialog", { name: "訂正の理由" });
    await u.click(within(dialog).getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);

    await u.click(screen.getByRole("button", { name: "訂正を保存" }));
    dialog = await screen.findByRole("dialog", { name: "訂正の理由" });
    await u.type(within(dialog).getByLabelText("理由"), "メモの誤り");
    await u.click(within(dialog).getByRole("button", { name: "訂正を確定" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ほかの操作で仕訳が更新されています",
    );
  });

  it("FR-021: 取消は理由の入力を求め、理由と version を付けて POST する", async () => {
    let body: unknown;
    const voided = { ...j1, status: "voided" as const, version: 3 };
    mockDetailApi(
      { journal: j1, correctsJournal: null, correctingJournals: [] },
      {
        voidReply: (call) => {
          body = call.body;
          return ok({ journal: voided });
        },
      },
    );
    const u = user();
    renderDetail(j1.id);

    await u.click(await screen.findByRole("button", { name: "取り消す" }));
    const dialog = await screen.findByRole("dialog", { name: "取消の理由" });
    const confirm = within(dialog).getByRole("button", { name: "取消を確定" });
    expect(confirm).toBeDisabled();
    await u.type(within(dialog).getByLabelText("理由"), "二重登録");
    await u.click(confirm);
    await waitFor(() => expect(body).toEqual({ reason: "二重登録", version: 2 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("取消済みの仕訳は取消済みと表示し、訂正・取消のボタンを出さない", async () => {
    mockDetailApi({
      journal: { ...j1, status: "voided" },
      correctsJournal: null,
      correctingJournals: [],
    });
    renderDetail(j1.id);

    expect(await screen.findByText("取消済み")).toBeInTheDocument();
    await screen.findByRole("table", { name: "仕訳の内容" });
    expect(screen.queryByRole("button", { name: "訂正する" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取り消す" })).not.toBeInTheDocument();
  });

  it("US3-5: 締め済みの年度の仕訳は訂正・取消の代わりに、当年度の訂正仕訳の起票へ案内する", async () => {
    const old = journal(5, "2025-12-20", [
      ["debit", receivable.id, 1000],
      ["credit", sales.id, 1000],
    ]);
    mockDetailApi(
      { journal: old, correctsJournal: null, correctingJournals: [] },
      { closed2025: true },
    );
    renderDetail(old.id);

    expect(await screen.findByText(/2025年度は締め済みです/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "当年度に訂正仕訳を起票" })).toHaveAttribute(
      "href",
      `/e/e1/journals/new?correctsJournalId=${old.id}`,
    );
    expect(screen.queryByRole("button", { name: "訂正する" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取り消す" })).not.toBeInTheDocument();
  });

  it("取消の API が PERIOD_CLOSED を返したら、訂正仕訳の起票へ案内する", async () => {
    mockDetailApi(
      { journal: j1, correctsJournal: null, correctingJournals: [] },
      {
        voidReply: () =>
          apiError(409, "PERIOD_CLOSED", "2026年度は締め済みです。訂正は訂正仕訳で行ってください", {
            fiscalYear: 2026,
            suggest: "correcting_entry",
          }),
      },
    );
    const u = user();
    renderDetail(j1.id);

    await u.click(await screen.findByRole("button", { name: "取り消す" }));
    const dialog = await screen.findByRole("dialog", { name: "取消の理由" });
    await u.type(within(dialog).getByLabelText("理由"), "二重登録");
    await u.click(within(dialog).getByRole("button", { name: "取消を確定" }));

    expect(await screen.findByRole("link", { name: "当年度に訂正仕訳を起票" })).toHaveAttribute(
      "href",
      `/e/e1/journals/new?correctsJournalId=${j1.id}`,
    );
  });

  it("FR-019a: 訂正元の仕訳と訂正仕訳へのリンクを出す", async () => {
    const original = journal(1, "2025-12-20", [
      ["debit", receivable.id, 1000],
      ["credit", sales.id, 1000],
    ]);
    const fix = journal(
      7,
      "2026-01-10",
      [
        ["debit", receivable.id, 50],
        ["credit", sales.id, 50],
      ],
      { correctsJournalId: original.id },
    );
    const fix2 = journal(9, "2026-02-10", [
      ["debit", receivable.id, 70],
      ["credit", sales.id, 70],
    ]);
    mockDetailApi(
      { journal: fix, correctsJournal: ref(original), correctingJournals: [ref(fix2)] },
      { closed2025: true },
    );
    renderDetail(fix.id);

    expect(await screen.findByRole("link", { name: "訂正元の仕訳 No.1" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${original.id}`,
    );
    expect(screen.getByRole("link", { name: "訂正仕訳 No.9（2026-02-10）" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${fix2.id}`,
    );
  });

  describe("仕訳の出所（005。FR-009・FR-028。GET /journals/:id/origin）", () => {
    const detail = { journal: j1, correctsJournal: null, correctingJournals: [] };

    it("請求書の売上の仕訳なら、請求書へのリンクを出す", async () => {
      mockDetailApi(detail, {
        origin: { kind: "invoice", invoiceId: "inv1", invoiceNo: "2026-0001" },
      });
      renderDetail(j1.id);

      expect(await screen.findByRole("link", { name: "請求書 2026-0001" })).toHaveAttribute(
        "href",
        "/e/e1/invoices/inv1",
      );
    });

    it("入金の仕訳なら、入金の消し込みをした請求書へのリンクを出す", async () => {
      mockDetailApi(detail, {
        origin: { kind: "payment", invoiceId: "inv1", invoiceNo: "2026-0001", paymentId: "pay1" },
      });
      renderDetail(j1.id);

      const link = await screen.findByRole("link", { name: "請求書 2026-0001" });
      expect(link.closest("p")).toHaveTextContent("入金の消し込み");
    });

    it("定期仕訳から自動で登録した仕訳なら、定期仕訳の名前と対象月を出す", async () => {
      mockDetailApi(detail, {
        origin: { kind: "recurring", recurringId: "r1", name: "家賃", targetMonth: "2026-10" },
      });
      renderDetail(j1.id);

      expect(await screen.findByText(/定期仕訳「家賃」（2026-10）/)).toBeInTheDocument();
    });

    it("出所がなければ何も出さない（mock-api の既定は origin: null）", async () => {
      mockDetailApi(detail);
      renderDetail(j1.id);

      await screen.findByRole("heading", { name: "仕訳 No.1" });
      expect(screen.queryByText(/請求書|定期仕訳/)).not.toBeInTheDocument();
    });
  });

  it("仕訳が見つからなければその旨を表示する", async () => {
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
      [`GET ${ENTITY}/fiscal-periods`]: () => ok({ fiscalPeriods: periods(false) }),
      [`GET ${ENTITY}/journals/${uuid(1)}`]: () =>
        apiError(404, "JOURNAL_NOT_FOUND", "仕訳が見つかりません"),
      [`GET ${ENTITY}/journals/${uuid(1)}/history`]: () =>
        apiError(404, "JOURNAL_NOT_FOUND", "仕訳が見つかりません"),
    });
    renderDetail(uuid(1));
    expect(await screen.findByText("仕訳が見つかりません")).toBeInTheDocument();
  });
});
