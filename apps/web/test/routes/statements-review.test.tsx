import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route as StatementsRoute } from "@/routes/e/$entityId/statements/index";
import { type ApiCall, type ApiReply, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 007/R17・011 FR-021: 明細の確認。未処理の行の一覧で、利用者が行を選んで承認・除外する（最初は何も選ばない）。
// 既存の仕訳がある行（match）は選択の対象外。しきい値は「確信度の高い行を選択」の補助だけ

const BASE = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (n: number, name: string, category: Account["category"]): Account => ({
  id: uuid(n),
  code: String(n),
  name,
  category,
  normalSide: "debit",
  reportSection: category === "asset" ? "BS_ASSET" : "PL_EXPENSE",
  reportLine: null,
  sortOrder: n,
  isSystem: false,
  isActive: true,
});
const CASH = account(1010, "現金", "asset");
const BANK = account(1020, "普通預金", "asset");
const SUPPLIES = account(6010, "消耗品費", "expense");
const TRAVEL = account(6020, "旅費交通費", "expense");
const ACCOUNTS = [CASH, BANK, SUPPLIES, TRAVEL];

const STATEMENT_ACCOUNT = {
  id: uuid(7000),
  name: "サンプル銀行",
  usage: "business",
  kind: "bank",
  accountId: BANK.id,
  subAccountId: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const SETTINGS = {
  bulkThreshold: 80,
  externalThreshold: 60,
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const TAX_CATEGORIES = [
  { code: "PURCHASE_10", name: "課税仕入 10%", kind: null },
  { code: "OUT_OF_SCOPE", name: "対象外", kind: null },
];

const statement = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  date: "2026-05-10",
  amount: -1200,
  content: `明細${n}`,
  accountName: "サンプル銀行",
  usage: "business",
  status: "unprocessed",
  changed: null,
  candidate: null,
  links: [],
  ...over,
});

const line = (
  side: "debit" | "credit",
  accountId: string,
  amount: number,
  taxCategory = "OUT_OF_SCOPE",
) => ({ side, accountId, amount, taxCategory });

/** 相手の行が 1 行の案（出金。借方に相手、貸方に明細の口座） */
const expense = (
  method: string,
  confidence: number,
  counter: Account = SUPPLIES,
  amount = 1200,
) => ({
  method,
  purpose: "business",
  confidence,
  reason: `${method} の根拠`,
  draft: {
    date: "2026-05-10",
    memo: "メモ",
    lines: [line("debit", counter.id, amount, "PURCHASE_10"), line("credit", BANK.id, amount)],
  },
});
const matched = {
  method: "match",
  purpose: "business",
  confidence: 92,
  reason: "既存の仕訳 No.3（日付の差 1 日）と一致",
  draft: null,
  match: { journalId: uuid(9001), lineId: uuid(9102) },
};
const none = {
  method: "none",
  purpose: null,
  confidence: null,
  reason: "既存の仕訳・振替の対に一致しません",
  draft: null,
};

const RULE = statement(1, { content: "文房具", candidate: expense("rule", 90) });
const LOW = statement(2, {
  content: "交通費",
  amount: -500,
  candidate: expense("local_ai", 50, TRAVEL, 500),
});
const RENT = statement(3, { content: "家賃", amount: -80_000, candidate: matched });
const NONE = statement(4, { content: "不明な支出", candidate: none });
const MOVE = statement(5, {
  content: "口座間の移動",
  amount: -5000,
  candidate: {
    method: "transfer",
    purpose: "business",
    confidence: 95,
    reason: "振替の対（テストカードA 2026-05-10）",
    draft: {
      date: "2026-05-10",
      memo: "口座間の移動",
      lines: [line("debit", CASH.id, 5000), line("credit", BANK.id, 5000)],
    },
  },
});
const SPLIT = statement(6, {
  content: "分割の支出",
  candidate: {
    method: "external_ai",
    purpose: "business",
    confidence: 85,
    reason: "分割の根拠",
    draft: {
      date: "2026-05-10",
      lines: [
        line("debit", SUPPLIES.id, 700, "PURCHASE_10"),
        line("debit", TRAVEL.id, 500, "PURCHASE_10"),
        line("credit", BANK.id, 1200),
      ],
    },
  },
});
const UNMADE = statement(7, { content: "候補が未作成の明細", candidate: null });
const ALL = [RULE, LOW, RENT, NONE, MOVE, SPLIT, UNMADE];

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === `${BASE}${path}`);

