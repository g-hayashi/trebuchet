import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReceiptDetail, ReceiptSummary } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { journalKeys } from "@/features/journals/api";
import { receiptKeys } from "@/features/receipts/api";
import { reportKeys } from "@/features/reports/api";
import { Route as JournalDetailRoute } from "@/routes/e/$entityId/journals/$journalId";
import { Route as JournalsRoute } from "@/routes/e/$entityId/journals/index";
import { Route as NewJournalRoute } from "@/routes/e/$entityId/journals/new";
import { Route as ReceiptRoute } from "@/routes/e/$entityId/receipts/$receiptId";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, receiptDetail, receiptSummary } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T023: 仕訳との結びつき（link・unlink・証憑から仕訳を作る）と、仕訳の一覧・詳細の証憑（H: §3・§4・§8）

const ENTITY = "/api/entities/e1";
const RECEIPT = `${ENTITY}/receipts/${RECEIPT_ID}`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ref = (journalNo: number, date: string, status: "active" | "voided" = "active") => ({
  id: uuid(9000 + journalNo),
  journalNo,
  date,
  status,
});
const candidate = (journalNo: number, date: string, total: number, daysDiff: number) => ({
  journal: ref(journalNo, date),
  total,
  daysDiff,
  amountMatches: total === 1100,
});

const CANDIDATES = [candidate(3, "2026-10-20", 1100, 0), candidate(5, "2026-10-22", 2000, 2)];

const linkedTo = (journalNo: number): Partial<ReceiptDetail> => ({
  linkState: "linked",
  journal: ref(journalNo, "2026-10-20"),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const posts = (calls: ApiCall[], suffix: string) =>
  calls.filter((c) => c.method === "POST" && c.path === `${RECEIPT}/${suffix}`);

// ---- 証憑の詳細: 結びつける・付け替える・解除する ----

function renderReceipt() {
  return renderRoute(ReceiptRoute, {
    path: "/e/$entityId/receipts/$receiptId",
    url: `/e/e1/receipts/${RECEIPT_ID}`,
  });
}

/** 結びつきの操作を受けて状態を変える応答 */
function linkApi(
  initial: Partial<ReceiptDetail>,
  {
    link,
    unlink,
    extra = {},
  }: {
    link?: (call: ApiCall) => ReturnType<typeof ok>;
    unlink?: (call: ApiCall) => ReturnType<typeof ok>;
    extra?: Parameters<typeof mockApi>[0];
  } = {},
) {
  let current = receiptDetail(initial);
  return mockApi({
    [`GET ${RECEIPT}`]: () => ok({ receipt: current }),
    [`GET ${RECEIPT}/journal-candidates`]: () => ok({ candidates: CANDIDATES }),
    [`POST ${RECEIPT}/link`]: (call) => {
      if (link) return link(call);
      const { journalId } = call.body as { journalId: string };
      const picked = CANDIDATES.find((c) => c.journal.id === journalId);
      current = { ...current, linkState: "linked", journal: picked?.journal ?? null };
      return ok({ receipt: current }, 201);
    },
    [`POST ${RECEIPT}/unlink`]: (call) => {
      if (unlink) return unlink(call);
      current = { ...current, linkState: "none", journal: null };
      return ok({ receipt: current });
    },
    ...extra,
  });
}

/** 結びつきの後に読み直されるクエリ（仕訳・帳票・証憑）。invalidateLedger と証憑の query key */
function expectLedgerInvalidated(invalidate: ReturnType<typeof vi.spyOn>) {
  for (const queryKey of [journalKeys.all("e1"), reportKeys.all("e1"), receiptKeys.all("e1")]) {
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey }));
  }
}