type Statement = ReturnType<typeof statement>;

function openApi(
  initial: Statement[],
  extra: Record<string, Parameters<typeof mockApi>[0][string]> = {},
) {
  const state = { statements: initial };
  const all = mockApi({
    [`GET ${BASE}/accounts`]: () => ok({ accounts: ACCOUNTS }),
    [`GET ${BASE}/partners`]: () => ok({ partners: [] }),
    [`GET ${BASE}/tags`]: () => ok({ tags: [] }),
    [`GET ${BASE}/tax-settings`]: () =>
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
    [`GET ${BASE}/tax-categories`]: () => ok({ taxCategories: TAX_CATEGORIES, taxRates: [] }),
    [`GET ${BASE}/statement-accounts`]: () => ok({ accounts: [STATEMENT_ACCOUNT] }),
    [`GET ${BASE}/statement-settings`]: () => ok({ settings: SETTINGS }),
    [`GET ${BASE}/statements`]: () => ok({ statements: state.statements }),
    [`GET ${BASE}/journals`]: () => ok({ journals: [], nextCursor: null }),
    ...extra,
  });
  return { all, state };
}

const renderList = () =>
  renderRoute(StatementsRoute, { path: "/e/$entityId/statements/", url: "/e/e1/statements" });

const region = () => screen.findByRole("region", { name: "明細の確認" });
const tableOf = async () => within(await region()).findByRole("table", { name: "未処理の明細" });
/** 内容の文字が完全に一致する行（行の名前には科目の選択肢の文字も入るので、名前では探さない） */
const rowOf = async (content: string) => {
  const row = within(await tableOf())
    .getByText(content, { exact: true })
    .closest("tr");
  if (row === null) throw new Error(`行がありません: ${content}`);
  return row;
};
const check = async (u: ReturnType<typeof userEvent.setup>, content: string) =>
  u.click(within(await rowOf(content)).getByRole("checkbox", { name: `${content} を選択` }));
const primaryButtons = () =>
  screen
    .queryAllByRole("button")
    .filter((b) => b.className.split(" ").includes("bg-primary"))
    .map((b) => b.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+09:00"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("明細の確認の表（007/R17）", () => {
  it("未処理の行を、選択・日付・口座と内容・金額・相手の科目・税区分・出どころ・操作つきで出す。最初はどの行も選ばない", async () => {
    openApi(ALL);
    renderList();

    const row = await rowOf("文房具");
    expect(row).toHaveTextContent("2026-05-10");
    expect(row).toHaveTextContent("サンプル銀行");
    expect(row).toHaveTextContent("-1,200");
    expect(row).toHaveTextContent("ルール");
    expect(within(row).getByLabelText("文房具 の相手の科目")).toHaveValue(SUPPLIES.id);
    expect(within(row).getByLabelText("文房具 の税区分")).toHaveValue("PURCHASE_10");
    for (const name of ["登録", "除外", "詳細"]) {
      expect(within(row).getByRole("button", { name })).toBeEnabled();
    }
    expect(await rowOf("交通費")).toHaveTextContent("端末内の AI");
    expect(await rowOf("口座間の移動")).toHaveTextContent("振替の対");
    expect(await rowOf("分割の支出")).toHaveTextContent("外部の AI");

    const boxes = within(await tableOf()).getAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.some((b) => (b as HTMLInputElement).checked)).toBe(false);
    expect(screen.getByRole("button", { name: "選択した 0 件を承認" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "選択した 0 件を除外" })).toBeDisabled();
  });

  it("候補のない行（候補なし・未作成）は選べず、「登録」は出さない。「詳細」と「除外」はある", async () => {
    openApi(ALL);
    renderList();

    for (const content of ["不明な支出", "候補が未作成の明細"]) {
      const row = await rowOf(content);
      expect(within(row).getByRole("checkbox", { name: `${content} を選択` })).toBeDisabled();
      expect(within(row).queryByRole("button", { name: "登録" })).toBeNull();
      expect(within(row).getByRole("button", { name: "詳細" })).toBeEnabled();
      expect(within(row).getByRole("button", { name: "除外" })).toBeEnabled();
    }
    expect(await rowOf("不明な支出")).toHaveTextContent("候補なし");
  });

  it("確信度がしきい値未満の行は、色だけでなく文字（「確信度が低い」）でも示す", async () => {
    openApi(ALL);
    renderList();
    expect(await rowOf("交通費")).toHaveTextContent("確信度が低い");
    expect(await rowOf("文房具")).not.toHaveTextContent("確信度が低い");
    expect(await rowOf("口座間の移動")).not.toHaveTextContent("確信度が低い");
  });

  it("既存の仕訳がある行（match）は「既存の仕訳あり」と理由を出し、選べない。個別に「既存の仕訳と結びつける」で match を送る", async () => {
    const { all } = openApi(ALL, {
      [`POST ${BASE}/statements/approve-bulk`]: () => ok({ approved: [uuid(3)], failed: [] }),
    });
    const u = userEvent.setup();
    renderList();

    const row = await rowOf("家賃");
    expect(row).toHaveTextContent("既存の仕訳あり");
    expect(row).toHaveTextContent("既存の仕訳 No.3（日付の差 1 日）と一致");
    expect(within(row).getByRole("checkbox", { name: "家賃 を選択" })).toBeDisabled();
    expect(within(row).queryByRole("button", { name: "登録" })).toBeNull();

    await u.click(within(row).getByRole("button", { name: "既存の仕訳と結びつける" }));
    await waitFor(() => expect(calls(all, "POST", "/statements/approve-bulk")).toHaveLength(1));
    expect(calls(all, "POST", "/statements/approve-bulk")[0]?.body).toEqual({
      items: [{ statementId: uuid(3), match: { journalId: uuid(9001), lineId: uuid(9102) } }],
    });
    expect(await screen.findByText("1 件を承認しました。")).toBeInTheDocument();
  });

  it("「すべて選択」は、候補の案があり、既存の仕訳がない行だけを選ぶ", async () => {
    openApi(ALL);
    const u = userEvent.setup();
    renderList();
    await tableOf();

    await u.click(screen.getByRole("button", { name: "すべて選択" }));
    // 文房具・交通費・口座間の移動・分割の支出
    expect(await screen.findByRole("button", { name: "選択した 4 件を承認" })).toBeEnabled();
    for (const content of ["文房具", "交通費", "口座間の移動", "分割の支出"]) {
      expect(
        within(await rowOf(content)).getByRole("checkbox", { name: `${content} を選択` }),
      ).toBeChecked();
    }
    for (const content of ["家賃", "不明な支出", "候補が未作成の明細"]) {
      expect(
        within(await rowOf(content)).getByRole("checkbox", { name: `${content} を選択` }),
      ).not.toBeChecked();
    }
  });

  it("「確信度の高い行を選択」は、設定のしきい値以上で、既存の仕訳がない行だけを選ぶ（しきい値の数字は出さない）", async () => {
    openApi(ALL);
    const u = userEvent.setup();
    renderList();
    await tableOf();
    await screen.findByRole("button", { name: "確信度の高い行を選択" });

    await u.click(screen.getByRole("button", { name: "確信度の高い行を選択" }));
    // 文房具 90・口座間の移動 95・分割の支出 85。交通費 50 は選ばない。家賃（match 92）は選ばない
    expect(await screen.findByRole("button", { name: "選択した 3 件を承認" })).toBeEnabled();
    expect(
      within(await rowOf("交通費")).getByRole("checkbox", { name: "交通費 を選択" }),
    ).not.toBeChecked();
    expect(screen.queryByText(/しきい値/)).not.toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "選択を解除" }));
    expect(await screen.findByRole("button", { name: "選択した 0 件を承認" })).toBeDisabled();
  });

  it("選んだ行の承認: 確認のダイアログで件数と金額の合計を示し、items で送る。結果と、できなかった行の理由を出す", async () => {
    const { all } = openApi(ALL, {
      [`POST ${BASE}/statements/approve-bulk`]: () =>
        ok({
          approved: [uuid(1)],
          failed: [
            { statementId: uuid(2), code: "PERIOD_CLOSED", message: "2026 年度は締め済みです" },
          ],
        }),
    });
    const u = userEvent.setup();
    const { queryClient } = renderList();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await check(u, "文房具");
    await check(u, "交通費");

    await u.click(screen.getByRole("button", { name: "選択した 2 件を承認" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("2 件");
    expect(within(dialog).getByText("出金 1,700 円", { exact: true })).toBeInTheDocument();
    expect(within(dialog).queryByText(/入金/)).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("-1,700");
    expect(calls(all, "POST", "/statements/approve-bulk")).toHaveLength(0);

    await u.click(within(dialog).getByRole("button", { name: "承認する" }));
    expect(await screen.findByText("1 件を承認しました。")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/approve-bulk")[0]?.body).toEqual({
      items: [{ statementId: uuid(1) }, { statementId: uuid(2) }],
    });
    const failed = await screen.findByRole("list", { name: "できなかった明細" });
    expect(failed).toHaveTextContent("交通費");
    expect(failed).toHaveTextContent("2026 年度は締め済みです");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "journals"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "reports"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "home"] });
    await waitFor(() => expect(calls(all, "GET", "/statements").length).toBeGreaterThan(1));
  });

  it("ダイアログで戻ると、何も送らない", async () => {
    const { all } = openApi(ALL);
    const u = userEvent.setup();
    renderList();
    await check(u, "文房具");

    await u.click(screen.getByRole("button", { name: "選択した 1 件を承認" }));
    const dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(all, "POST", "/statements/approve-bulk")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "選択した 1 件を承認" })).toBeEnabled();
  });

  it("相手の科目・税区分を選び直した行だけ draft を送る。選び直さない行は draft を送らない", async () => {
    const { all } = openApi(ALL, {
      [`POST ${BASE}/statements/approve-bulk`]: () =>
        ok({ approved: [uuid(1), uuid(5)], failed: [] }),
    });
    const u = userEvent.setup();
    renderList();
    const row = await rowOf("文房具");
    await u.selectOptions(within(row).getByLabelText("文房具 の相手の科目"), "旅費交通費");
    await u.selectOptions(within(row).getByLabelText("文房具 の税区分"), "対象外");
    await check(u, "文房具");
    await check(u, "口座間の移動");

    await u.click(screen.getByRole("button", { name: "選択した 2 件を承認" }));
    await u.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "承認する" }),
    );
    await waitFor(() => expect(calls(all, "POST", "/statements/approve-bulk")).toHaveLength(1));
    const body = calls(all, "POST", "/statements/approve-bulk")[0]?.body as { items: unknown[] };
    const items = body.items;
    expect(items[0]).toMatchObject({
      statementId: uuid(1),
      draft: {
        date: "2026-05-10",
        lines: [
          { side: "debit", accountId: TRAVEL.id, amount: 1200, taxCategory: "OUT_OF_SCOPE" },
          { side: "credit", accountId: BANK.id, amount: 1200 },
        ],
      },
    });
    expect(items[1]).toEqual({ statementId: uuid(5) });
  });

  it("明細の口座でない行が 2 行以上の案は、その場で選び直せず「詳細で編集」を示す", async () => {
    openApi(ALL);
    renderList();
    const row = await rowOf("分割の支出");
    expect(row).toHaveTextContent("詳細で編集");
    expect(within(row).queryByLabelText("分割の支出 の相手の科目")).toBeNull();
    expect(within(row).queryByLabelText("分割の支出 の税区分")).toBeNull();
  });

  it("行の「登録」は、その行だけを承認する（選んでいなくてもよい）。選び直した科目は draft で送る", async () => {
    const { all } = openApi(ALL, {
      [`POST ${BASE}/statements/approve-bulk`]: () => ok({ approved: [uuid(1)], failed: [] }),
    });
    const u = userEvent.setup();
    renderList();

    await u.click(within(await rowOf("文房具")).getByRole("button", { name: "登録" }));
    await waitFor(() => expect(calls(all, "POST", "/statements/approve-bulk")).toHaveLength(1));
    expect(calls(all, "POST", "/statements/approve-bulk")[0]?.body).toEqual({
      items: [{ statementId: uuid(1) }],
    });
    expect(await screen.findByText("1 件を承認しました。")).toBeInTheDocument();
  });

  it("行の「除外」は、その行だけを理由なしで除外する", async () => {
    const { all } = openApi(ALL, {
      [`POST ${BASE}/statements/exclude-bulk`]: () => ok({ excluded: [uuid(4)], failed: [] }),
    });
    const u = userEvent.setup();
    renderList();

    await u.click(within(await rowOf("不明な支出")).getByRole("button", { name: "除外" }));
    await waitFor(() => expect(calls(all, "POST", "/statements/exclude-bulk")).toHaveLength(1));
    expect(calls(all, "POST", "/statements/exclude-bulk")[0]?.body).toEqual({
      statementIds: [uuid(4)],
    });
    expect(await screen.findByText("1 件を除外しました。")).toBeInTheDocument();
  });

  it("確認のダイアログは、出金と入金を分けて出す（相殺しない）。入金だけなら出金は出さない", async () => {
    const SALES = statement(8, {
      content: "売上の入金",
      amount: 3000,
      candidate: expense("rule", 90),
    });
    openApi([RULE, LOW, SALES]);
    const u = userEvent.setup();
    renderList();
    await check(u, "文房具");
    await check(u, "交通費");
    await check(u, "売上の入金");

    await u.click(screen.getByRole("button", { name: "選択した 3 件を承認" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("3 件");
    expect(within(dialog).getByText("出金 1,700 円", { exact: true })).toBeInTheDocument();
    expect(within(dialog).getByText("入金 3,000 円", { exact: true })).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("1,300");
    await u.click(within(dialog).getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await check(u, "文房具");
    await check(u, "交通費");
    await u.click(screen.getByRole("button", { name: "選択した 1 件を除外" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("入金 3,000 円", { exact: true })).toBeInTheDocument();
    expect(within(dialog).queryByText(/出金/)).not.toBeInTheDocument();
  });

  it("選んだ行の除外: 確認のダイアログの後に exclude-bulk で送り、できなかった行の理由を出す", async () => {
    const { all } = openApi(ALL, {
      [`POST ${BASE}/statements/exclude-bulk`]: () =>
        ok({
          excluded: [uuid(1)],
          failed: [{ statementId: uuid(2), code: "NOT_FOUND", message: "明細が見つかりません" }],
        }),
    });
    const u = userEvent.setup();
    const { queryClient } = renderList();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await check(u, "文房具");
    await check(u, "交通費");

    await u.click(screen.getByRole("button", { name: "選択した 2 件を除外" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("2 件");
    expect(within(dialog).getByText("出金 1,700 円", { exact: true })).toBeInTheDocument();
    expect(within(dialog).queryByText(/入金/)).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole("button", { name: "除外する" }));

    expect(await screen.findByText("1 件を除外しました。")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/exclude-bulk")[0]?.body).toEqual({
      statementIds: [uuid(1), uuid(2)],
    });
    const failed = await screen.findByRole("list", { name: "できなかった明細" });
    expect(failed).toHaveTextContent("交通費");
    expect(failed).toHaveTextContent("明細が見つかりません");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "home"] });
    expect(calls(all, "POST", "/statements/approve-bulk")).toHaveLength(0);
  });

  it("「詳細」は候補の確認（CandidateEditor）を開く。閉じられる", async () => {
    openApi(ALL);
    const u = userEvent.setup();
    renderList();

    await u.click(within(await rowOf("文房具")).getByRole("button", { name: "詳細" }));
    const editor = await screen.findByRole("region", { name: "候補の確認" });
    expect(editor).toHaveTextContent("文房具");
    await u.click(within(editor).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("region", { name: "候補の確認" })).not.toBeInTheDocument();
  });

  it("「詳細」の確認は、画面の一番下ではなく、その行のすぐ下に開く", async () => {
    openApi(ALL);
    const u = userEvent.setup();
    renderList();

    const row = await rowOf("文房具");
    await u.click(within(row).getByRole("button", { name: "詳細" }));
    const editor = await screen.findByRole("region", { name: "候補の確認" });
    const next = row.nextElementSibling;
    expect(next).not.toBeNull();
    expect(next?.contains(editor)).toBe(true);
    expect(within(await tableOf()).getByRole("region", { name: "候補の確認" })).toBe(editor);
  });

  it("画面の主な操作（variant=default）は「選択した N 件を承認」だけ", async () => {
    openApi(ALL);
    const u = userEvent.setup();
    renderList();
    await tableOf();
    expect(primaryButtons()).toEqual(["選択した 0 件を承認"]);
    await check(u, "文房具");
    expect(primaryButtons()).toEqual(["選択した 1 件を承認"]);
  });

  it("全部を処理して未処理がなくなっても、結果の知らせは残る", async () => {
    const { state } = openApi([RULE], {
      [`POST ${BASE}/statements/approve-bulk`]: () => {
        state.statements = [];
        return ok({ approved: [uuid(1)], failed: [] });
      },
    });
    const u = userEvent.setup();
    renderList();
    await u.click(within(await rowOf("文房具")).getByRole("button", { name: "登録" }));
    expect(await screen.findByText("1 件を承認しました。")).toBeInTheDocument();
    expect(await screen.findByText("該当する明細はありません。")).toBeInTheDocument();
    expect(screen.getByText("1 件を承認しました。")).toBeInTheDocument();
  });
});

describe("明細の一覧を開いたときの候補の作り直し（007/R17）", () => {
  it("上にボタンを並べない。「明細を取り込む」「推定のルール」「1 件ずつ確認する」「候補をもう一度作る」「AI で推定」は出さない", async () => {
    openApi(ALL);
    renderList();
    await tableOf();
    for (const name of ["明細を取り込む", "推定のルール", "1 件ずつ確認する"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    for (const name of ["候補をもう一度作る", "AI で推定"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("見出し（明細）の下に説明の文は置かない", async () => {
    openApi(ALL);
    renderList();
    await tableOf();
    expect(screen.getByRole("heading", { level: 1, name: "明細" })).toBeInTheDocument();
    expect(screen.queryByText(/取り込んだ明細を確かめて/)).not.toBeInTheDocument();
  });

  it("状態と口座の絞り込みは、選択のボタンと同じ行に置く（確認の領域の中）", async () => {
    openApi(ALL);
    renderList();
    const box = await region();
    const selectAll = await within(box).findByRole("button", { name: "すべて選択" });
    const status = within(box).getByLabelText("状態");
    expect(within(box).getByLabelText("口座")).toBeInTheDocument();
    expect(status.closest("div[class*='flex']")).toBe(selectAll.closest("div[class*='flex']"));
  });

  it("未処理の明細が 0 件でも、絞り込みは残る（別の状態へ切り替えられる）", async () => {
    openApi([]);
    renderList();
    const box = await region();
    expect(within(box).getByLabelText("状態")).toBeInTheDocument();
    expect(within(box).getByLabelText("口座")).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "すべて選択" })).toBeNull();
  });

  it("未処理の明細があれば、開いたとき 1 回だけ候補を作り直す。作り直し中は「候補を更新中…」。AI に回す明細は自動で推定する", async () => {
    let release: (reply: ApiReply) => void = () => {};
    const all = openApi(ALL, {
      [`POST ${BASE}/statements/candidates`]: () =>
        new Promise<ApiReply>((resolve) => {
          release = resolve;
        }),
    }).all;
    renderList();

    expect(await screen.findByText("候補を更新中…")).toBeInTheDocument();
    release(ok({ built: 3, needsAi: [uuid(4), uuid(7)] }));
    await waitFor(() => expect(screen.queryByText("候補を更新中…")).toBeNull());
    await waitFor(() => expect(calls(all, "POST", "/statements/infer")).toHaveLength(1));
    expect(calls(all, "POST", "/statements/infer")[0]?.body).toEqual({
      statementIds: [uuid(4), uuid(7)],
    });
    // 候補の更新の後に一覧を読み直しても、もう一度は呼ばない
    await waitFor(() => expect(calls(all, "GET", "/statements").length).toBeGreaterThan(1));
    expect(calls(all, "POST", "/statements/candidates")).toHaveLength(1);
    expect(calls(all, "POST", "/statements/candidates")[0]?.body).toEqual({});
  });

  it("未処理の明細がなければ、候補を作り直さない", async () => {
    const all = openApi([]).all;
    renderList();
    expect(await screen.findByText("該当する明細はありません。")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/candidates")).toHaveLength(0);
  });
});