describe("証憑の仕訳との結びつき（結びつける）", () => {
  it("候補を、金額が合う順に示し、選ぶと link を送って詳細に仕訳を示す", async () => {
    const calls = linkApi({});
    const { queryClient } = renderReceipt();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const u = userEvent.setup();

    await u.click(await screen.findByRole("button", { name: "仕訳に結びつける" }));
    const dialog = await screen.findByRole("dialog", { name: "仕訳に結びつける" });
    const items = await within(dialog).findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("仕訳 No.3");
    expect(items[0]).toHaveTextContent("2026-10-20");
    expect(items[0]).toHaveTextContent("1,100");
    expect(items[0]).toHaveTextContent("金額が一致");
    expect(items[1]).toHaveTextContent("仕訳 No.5");
    expect(items[1]).not.toHaveTextContent("金額が一致");

    await u.click(within(dialog).getByRole("button", { name: "仕訳 No.3 に結びつける" }));

    await waitFor(() => expect(posts(calls, "link")).toHaveLength(1));
    expect(posts(calls, "link")[0]?.body).toEqual({ journalId: uuid(9003) });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expectLedgerInvalidated(invalidate);
    // 詳細が読み直されて、結びついた仕訳へのリンクが出る
    expect(await screen.findByRole("link", { name: "仕訳 No.3 を開く" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${uuid(9003)}`,
    );
    expect(screen.queryByRole("button", { name: "仕訳に結びつける" })).not.toBeInTheDocument();
  });

  it("キーワードで仕訳を探して結びつけられる", async () => {
    const calls = linkApi(
      {},
      {
        extra: {
          [`GET ${ENTITY}/journals`]: () =>
            ok({
              journals: [
                {
                  ...ref(8, "2026-09-01"),
                  memo: null,
                  lines: [
                    { id: uuid(1), side: "debit", accountId: uuid(10), amount: 3300 },
                    { id: uuid(2), side: "credit", accountId: uuid(11), amount: 3300 },
                  ],
                  receiptCount: 0,
                },
              ],
              nextCursor: null,
            }),
        },
      },
    );
    renderReceipt();
    const u = userEvent.setup();

    await u.click(await screen.findByRole("button", { name: "仕訳に結びつける" }));
    const dialog = await screen.findByRole("dialog", { name: "仕訳に結びつける" });
    await u.type(within(dialog).getByLabelText("キーワード"), "文具");
    await u.click(within(dialog).getByRole("button", { name: "検索" }));

    await u.click(await within(dialog).findByRole("button", { name: "仕訳 No.8 に結びつける" }));
    await waitFor(() => expect(posts(calls, "link")).toHaveLength(1));
    expect(posts(calls, "link")[0]?.body).toEqual({ journalId: uuid(9008) });
    const search = calls.find((c) => c.method === "GET" && c.path === `${ENTITY}/journals`);
    expect(search?.query).toEqual({ q: "文具" });
  });

  it("すでに別の仕訳に結びついていれば（409 RECEIPT_ALREADY_LINKED）エラーを示す", async () => {
    linkApi(
      {},
      {
        link: () => apiError(409, "RECEIPT_ALREADY_LINKED", "すでに仕訳に結びついています"),
      },
    );
    renderReceipt();
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "仕訳に結びつける" }));
    const dialog = await screen.findByRole("dialog", { name: "仕訳に結びつける" });
    await u.click(await within(dialog).findByRole("button", { name: "仕訳 No.3 に結びつける" }));
    // 文言は画面が決める（エラーコードごと）
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "すでに別の仕訳に結びついています",
    );
  });

  it("候補がなければ知らせる", async () => {
    linkApi({}, { extra: { [`GET ${RECEIPT}/journal-candidates`]: () => ok({ candidates: [] }) } });
    renderReceipt();
    await userEvent.click(await screen.findByRole("button", { name: "仕訳に結びつける" }));
    const dialog = await screen.findByRole("dialog", { name: "仕訳に結びつける" });
    expect(await within(dialog).findByText("候補の仕訳がありません。")).toBeInTheDocument();
  });

  it("削除済みの証憑には結びつきの操作を出さない", async () => {
    linkApi({ deleted: true, deletedAt: "2026-10-21T00:00:00.000Z", deletedReason: "誤り" });
    renderReceipt();
    await screen.findByText(/削除済みです/);
    expect(screen.queryByRole("button", { name: "仕訳に結びつける" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "この証憑から仕訳を作る" })).not.toBeInTheDocument();
  });
});

describe("証憑の仕訳との結びつき（付け替え・解除）", () => {
  it("付け替えは replace: true で送り、422 REASON_REQUIRED を受けてから理由を求める", async () => {
    let attempts = 0;
    const calls = linkApi(linkedTo(3), {
      link: (call) => {
        attempts += 1;
        const body = call.body as { reason?: string };
        if (body.reason === undefined) {
          return apiError(422, "REASON_REQUIRED", "付け替えには理由が必要です");
        }
        return ok({ receipt: receiptDetail(linkedTo(5)) }, 201);
      },
    });
    const { queryClient } = renderReceipt();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const u = userEvent.setup();

    await u.click(await screen.findByRole("button", { name: "付け替える" }));
    const dialog = await screen.findByRole("dialog", { name: "仕訳に結びつける" });
    expect(within(dialog).queryByLabelText("理由")).not.toBeInTheDocument();
    await u.click(await within(dialog).findByRole("button", { name: "仕訳 No.5 に結びつける" }));

    // 理由の要否は server の応答で決まる。最初は理由なしで送る
    expect(await within(dialog).findByText("付け替えには理由が必要です")).toBeInTheDocument();
    expect(posts(calls, "link")[0]?.body).toEqual({ journalId: uuid(9005), replace: true });
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: journalKeys.all("e1") }),
    );

    await u.type(within(dialog).getByLabelText("理由"), "別の仕訳の証憑だった");
    await u.click(within(dialog).getByRole("button", { name: "付け替えを確定" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(posts(calls, "link")[1]?.body).toEqual({
      journalId: uuid(9005),
      replace: true,
      reason: "別の仕訳の証憑だった",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expectLedgerInvalidated(invalidate);
  });

  it("結びつきの解除は理由を入れて送り、状態を読み直す", async () => {
    const calls = linkApi(linkedTo(3));
    const { queryClient } = renderReceipt();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const u = userEvent.setup();

    await u.click(await screen.findByRole("button", { name: "結びつきを解除" }));
    const dialog = await screen.findByRole("dialog", { name: "結びつきの解除" });
    await u.type(within(dialog).getByLabelText("理由"), "誤って結びつけた");
    await u.click(within(dialog).getByRole("button", { name: "解除を確定" }));

    await waitFor(() => expect(posts(calls, "unlink")).toHaveLength(1));
    expect(posts(calls, "unlink")[0]?.body).toEqual({ reason: "誤って結びつけた" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expectLedgerInvalidated(invalidate);
    expect(await screen.findByRole("button", { name: "仕訳に結びつける" })).toBeInTheDocument();
  });

  it("結びついた仕訳が取り消されている証憑は、そのことを示し、付け替えなしで結び直せる", async () => {
    const calls = linkApi({
      linkState: "journal_voided",
      journal: ref(3, "2026-10-20", "voided"),
      warnings: [{ code: "JOURNAL_VOIDED" }],
    });
    renderReceipt();
    const u = userEvent.setup();
    const section = await screen.findByRole("region", { name: "仕訳との結びつき" });
    expect(within(section).getByText(/この仕訳は取り消されています/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "仕訳に結びつける" }));
    const dialog = await screen.findByRole("dialog", { name: "仕訳に結びつける" });
    await u.click(await within(dialog).findByRole("button", { name: "仕訳 No.5 に結びつける" }));
    await waitFor(() => expect(posts(calls, "link")).toHaveLength(1));
    expect(posts(calls, "link")[0]?.body).toEqual({ journalId: uuid(9005) });
  });
});

// ---- 証憑から仕訳を作る ----

const asset = { category: "asset", normalSide: "debit", reportSection: "BS_ASSET" } as const;
const account = (
  n: number,
  name: string,
  rest: Partial<Account> & Pick<Account, "category" | "normalSide" | "reportSection">,
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
const bank = account(1020, "普通預金", asset);
const supplies = account(6010, "消耗品費", {
  category: "expense",
  normalSide: "debit",
  reportSection: "PL_EXPENSE",
});
const partnerShop = {
  id: uuid(7001),
  name: "合成の店",
  honorific: "御中",
  memo: null,
  isActive: true,
};

type JournalBody = {
  date: string;
  memo?: string;
  lines: { side: string; accountId: string; amount: number; partnerId?: string }[];
};

function mockNewJournalApi(
  post: (call: ApiCall) => ReturnType<typeof ok>,
  detail = receiptDetail(),
) {
  return mockApi({
    [`GET ${RECEIPT}`]: () => ok({ receipt: detail }),
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [supplies, bank] }),
    [`GET ${ENTITY}/partners`]: () => ok({ partners: [partnerShop] }),
    [`GET ${ENTITY}/tags`]: () => ok({ tags: [] }),
    [`GET ${ENTITY}/tax-settings`]: () =>
      ok({
        taxSettings: [
          {
            id: "t1",
            effectiveFrom: "2026-01-01",
            taxpayerStatus: "exempt",
            accountingMethod: "tax_included",
          },
        ],
      }),
    [`GET ${ENTITY}/tax-categories`]: () =>
      ok({ taxCategories: [{ code: "OUT_OF_SCOPE", name: "対象外", kind: null }], taxRates: [] }),
    [`GET ${ENTITY}/accounts/${supplies.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
    [`GET ${ENTITY}/accounts/${bank.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
    [`POST ${RECEIPT}/journal`]: post,
  });
}

const renderNewFromReceipt = () =>
  renderRoute(NewJournalRoute, {
    path: "/e/$entityId/journals/new",
    url: `/e/e1/journals/new?receiptId=${RECEIPT_ID}`,
  });

describe("証憑から仕訳を作る", () => {
  it("詳細に入口を示し、証憑の ID を付けて仕訳の入力を開く", async () => {
    linkApi({});
    renderReceipt();
    const entry = await screen.findByRole("link", { name: "この証憑から仕訳を作る" });
    expect(entry).toHaveAttribute("href", `/e/e1/journals/new?receiptId=${RECEIPT_ID}`);
  });

  it("取引年月日・金額・取引先を初期値にして、証憑の journal API へ送り、仕訳と証憑を読み直す", async () => {
    const calls = mockNewJournalApi((call) => {
      const { journal } = call.body as { journal: JournalBody };
      return ok(
        {
          journal: {
            id: uuid(9010),
            journalNo: 10,
            date: journal.date,
            fiscalPeriodId: "p2026",
            memo: journal.memo ?? null,
            status: "active",
            correctsJournalId: null,
            source: "manual",
            version: 1,
            createdAt: "2026-10-31T09:00:00.000Z",
            updatedAt: "2026-10-31T09:00:00.000Z",
            lines: [],
          },
          receipt: receiptDetail(linkedTo(10)),
        },
        201,
      );
    });
    const { queryClient } = renderNewFromReceipt();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const u = userEvent.setup();

    expect(await screen.findByLabelText("日付")).toHaveValue("2026-10-20");
    expect(screen.getByLabelText("1行目の金額")).toHaveValue("1100");
    expect(screen.getByLabelText("2行目の金額")).toHaveValue("1100");
    expect(screen.getByLabelText("メモ")).toHaveValue("合成の店");
    expect(screen.getByLabelText("1行目の取引先")).toHaveValue(partnerShop.id);

    await u.selectOptions(screen.getByLabelText("1行目の勘定科目"), "消耗品費");
    await u.selectOptions(screen.getByLabelText("2行目の勘定科目"), "普通預金");
    await u.click(screen.getByRole("button", { name: "登録する" }));

    await waitFor(() => expect(posts(calls, "journal")).toHaveLength(1));
    const body = posts(calls, "journal")[0]?.body as { journal: JournalBody };
    expect(body.journal.date).toBe("2026-10-20");
    expect(body.journal.lines.map((l) => [l.side, l.accountId, l.amount])).toEqual([
      ["debit", supplies.id, 1100],
      ["credit", bank.id, 1100],
    ]);
    // 通常の仕訳の API は呼ばない
    expect(calls.some((c) => c.method === "POST" && c.path === `${ENTITY}/journals`)).toBe(false);

    expectLedgerInvalidated(invalidate);
    const result = await screen.findByRole("status", { name: "登録の結果" });
    expect(
      within(result).getByText(/仕訳 No\.10 を登録し、証憑に結びつけました/),
    ).toBeInTheDocument();
    expect(within(result).getByRole("link", { name: "証憑に戻る" })).toHaveAttribute(
      "href",
      `/e/e1/receipts/${RECEIPT_ID}`,
    );
    // 二重に登録しないよう、登録したあとは入力を閉じる
    expect(screen.queryByRole("button", { name: "登録する" })).not.toBeInTheDocument();
  });

  it("すでに仕訳に結びついていれば（409 RECEIPT_ALREADY_LINKED）エラーを示す", async () => {
    mockNewJournalApi(() =>
      apiError(409, "RECEIPT_ALREADY_LINKED", "この証憑はすでに仕訳に結びついています"),
    );
    renderNewFromReceipt();
    const u = userEvent.setup();
    await screen.findByLabelText("1行目の勘定科目");
    await u.selectOptions(screen.getByLabelText("1行目の勘定科目"), "消耗品費");
    await u.selectOptions(screen.getByLabelText("2行目の勘定科目"), "普通預金");
    await u.click(screen.getByRole("button", { name: "登録する" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "この証憑はすでに仕訳に結びついています",
    );
  });

  it("金額が未入力の証憑でも、金額を空にして開く", async () => {
    mockNewJournalApi(
      () => ok({}),
      receiptDetail({ amount: null, transactionDate: null, partnerName: null }),
    );
    renderNewFromReceipt();
    expect(await screen.findByLabelText("1行目の金額")).toHaveValue("");
    expect(screen.getByLabelText("メモ")).toHaveValue("");
  });
});

// ---- 仕訳の一覧・詳細の証憑 ----

const journalFixture = (journalNo: number, extra: Record<string, unknown> = {}) => ({
  id: uuid(9000 + journalNo),
  journalNo,
  date: "2026-10-20",
  fiscalPeriodId: "p2026",
  memo: null,
  status: "active",
  correctsJournalId: null,
  source: "manual",
  version: 1,
  createdAt: "2026-10-31T09:00:00.000Z",
  updatedAt: "2026-10-31T09:00:00.000Z",
  lines: [
    {
      id: uuid(9100 + journalNo),
      lineNo: 1,
      side: "debit",
      accountId: bank.id,
      subAccountId: null,
      amount: 1100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
    {
      id: uuid(9200 + journalNo),
      lineNo: 2,
      side: "credit",
      accountId: supplies.id,
      subAccountId: null,
      amount: 1100,
      taxCategory: "OUT_OF_SCOPE",
      taxAmount: 0,
      partnerId: null,
      description: null,
      tagIds: [],
    },
  ],
  ...extra,
});

describe("仕訳の一覧の証憑の印", () => {
  beforeEach(() => {
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [bank, supplies] }),
      [`GET ${ENTITY}/partners`]: () => ok({ partners: [] }),
      [`GET ${ENTITY}/tags`]: () => ok({ tags: [] }),
      [`GET ${ENTITY}/journals`]: () =>
        ok({
          journals: [
            journalFixture(2, { receiptCount: 2 }),
            journalFixture(1, { receiptCount: 0 }),
          ],
          nextCursor: null,
        }),
    });
  });

  it("証憑が結びついた仕訳にだけ、件数の印を出す", async () => {
    renderRoute(JournalsRoute, { path: "/e/$entityId/journals/", url: "/e/e1/journals" });
    const table = await screen.findByRole("table", { name: "仕訳の一覧" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByText("証憑 2")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText(/証憑/)).not.toBeInTheDocument();
  });
});

describe("仕訳の詳細の証憑", () => {
  const summaries: ReceiptSummary[] = [
    receiptSummary({ id: uuid(5001), partnerName: "合成の店", amount: 1100 }),
    receiptSummary({ id: uuid(5002), partnerName: null, amount: null, transactionDate: null }),
  ];

  function mockDetail(receipts: ReceiptSummary[] | undefined) {
    const journal = journalFixture(4);
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [bank, supplies] }),
      [`GET ${ENTITY}/partners`]: () => ok({ partners: [] }),
      [`GET ${ENTITY}/tags`]: () => ok({ tags: [] }),
      [`GET ${ENTITY}/tax-settings`]: () => ok({ taxSettings: [] }),
      [`GET ${ENTITY}/tax-categories`]: () =>
        ok({ taxCategories: [{ code: "OUT_OF_SCOPE", name: "対象外", kind: null }], taxRates: [] }),
      [`GET ${ENTITY}/fiscal-periods`]: () => ok({ fiscalPeriods: [] }),
      [`GET ${ENTITY}/accounts/${bank.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
      [`GET ${ENTITY}/accounts/${supplies.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
      [`GET ${ENTITY}/journals/${journal.id}`]: () =>
        ok({
          journal,
          correctsJournal: null,
          correctingJournals: [],
          statements: [],
          ...(receipts && { receipts }),
        }),
      [`GET ${ENTITY}/journals/${journal.id}/history`]: () => ok({ history: [] }),
    });
    return journal;
  }

  const renderDetail = (journalId: string) =>
    renderRoute(JournalDetailRoute, {
      path: "/e/$entityId/journals/$journalId",
      url: `/e/e1/journals/${journalId}`,
    });

  it("結びついた証憑を並べ、それぞれの詳細を開くリンクを付ける", async () => {
    const journal = mockDetail(summaries);
    renderDetail(journal.id);
    const list = await screen.findByRole("list", { name: "元の証憑" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("合成の店");
    expect(items[0]).toHaveTextContent("1,100");
    expect(items[1]).toHaveTextContent("未入力");
    expect(
      within(items[0] as HTMLElement).getByRole("link", { name: "証憑を開く" }),
    ).toHaveAttribute("href", `/e/e1/receipts/${uuid(5001)}`);
  });

  it("証憑がなければ何も出さない（応答に receipts がなくても）", async () => {
    const journal = mockDetail(undefined);
    renderDetail(journal.id);
    await screen.findByRole("heading", { name: "仕訳 No.4" });
    expect(screen.queryByRole("list", { name: "元の証憑" })).not.toBeInTheDocument();
  });
});
