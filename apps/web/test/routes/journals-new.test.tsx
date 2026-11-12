import { screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import type { JournalDraft, JournalSuggestion } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/journals/new";
import { advance, fakeClockUser, useFakeClock } from "../fake-timers";
import { account, ENTITY, uuid } from "../fixtures";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const asset = { category: "asset", normalSide: "debit", reportSection: "BS_ASSET" } as const;
const bank = account(1020, "普通預金", asset);
const receivable = account(1100, "売掛金", asset);
const owner = account(1900, "事業主貸", asset);
const sales = account(4010, "売上高", {
  category: "revenue",
  normalSide: "credit",
  reportSection: "PL_SALES",
});
const supplies = account(6010, "消耗品費", {
  category: "expense",
  normalSide: "debit",
  reportSection: "PL_EXPENSE",
});
const stopped = account(6020, "停止中の経費", {
  category: "expense",
  normalSide: "debit",
  reportSection: "PL_EXPENSE",
  isActive: false,
});
const accounts = [sales, bank, supplies, receivable, stopped, owner];

const subA = { id: uuid(5001), accountId: receivable.id, name: "A社", isActive: true };
const partnerA = { id: uuid(7001), name: "取引先A", honorific: "御中", memo: null, isActive: true };
const partnerB = { ...partnerA, id: uuid(7002), name: "取引先B" };
const stoppedPartner = { ...partnerA, id: uuid(7003), name: "停止中の取引先", isActive: false };
const tags = [
  { id: uuid(8001), name: "定期" },
  { id: uuid(8002), name: "源泉" },
];

const TAX_CATEGORIES = [
  { code: "OUT_OF_SCOPE", name: "対象外", kind: null },
  { code: "SALES_10", name: "課税売上 10%", kind: "sales" },
  { code: "SALES_8R", name: "課税売上 8%（軽減）", kind: "sales" },
  { code: "PURCHASE_10", name: "課税仕入 10%", kind: "purchase" },
  { code: "PURCHASE_8R", name: "課税仕入 8%（軽減）", kind: "purchase" },
];

/** 2026-07-01 から課税事業者（税込経理） */
const taxSettings = [
  {
    id: "t1",
    effectiveFrom: "2026-01-01",
    taxpayerStatus: "exempt",
    accountingMethod: "tax_included",
  },
  {
    id: "t2",
    effectiveFrom: "2026-07-01",
    taxpayerStatus: "general",
    accountingMethod: "tax_included",
  },
];

type JournalBody = {
  date: string;
  memo?: string;
  lines: { side: string; accountId: string; amount: number; [key: string]: unknown }[];
};

const savedJournal = (body: JournalBody, journalNo = 1) => ({
  id: uuid(9000 + journalNo),
  journalNo,
  date: body.date,
  fiscalPeriodId: "p2026",
  memo: body.memo ?? null,
  status: "active",
  correctsJournalId: null,
  source: "manual",
  version: 1,
  createdAt: "2026-10-31T09:00:00.000Z",
  updatedAt: "2026-10-31T09:00:00.000Z",
  lines: body.lines.map((l, i) => ({
    id: uuid(9100 + i),
    lineNo: i + 1,
    subAccountId: null,
    taxCategory: "OUT_OF_SCOPE",
    taxAmount: 0,
    partnerId: null,
    description: null,
    tagIds: [],
    ...l,
  })),
});

function mockJournalApi(
  post?: Parameters<typeof mockApi>[0][string],
  extra: Parameters<typeof mockApi>[0] = {},
) {
  return mockApi({
    ...extra,
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
    [`GET ${ENTITY}/partners`]: () => ok({ partners: [partnerA, partnerB, stoppedPartner] }),
    [`GET ${ENTITY}/tags`]: () => ok({ tags }),
    [`GET ${ENTITY}/tax-settings`]: () => ok({ taxSettings }),
    [`GET ${ENTITY}/tax-categories`]: () => ok({ taxCategories: TAX_CATEGORIES, taxRates: [] }),
    ...Object.fromEntries(
      accounts.map((a) => [
        `GET ${ENTITY}/accounts/${a.id}/sub-accounts`,
        () => ok({ subAccounts: a.id === receivable.id ? [subA] : [] }),
      ]),
    ),
    ...(post && { [`POST ${ENTITY}/journals`]: post }),
  });
}

async function renderNewJournal() {
  const result = renderRoute(Route, {
    path: "/e/$entityId/journals/new",
    url: "/e/e1/journals/new",
  });
  await user().click(await screen.findByRole("button", { name: "詳細" }));
  return result;
}

/** 合計欄の「借方合計」「貸方合計」「差額」の値 */
function total(name: "借方合計" | "貸方合計" | "差額") {
  return within(screen.getByLabelText("合計")).getByText(name).nextElementSibling?.textContent;
}

/** 入力欄の aria-describedby が指すメッセージ */
function messageOf(field: HTMLElement) {
  const ids = field.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join("");
}

const user = fakeClockUser;
// src の定数（NewJournalEntry.tsx の下書き保存 1000ms、JournalSuggestions.tsx の候補の検索 300ms）。export されていない
const DRAFT_SAVE_MS = 1000;
const SUGGEST_DEBOUNCE_MS = 300;

describe("かんたん入力（011/T015）", () => {
  it("Enterだけで2行を登録し、自動の税は送らず日付を残して借方へ戻る", async () => {
    let posted: JournalBody | undefined;
    mockJournalApi((call) => {
      posted = call.body as JournalBody;
      return ok({ journal: savedJournal(posted), warnings: [] }, 201);
    });
    const u = user();
    renderRoute(Route, { path: "/e/$entityId/journals/new", url: "/e/e1/journals/new" });
    const date = await screen.findByLabelText("日付");
    expect(date).toHaveFocus();
    await u.keyboard("{Enter}");
    expect(screen.getByRole("combobox", { name: "借方科目" })).toHaveFocus();
    await u.keyboard("6010{Enter}");
    expect(screen.getByRole("combobox", { name: "貸方科目" })).toHaveFocus();
    await u.keyboard("1020{Enter}");
    expect(screen.getByLabelText("金額", { exact: true })).toHaveFocus();
    await u.keyboard("1100{Enter}");
    expect(screen.getByLabelText("摘要", { exact: true })).toHaveFocus();
    await u.keyboard("文房具{Enter}");
    await waitFor(() =>
      expect(posted).toMatchObject({
        date: "2026-10-31",
        memo: "文房具",
        lines: [
          { side: "debit", accountId: supplies.id, amount: 1100 },
          { side: "credit", accountId: bank.id, amount: 1100 },
        ],
      }),
    );
    expect(posted?.lines.every((line) => line.taxCategory === undefined)).toBe(true);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "借方科目" })).toHaveFocus());
    expect(screen.getByLabelText("日付")).toHaveValue("2026-10-31");
    expect(screen.getByLabelText("金額", { exact: true })).toHaveValue("");
  });

  it("左右別の税・取引先とタグを保持して詳細と往復でき、停止中の候補は出さない", async () => {
    let posted: JournalBody | undefined;
    mockJournalApi((call) => {
      posted = call.body as JournalBody;
      return ok({ journal: savedJournal(posted), warnings: [] });
    });
    const u = user();
    renderRoute(Route, { path: "/e/$entityId/journals/new", url: "/e/e1/journals/new" });
    const debit = await screen.findByRole("combobox", { name: "借方科目" });
    await u.click(debit);
    expect(screen.queryByRole("option", { name: /停止中/ })).not.toBeInTheDocument();
    await u.type(debit, "6010{Enter}");
    await u.keyboard("1020{Enter}1100");
    await u.click(screen.getByText("任意項目", { exact: true }));
    expect(
      within(screen.getByLabelText("借方税区分")).getByRole("option", { selected: true }),
    ).toHaveTextContent("自動（課税仕入 10%）");
    await u.clear(screen.getByLabelText("日付"));
    await u.type(screen.getByLabelText("日付"), "2026-06-30");
    expect(
      within(screen.getByLabelText("借方税区分")).getByRole("option", { selected: true }),
    ).toHaveTextContent("自動（対象外）");
    await u.selectOptions(screen.getByLabelText("借方税区分"), "PURCHASE_8R");
    await u.selectOptions(screen.getByLabelText("貸方税区分"), "OUT_OF_SCOPE");
    const debitPartner = screen.getByRole("combobox", { name: "借方取引先" });
    await u.click(debitPartner);
    expect(screen.queryByRole("option", { name: "停止中の取引先" })).not.toBeInTheDocument();
    await u.type(debitPartner, "取引先A{Enter}");
    await u.type(screen.getByRole("combobox", { name: "貸方取引先" }), "取引先B{Enter}");
    await u.selectOptions(screen.getByLabelText("タグ", { exact: true }), uuid(8001));
    await u.click(screen.getByRole("button", { name: "詳細" }));
    expect(screen.getByLabelText("1行目の金額")).toHaveValue("1100");
    expect(screen.getByLabelText("1行目の税区分")).toHaveValue("PURCHASE_8R");
    await u.click(screen.getByRole("button", { name: "かんたん入力" }));
    expect(screen.getByLabelText("金額", { exact: true })).toHaveValue("1100");
    await u.click(screen.getByRole("button", { name: "登録" }));
    await waitFor(() =>
      expect(posted?.lines).toMatchObject([
        { taxCategory: "PURCHASE_8R", partnerId: partnerA.id, tagIds: [uuid(8001)] },
        { taxCategory: "OUT_OF_SCOPE", partnerId: partnerB.id, tagIds: [uuid(8001)] },
      ]),
    );
  });

  it("詳細で最後の空欄に差額を補い、自動で入れた値は他の行の変更に追従し、手で直した行は追従しない", async () => {
    mockJournalApi();
    const u = user();
    await renderNewJournal();
    await fillLine(u, 1, { account: "消耗品費", amount: "1000" });
    await u.tab();
    expect(screen.getByLabelText("2行目の金額")).toHaveValue("1000");
    // 自動で入れた行は、1行目を直すと差額に合わせ直す
    await fillLine(u, 1, { account: "消耗品費", amount: "2000" });
    await u.tab();
    expect(screen.getByLabelText("2行目の金額")).toHaveValue("2000");
    expect(total("差額")).toBe("0 円");
    // 差額がなくなったら自動で入れた値を消す
    await u.clear(screen.getByLabelText("1行目の金額"));
    await u.tab();
    expect(screen.getByLabelText("2行目の金額")).toHaveValue("");
    // 手で入れた行は、その後の変更で書き換えない
    await fillLine(u, 1, { account: "消耗品費", amount: "1000" });
    await u.tab();
    expect(screen.getByLabelText("2行目の金額")).toHaveValue("1000");
    await u.clear(screen.getByLabelText("2行目の金額"));
    await u.type(screen.getByLabelText("2行目の金額"), "700");
    await fillLine(u, 1, { account: "消耗品費", amount: "3000" });
    await u.tab();
    expect(screen.getByLabelText("2行目の金額")).toHaveValue("700");
  });

  it("複合仕訳では他の行が増えるたびに最後の行の差額を補い直し、手で直したら止める", async () => {
    mockJournalApi();
    const u = user();
    await renderNewJournal();
    await u.click(screen.getByRole("button", { name: "行を追加" }));
    // 借方 1000・借方 500・貸方（最後の行、空）
    await u.selectOptions(screen.getByLabelText("2行目の貸借"), "借方");
    await u.selectOptions(screen.getByLabelText("3行目の貸借"), "貸方");
    await fillLine(u, 1, { account: "消耗品費", amount: "1000" });
    await u.tab();
    expect(screen.getByLabelText("3行目の金額")).toHaveValue("1000");
    await fillLine(u, 2, { account: "消耗品費", amount: "500" });
    await u.tab();
    expect(screen.getByLabelText("3行目の金額")).toHaveValue("1500");
    await fillLine(u, 1, { account: "消耗品費", amount: "2000" });
    await u.tab();
    expect(screen.getByLabelText("3行目の金額")).toHaveValue("2500");
    expect(total("差額")).toBe("0 円");
    // 手で直した最後の行は、以後書き換えない
    await u.clear(screen.getByLabelText("3行目の金額"));
    await u.type(screen.getByLabelText("3行目の金額"), "2600");
    await fillLine(u, 2, { account: "消耗品費", amount: "600" });
    await u.tab();
    expect(screen.getByLabelText("3行目の金額")).toHaveValue("2600");
  });

  it("詳細で情報を落とす切替を止める", async () => {
    mockJournalApi();
    const u = user();
    await renderNewJournal();
    await fillLine(u, 1, { account: "消耗品費", amount: "1000" });
    await fillLine(u, 2, { account: "普通預金", amount: "900" });
    expect(screen.getByRole("button", { name: "かんたん入力" })).toBeDisabled();
    await fillLine(u, 2, { account: "普通預金", amount: "1000" });
    await u.type(screen.getByLabelText("1行目の摘要"), "行だけの摘要");
    expect(screen.getByRole("button", { name: "かんたん入力" })).toBeDisabled();
    expect(screen.getByText(/詳細の入力を保持/)).toBeInTheDocument();
  });

  it("かんたん入力のまま会計期間の外のエラーを受けたら、日付の下に会計期間を作成するリンクを出す", async () => {
    const message = "日付が会計期間の外です。先に会計期間を作成してください";
    mockJournalApi(() =>
      apiError(422, "OUT_OF_PERIOD", message, {
        date: "2027-01-05",
        suggest: "create_fiscal_period",
        errors: [
          {
            code: "OUT_OF_PERIOD",
            message,
            details: { date: "2027-01-05", suggest: "create_fiscal_period" },
          },
        ],
      }),
    );
    const u = user();
    renderRoute(Route, { path: "/e/$entityId/journals/new", url: "/e/e1/journals/new" });
    const form = await screen.findByRole("form", { name: "仕訳" });
    const quick = within(form);
    await u.keyboard("{Enter}");
    await u.keyboard("6010{Enter}1020{Enter}1100");
    expect(quick.queryByRole("link", { name: "会計期間を作成する" })).not.toBeInTheDocument();
    await u.click(quick.getByRole("button", { name: "登録" }));

    const link = await quick.findByRole("link", { name: "会計期間を作成する" });
    expect(link).toHaveAttribute("href", "/e/e1/periods");
    expect(messageOf(quick.getByLabelText("日付"))).toContain("日付が会計期間の外です");
  });
});

async function fillLine(
  u: ReturnType<typeof userEvent.setup>,
  n: number,
  { side, account, amount }: { side?: "借方" | "貸方"; account: string; amount: string },
) {
  if (side) await u.selectOptions(screen.getByLabelText(`${n}行目の貸借`), side);
  await u.selectOptions(screen.getByLabelText(`${n}行目の勘定科目`), account);
  await u.clear(screen.getByLabelText(`${n}行目の金額`));
  await u.type(screen.getByLabelText(`${n}行目の金額`), amount);
}

beforeEach(() => {
  useFakeClock("2026-10-31T10:00:00+09:00");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("仕訳の入力画面（US2）", () => {
  it("詳細入力で登録した後も詳細を保ち、日付を残して次の入力を空にする", async () => {
    const calls = mockJournalApi((call) =>
      ok({ journal: savedJournal(call.body as JournalBody), warnings: [] }, 201),
    );
    const u = user();
    renderRoute(Route, { path: "/e/$entityId/journals/new", url: "/e/e1/journals/new" });
    const quick = await screen.findByRole("button", { name: /^かんたん入力$/ });
    expect(quick).toHaveAttribute("aria-pressed", "true");
    await u.click(screen.getByRole("button", { name: /^詳細$/ }));
    await fillLine(u, 1, { account: "消耗品費", amount: "1100" });
    await fillLine(u, 2, { account: "普通預金", amount: "1100" });
    await u.type(screen.getByLabelText("メモ", { exact: true }), "次へ残さないメモ");
    await u.click(screen.getByRole("button", { name: /^登録$/ }));

    expect(
      await screen.findByText("仕訳 No.1 を登録しました。", { exact: true }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^詳細$/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(screen.getByLabelText("日付", { exact: true })).toHaveValue("2026-10-31");
    expect(screen.getByLabelText("1行目の金額", { exact: true })).toHaveValue("");
    expect(screen.getByLabelText("2行目の金額", { exact: true })).toHaveValue("");
    expect(screen.getByLabelText("メモ", { exact: true })).toHaveValue("");
  });

  it("借方・貸方の2行と今日の日付で始まり、行を追加・削除できる", async () => {
    mockJournalApi();
    const u = user();
    await renderNewJournal();

    expect(await screen.findByLabelText("日付")).toHaveValue("2026-10-31");
    expect(screen.getByLabelText("1行目の貸借")).toHaveValue("debit");
    expect(screen.getByLabelText("2行目の貸借")).toHaveValue("credit");
    expect(screen.queryByLabelText("3行目の勘定科目")).not.toBeInTheDocument();
    // 2行より少なくはできない
    expect(screen.getByRole("button", { name: "削除（1行目）" })).toBeDisabled();

    await u.click(screen.getByRole("button", { name: "行を追加" }));
    await u.click(screen.getByRole("button", { name: "行を追加" }));
    expect(screen.getByLabelText("4行目の勘定科目")).toBeInTheDocument();

    await fillLine(u, 3, { account: "消耗品費", amount: "300" });
    await fillLine(u, 4, { account: "普通預金", amount: "400" });
    await u.click(screen.getByRole("button", { name: "削除（3行目）" }));
    expect(screen.queryByLabelText("4行目の勘定科目")).not.toBeInTheDocument();
    expect(screen.getByLabelText("3行目の金額")).toHaveValue("400");
  });

  it("借方合計・貸方合計・差額を常に表示し、一致しないと差額を示して登録できない", async () => {
    mockJournalApi();
    const u = user();
    await renderNewJournal();
    const save = await screen.findByRole("button", { name: "登録" });
    expect([total("借方合計"), total("貸方合計"), total("差額")]).toEqual(["0 円", "0 円", "0 円"]);

    await fillLine(u, 1, { account: "売掛金", amount: "500,000" });
    await fillLine(u, 2, { account: "売上高", amount: "４９５０００" });
    expect([total("借方合計"), total("貸方合計"), total("差額")]).toEqual([
      "500,000 円",
      "495,000 円",
      "5,000 円",
    ]);
    expect(save).toBeDisabled();
    expect(screen.getByText(/差額が 0 円になると登録できます/)).toBeInTheDocument();

    await u.clear(screen.getByLabelText("1行目の金額"));
    await u.type(screen.getByLabelText("1行目の金額"), "495000");
    expect(total("差額")).toBe("0 円");
    expect(save).toBeEnabled();
  });

  it("使用停止の科目は選べない", async () => {
    mockJournalApi();
    await renderNewJournal();
    const select = await screen.findByLabelText("1行目の勘定科目");
    const names = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names).toContain("消耗品費");
    expect(names).not.toContain("停止中の経費");
    expect(names.some((n) => n?.includes("停止中"))).toBe(false);
  });

  it("税区分の既定値を日付と科目から決める（免税の期間は対象外）", async () => {
    mockJournalApi();
    const u = user();
    await renderNewJournal();
    const tax = await screen.findByLabelText("2行目の税区分");

    await u.selectOptions(screen.getByLabelText("2行目の勘定科目"), "売上高");
    expect(within(tax).getByRole("option", { selected: true })).toHaveTextContent(
      "自動（課税売上 10%）",
    );
    await u.selectOptions(screen.getByLabelText("1行目の勘定科目"), "消耗品費");
    expect(
      within(screen.getByLabelText("1行目の税区分")).getByRole("option", { selected: true }),
    ).toHaveTextContent("自動（課税仕入 10%）");

    await u.clear(screen.getByLabelText("日付"));
    await u.type(screen.getByLabelText("日付"), "2026-06-30");
    expect(within(tax).getByRole("option", { selected: true })).toHaveTextContent("自動（対象外）");
  });

  it("US2-1: 科目・補助科目・取引先・摘要・タグ・税区分・メモを送り、登録後に仕訳番号を示して次の入力に備える", async () => {
    let posted: JournalBody | undefined;
    const calls = mockJournalApi((call: ApiCall) => {
      posted = call.body as JournalBody;
      return ok({ journal: savedJournal(posted), warnings: [] }, 201);
    });
    const u = user();
    const { queryClient } = await renderNewJournal();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await screen.findByLabelText("1行目の勘定科目");

    await u.type(screen.getByLabelText("メモ"), "10月分の請求");
    await fillLine(u, 1, { account: "売掛金", amount: "495000" });
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("1行目の補助科目")).getByRole("option", { name: "A社" }),
      ).toBeInTheDocument(),
    );
    await u.selectOptions(screen.getByLabelText("1行目の補助科目"), "A社");
    await u.selectOptions(screen.getByLabelText("1行目の取引先"), "取引先A");
    await u.type(screen.getByLabelText("1行目の摘要"), "10月分");
    await u.selectOptions(screen.getByLabelText("1行目のタグ"), ["源泉", "定期"]);
    await fillLine(u, 2, { account: "売上高", amount: "495000" });
    await u.selectOptions(screen.getByLabelText("2行目の税区分"), "課税売上 8%（軽減）");
    await u.click(screen.getByRole("button", { name: "登録" }));

    expect(await screen.findByText("仕訳 No.1 を登録しました。")).toBeInTheDocument();
    expect(posted).toEqual({
      date: "2026-10-31",
      memo: "10月分の請求",
      lines: [
        {
          side: "debit",
          accountId: receivable.id,
          subAccountId: subA.id,
          amount: 495_000,
          partnerId: partnerA.id,
          description: "10月分",
          tagIds: [tags[0]?.id, tags[1]?.id],
        },
        { side: "credit", accountId: sales.id, amount: 495_000, taxCategory: "SALES_8R" },
      ],
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    // 仕訳と帳票のクエリを無効化する
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "journals"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "reports"] });
    // 次の仕訳のために入力を空にする（日付は残す）
    expect(screen.getByLabelText("1行目の金額", { exact: true })).toHaveValue("");
    expect(screen.getByLabelText("1行目の摘要", { exact: true })).toHaveValue("");
    expect(screen.getByLabelText("日付")).toHaveValue("2026-10-31");
  });

  it("US2-2: 借方2行・貸方1行の複合仕訳を登録できる", async () => {
    let posted: JournalBody | undefined;
    mockJournalApi((call) => {
      posted = call.body as JournalBody;
      return ok({ journal: savedJournal(posted, 7), warnings: [] }, 201);
    });
    const u = user();
    await renderNewJournal();
    await screen.findByLabelText("1行目の勘定科目");

    await fillLine(u, 1, { account: "普通預金", amount: "487037" });
    await u.click(screen.getByRole("button", { name: "行を追加" }));
    await fillLine(u, 2, { side: "借方", account: "事業主貸", amount: "7963" });
    await fillLine(u, 3, { side: "貸方", account: "売掛金", amount: "495000" });
    await u.click(screen.getByRole("button", { name: "登録" }));

    expect(await screen.findByText("仕訳 No.7 を登録しました。")).toBeInTheDocument();
    expect(posted?.lines.map((l) => [l.side, l.accountId, l.amount])).toEqual([
      ["debit", bank.id, 487_037],
      ["debit", owner.id, 7963],
      ["credit", receivable.id, 495_000],
    ]);
  });

  it("FR-018: 重複の可能性の警告は登録後に知らせる", async () => {
    mockJournalApi((call) =>
      ok(
        {
          journal: savedJournal(call.body as JournalBody, 2),
          warnings: [
            {
              code: "POSSIBLE_DUPLICATE",
              message:
                "直前の仕訳（No.1）と日付・科目・金額が同じです。二重登録でないか確認してください",
              details: { journalId: uuid(9001), journalNo: 1 },
            },
          ],
        },
        201,
      ),
    );
    const u = user();
    await renderNewJournal();
    await screen.findByLabelText("1行目の勘定科目");
    await fillLine(u, 1, { account: "売掛金", amount: "495000" });
    await fillLine(u, 2, { account: "売上高", amount: "495000" });
    await u.click(screen.getByRole("button", { name: "登録" }));

    const status = await screen.findByRole("status", { name: "登録の結果" });
    expect(status).toHaveTextContent("仕訳 No.2 を登録しました。");
    expect(status).toHaveTextContent("直前の仕訳（No.1）と日付・科目・金額が同じです");
  });

  it("API のエラーを該当の行・項目に表示し、会計期間の作成を提案されたらリンクを出す", async () => {
    mockJournalApi(() =>
      apiError(422, "OUT_OF_PERIOD", "日付が会計期間の外です。先に会計期間を作成してください", {
        date: "2027-01-05",
        suggest: "create_fiscal_period",
        errors: [
          {
            code: "OUT_OF_PERIOD",
            message: "日付が会計期間の外です。先に会計期間を作成してください",
            details: { date: "2027-01-05", suggest: "create_fiscal_period" },
          },
          {
            code: "ACCOUNT_INACTIVE",
            message: "勘定科目「売上高」は使用停止です",
            details: { lineIndex: 1, field: "accountId", accountId: sales.id },
          },
          {
            code: "VALIDATION",
            message: "取引先が見つかりません",
            details: { lineIndex: 0, field: "partnerId" },
          },
        ],
      }),
    );
    const u = user();
    await renderNewJournal();
    await screen.findByLabelText("1行目の勘定科目");
    await u.clear(screen.getByLabelText("日付"));
    await u.type(screen.getByLabelText("日付"), "2027-01-05");
    await fillLine(u, 1, { account: "売掛金", amount: "495000" });
    await fillLine(u, 2, { account: "売上高", amount: "495000" });
    await u.click(screen.getByRole("button", { name: "登録" }));

    const date = screen.getByLabelText("日付");
    await waitFor(() => expect(date).toHaveAttribute("aria-invalid", "true"));
    expect(messageOf(date)).toContain("日付が会計期間の外です");
    expect(screen.getByRole("link", { name: "会計期間を作成する" })).toHaveAttribute(
      "href",
      "/e/e1/periods",
    );

    const account2 = screen.getByLabelText("2行目の勘定科目");
    expect(account2).toHaveAttribute("aria-invalid", "true");
    expect(messageOf(account2)).toBe("勘定科目「売上高」は使用停止です");
    const partner1 = screen.getByLabelText("1行目の取引先");
    expect(partner1).toHaveAttribute("aria-invalid", "true");
    expect(messageOf(partner1)).toBe("取引先が見つかりません");
    expect(screen.getByLabelText("1行目の勘定科目")).not.toHaveAttribute("aria-invalid");
  });

  it("行に結び付かないエラー（締め済み・入力の形式）はフォームの上部に表示する", async () => {
    let reply = apiError(
      409,
      "PERIOD_CLOSED",
      "2026年度は締め済みです。訂正は訂正仕訳で行ってください",
      {
        fiscalYear: 2026,
        suggest: "correcting_entry",
      },
    );
    mockJournalApi(() => reply);
    const u = user();
    await renderNewJournal();
    await screen.findByLabelText("1行目の勘定科目");
    await fillLine(u, 1, { account: "売掛金", amount: "1000" });
    await fillLine(u, 2, { account: "売上高", amount: "1000" });
    await u.click(screen.getByRole("button", { name: "登録" }));

    const date = screen.getByLabelText("日付");
    await waitFor(() => expect(messageOf(date)).toContain("2026年度は締め済みです"));
    expect(screen.queryByRole("link", { name: "会計期間を作成する" })).not.toBeInTheDocument();

    reply = apiError(400, "VALIDATION", "入力が正しくありません", {
      issues: [{ path: ["lines", "1", "amount"], message: "金額が大きすぎます" }],
    });
    await u.click(screen.getByRole("button", { name: "登録" }));
    const amount2 = screen.getByLabelText("2行目の金額");
    await waitFor(() => expect(messageOf(amount2)).toBe("金額が大きすぎます"));
    expect(messageOf(date)).toBe("");
  });
});

describe("訂正仕訳の起票（US3, FR-019a）", () => {
  const original = savedJournal(
    {
      date: "2025-12-20",
      lines: [
        { side: "debit", accountId: receivable.id, amount: 495_000 },
        { side: "credit", accountId: sales.id, amount: 495_000 },
      ],
    },
    1,
  );

  it("correctsJournalId の検索パラメータで開くと、訂正元を示し、訂正元を付けて登録する", async () => {
    let body: unknown;
    mockJournalApi(
      (call) => {
        body = call.body;
        return ok(
          {
            journal: {
              ...savedJournal(call.body as JournalBody, 2),
              correctsJournalId: original.id,
            },
            warnings: [],
          },
          201,
        );
      },
      {
        [`GET ${ENTITY}/journals/${original.id}`]: () =>
          ok({ journal: original, correctsJournal: null, correctingJournals: [] }),
      },
    );
    const u = user();
    renderRoute(Route, {
      path: "/e/$entityId/journals/new",
      url: `/e/e1/journals/new?correctsJournalId=${original.id}`,
    });

    expect(await screen.findByRole("heading", { name: "訂正仕訳の入力" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "No.1（2025-12-20）" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${original.id}`,
    );
    await fillLine(u, 1, { account: "売掛金", amount: "5000" });
    await fillLine(u, 2, { account: "売上高", amount: "5000" });
    await u.click(screen.getByRole("button", { name: "登録" }));

    await waitFor(() => expect(body).toMatchObject({ correctsJournalId: original.id }));
    expect(await screen.findByText("仕訳 No.2 を登録しました。")).toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const draftFixture = (): JournalDraft => ({
  mode: "detailed",
  date: "2026-09-15",
  memo: "保存した下書き",
  partnerId: null,
  tagIds: [],
  lines: [
    {
      side: "debit",
      accountId: receivable.id,
      subAccountId: subA.id,
      amount: 1200,
      taxCategory: "OUT_OF_SCOPE",
      partnerId: partnerA.id,
      tagIds: [uuid(8001)],
      description: "借方の説明",
    },
    {
      side: "credit",
      accountId: sales.id,
      subAccountId: null,
      amount: null,
      taxCategory: "SALES_8R",
      partnerId: partnerB.id,
      tagIds: [uuid(8002)],
      description: "貸方の説明",
    },
  ],
});
const renderQuick = (search = "") =>
  renderRoute(Route, { path: "/e/$entityId/journals/new", url: `/e/e1/journals/new${search}` });

describe("下書き・複製・履歴（011/T016）", () => {
  it("読込と続行の選択前は空の下書きを書かず、詳細行の情報を復元し変更後1秒で保存する", async () => {
    const read = deferred<ReturnType<typeof ok>>();
    const draft = draftFixture();
    const calls = mockJournalApi(undefined, {
      [`GET ${ENTITY}/journal-draft`]: () => read.promise,
      [`PUT ${ENTITY}/journal-draft`]: () => ok({ updatedAt: "now" }),
    });
    const u = user();
    renderQuick();
    await advance(DRAFT_SAVE_MS);
    expect(screen.queryByRole("form", { name: "仕訳" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    read.resolve(ok({ draft, updatedAt: "before" }));
    await u.click(await screen.findByRole("button", { name: "続ける" }));
    expect(screen.getByLabelText("1行目の摘要")).toHaveValue("借方の説明");
    expect(screen.getByLabelText("2行目の取引先")).toHaveValue(partnerB.id);
    expect(screen.getByLabelText("2行目の税区分")).toHaveValue("SALES_8R");
    expect(screen.getByLabelText("1行目の税区分")).toHaveValue("OUT_OF_SCOPE");
    expect(screen.getByRole("button", { name: "かんたん入力" })).toBeDisabled();
    await u.type(screen.getByLabelText("1行目の摘要"), "追記");
    await advance(DRAFT_SAVE_MS);
    const put = calls.find((call) => call.method === "PUT" && call.path.endsWith("/journal-draft"));
    expect(put?.body).toMatchObject({
      mode: "detailed",
      memo: draft.memo,
      lines: [
        { subAccountId: subA.id, description: "借方の説明追記", tagIds: [uuid(8001)] },
        { amount: null, description: "貸方の説明", tagIds: [uuid(8002)], partnerId: partnerB.id },
      ],
    });
  });

  it("下書き保存の失敗を表示し、最新の入力を再試行できる", async () => {
    let attempt = 0;
    const calls = mockJournalApi(undefined, {
      [`GET ${ENTITY}/journal-draft`]: () => ok({ draft: null, updatedAt: null }),
      [`PUT ${ENTITY}/journal-draft`]: () =>
        ++attempt === 1 ? ok(undefined, 500) : ok({ updatedAt: "now" }),
    });
    const u = user();
    renderQuick();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "未完成の仕訳");
    await advance(DRAFT_SAVE_MS);
    expect(await screen.findByRole("alert")).toHaveTextContent("サーバーでエラー");
    await u.click(screen.getByRole("button", { name: "下書き保存を再試行" }));
    await waitFor(() => expect(attempt).toBe(2));
    expect(calls.filter((call) => call.method === "PUT").at(-1)?.body).toMatchObject({
      mode: "quick",
      memo: "未完成の仕訳",
    });
  });

  it("進行中のPUTを待ってから登録後DELETEし、削除失敗でも登録成功を保ち削除だけ再試行する", async () => {
    const write = deferred<ReturnType<typeof ok>>();
    let deletes = 0;
    const calls = mockJournalApi(
      (call) => ok({ journal: savedJournal(call.body as JournalBody), warnings: [] }, 201),
      {
        [`GET ${ENTITY}/journal-draft`]: () => ok({ draft: null, updatedAt: null }),
        [`PUT ${ENTITY}/journal-draft`]: () => write.promise,
        [`DELETE ${ENTITY}/journal-draft`]: () =>
          ++deletes === 1 ? ok(undefined, 500) : ok(undefined, 204),
      },
    );
    const u = user();
    renderQuick();
    await u.type(await screen.findByRole("combobox", { name: "借方科目" }), "6010{Enter}");
    await u.keyboard("1020{Enter}1100");
    await u.type(screen.getByLabelText("摘要", { exact: true }), "登録する入力");
    await advance(DRAFT_SAVE_MS);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    await u.click(screen.getByRole("button", { name: "登録" }));
    expect(await screen.findByText("仕訳 No.1 を登録しました。")).toBeInTheDocument();
    expect(deletes).toBe(0);
    write.resolve(ok({ updatedAt: "now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("サーバーでエラー");
    await u.click(screen.getByRole("button", { name: "下書き削除を再試行" }));
    await waitFor(() => expect(deletes).toBe(2));
    await advance(DRAFT_SAVE_MS);
    expect(
      calls.filter((call) => call.method === "POST" && call.path.endsWith("/journals")),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("捨てる操作はDELETE完了後に空フォームを出し、初期値で保存し直さない", async () => {
    const calls = mockJournalApi(undefined, {
      [`GET ${ENTITY}/journal-draft`]: () => ok({ draft: draftFixture(), updatedAt: "before" }),
      [`DELETE ${ENTITY}/journal-draft`]: () => ok(undefined, 204),
    });
    const u = user();
    renderQuick();
    await u.click(await screen.findByRole("button", { name: "捨てる" }));
    expect(await screen.findByLabelText("摘要", { exact: true })).toHaveValue("");
    await advance(DRAFT_SAVE_MS);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("画面を開き直して捨てた場合も、前の画面の進行中PUTの後にDELETEする", async () => {
    const writing = deferred<ReturnType<typeof ok>>();
    let deletes = 0;
    mockJournalApi(undefined, {
      [`GET ${ENTITY}/journal-draft`]: () => ok({ draft: draftFixture(), updatedAt: "before" }),
      [`PUT ${ENTITY}/journal-draft`]: () => writing.promise,
      [`DELETE ${ENTITY}/journal-draft`]: () => {
        deletes += 1;
        return ok(undefined, 204);
      },
    });
    const u = user();
    const first = renderQuick();
    await u.click(await screen.findByRole("button", { name: "続ける" }));
    await u.type(screen.getByLabelText("1行目の摘要"), "進行中");
    await advance(DRAFT_SAVE_MS);
    first.unmount();
    renderQuick();
    await u.click(await screen.findByRole("button", { name: "捨てる" }));
    expect(deletes).toBe(0);
    writing.resolve(ok({ updatedAt: "now" }));
    await waitFor(() => expect(deletes).toBe(1));
    expect(await screen.findByLabelText("摘要", { exact: true })).toHaveValue("");
  });

  it("複製と既存下書きの競合を選ばせ、複製の全項目を今日の日付で保持する", async () => {
    const original = savedJournal({
      date: "2025-12-20",
      memo: "複製元",
      lines: [
        {
          side: "debit",
          accountId: receivable.id,
          amount: 1200,
          subAccountId: subA.id,
          description: "行の説明",
          taxCategory: "OUT_OF_SCOPE",
          partnerId: partnerA.id,
          tagIds: [uuid(8001)],
        },
        {
          side: "credit",
          accountId: sales.id,
          amount: 1200,
          taxCategory: "SALES_8R",
          partnerId: partnerB.id,
          tagIds: [uuid(8002)],
        },
      ],
    });
    const calls = mockJournalApi(undefined, {
      [`GET ${ENTITY}/journal-draft`]: () => ok({ draft: draftFixture(), updatedAt: "before" }),
      [`GET ${ENTITY}/journals/${original.id}`]: () =>
        ok({ journal: original, correctsJournal: null, correctingJournals: [] }),
      [`DELETE ${ENTITY}/journal-draft`]: () => ok(undefined, 204),
    });
    const u = user();
    renderQuick(`?from=${original.id}`);
    expect(await screen.findByText(/保存済みの下書き/)).toBeInTheDocument();
    expect(calls.filter((call) => ["PUT", "DELETE"].includes(call.method))).toHaveLength(0);
    await u.click(screen.getByRole("button", { name: "複製を使う" }));
    expect(await screen.findByLabelText("日付")).toHaveValue("2026-10-31");
    expect(screen.getByLabelText("メモ")).toHaveValue("複製元");
    expect(screen.getByLabelText("1行目の摘要")).toHaveValue("行の説明");
    expect(screen.getByLabelText("2行目の取引先")).toHaveValue(partnerB.id);
    expect(screen.getByLabelText("2行目の税区分")).toHaveValue("SALES_8R");
  });

  it("履歴は300ms待ち、古い応答を表示せず、左右の値だけを反映し停止中の候補は使わせない", async () => {
    const old = deferred<ReturnType<typeof ok>>();
    const suggestion: JournalSuggestion = {
      debitAccountId: supplies.id,
      creditAccountId: bank.id,
      debitTaxCategory: "PURCHASE_8R",
      creditTaxCategory: "OUT_OF_SCOPE",
      debitPartnerId: partnerA.id,
      creditPartnerId: partnerB.id,
      sourceJournalId: uuid(9001),
      date: "2026-09-01",
    };
    const calls = mockJournalApi(undefined, {
      [`GET ${ENTITY}/journal-draft`]: () => ok({ draft: null, updatedAt: null }),
      [`GET ${ENTITY}/journals/suggestions`]: (call) =>
        call.query.memo === "古い摘要"
          ? old.promise
          : ok({
              suggestions: [
                suggestion,
                { ...suggestion, sourceJournalId: uuid(9002), debitAccountId: stopped.id },
              ],
            }),
    });
    const u = user();
    renderQuick();
    const memo = await screen.findByLabelText("摘要", { exact: true });
    await u.type(memo, "古い摘要");
    expect(calls.some((call) => call.path.endsWith("/suggestions"))).toBe(false);
    await advance(SUGGEST_DEBOUNCE_MS);
    await u.clear(memo);
    await u.type(memo, "新しい摘要");
    await u.type(screen.getByLabelText("金額", { exact: true }), "2200");
    await advance(SUGGEST_DEBOUNCE_MS);
    expect(await screen.findByRole("button", { name: "候補2を入れる" })).toBeDisabled();
    old.resolve(
      ok({
        suggestions: [{ ...suggestion, sourceJournalId: uuid(9003), debitAccountId: sales.id }],
      }),
    );
    await u.click(screen.getByRole("button", { name: "候補1を入れる" }));
    expect(screen.getByRole("combobox", { name: "借方科目" })).toHaveValue("6010 消耗品費");
    expect(screen.getByLabelText("摘要", { exact: true })).toHaveValue("新しい摘要");
    expect(screen.getByLabelText("金額", { exact: true })).toHaveValue("2200");
    await u.click(screen.getByText("任意項目", { exact: true }));
    expect(screen.getByLabelText("借方税区分")).toHaveValue("PURCHASE_8R");
    expect(screen.getByLabelText("貸方税区分")).toHaveValue("OUT_OF_SCOPE");
    expect(screen.getByRole("combobox", { name: "貸方取引先" })).toHaveValue("取引先B");
  });

  it("下書き読込・複製元読込の失敗は明示し、再試行前に入力を保存しない", async () => {
    let reads = 0;
    const calls = mockJournalApi(undefined, {
      [`GET ${ENTITY}/journal-draft`]: () =>
        ++reads === 1 ? ok(undefined, 500) : ok({ draft: null, updatedAt: null }),
    });
    const u = user();
    renderQuick();
    expect(await screen.findByRole("alert")).toHaveTextContent("サーバーでエラー");
    expect(screen.queryByRole("form", { name: "仕訳" })).not.toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "下書き読込を再試行" }));
    expect(await screen.findByLabelText("摘要", { exact: true })).toHaveValue("");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("履歴検索は最後に変更した側の取引先1件で行い、同日の候補順を応答どおり表示する", async () => {
    const base: JournalSuggestion = {
      debitAccountId: supplies.id,
      creditAccountId: bank.id,
      debitTaxCategory: "PURCHASE_10",
      creditTaxCategory: "OUT_OF_SCOPE",
      debitPartnerId: null,
      creditPartnerId: null,
      sourceJournalId: uuid(9001),
      date: "2026-09-01",
    };
    const calls = mockJournalApi(undefined, {
      [`GET ${ENTITY}/journals/suggestions`]: (call) =>
        ok({
          suggestions:
            call.query.partnerId === partnerB.id
              ? [
                  { ...base, debitAccountId: sales.id, sourceJournalId: uuid(9010) },
                  { ...base, sourceJournalId: uuid(9009) },
                ]
              : [{ ...base }],
        }),
    });
    const u = user();
    renderQuick();
    await screen.findByLabelText("摘要", { exact: true });
    await u.click(screen.getByText("任意項目", { exact: true }));
    await u.type(screen.getByRole("combobox", { name: "借方取引先" }), "取引先A{Enter}");
    await advance(SUGGEST_DEBOUNCE_MS);
    expect(calls.filter((call) => call.path.endsWith("/suggestions")).at(-1)?.query.partnerId).toBe(
      partnerA.id,
    );
    await u.type(screen.getByRole("combobox", { name: "貸方取引先" }), "取引先B{Enter}");
    await advance(SUGGEST_DEBOUNCE_MS);
    expect(
      (await screen.findByRole("button", { name: "候補1を入れる" })).parentElement,
    ).toHaveTextContent("売上高 ／ 普通預金");
    expect(screen.getByRole("button", { name: "候補2を入れる" }).parentElement).toHaveTextContent(
      "消耗品費 ／ 普通預金",
    );
    expect(screen.queryByRole("button", { name: "候補3を入れる" })).not.toBeInTheDocument();
    expect(calls.filter((call) => call.path.endsWith("/suggestions")).at(-1)?.query.partnerId).toBe(
      partnerB.id,
    );
    await u.clear(screen.getByRole("combobox", { name: "借方取引先" }));
    await u.type(screen.getByRole("combobox", { name: "借方取引先" }), "取引先A{Enter}");
    await advance(SUGGEST_DEBOUNCE_MS);
    expect(
      (await screen.findByRole("button", { name: "候補1を入れる" })).parentElement,
    ).toHaveTextContent("消耗品費 ／ 普通預金");
    expect(screen.queryByRole("button", { name: "候補2を入れる" })).not.toBeInTheDocument();
  });

  it.each([2, 3])(
    "複製の%d行を今日の日付で開き、情報を表せる2行だけ簡易入力にする",
    async (count) => {
      const original = savedJournal({
        date: "2025-12-20",
        memo: "コピーの摘要",
        lines: [
          { side: "debit", accountId: supplies.id, amount: count === 2 ? 1200 : 600 },
          { side: "credit", accountId: bank.id, amount: 1200 },
          ...(count === 3 ? [{ side: "debit", accountId: supplies.id, amount: 600 }] : []),
        ],
      });
      mockJournalApi(undefined, {
        [`GET ${ENTITY}/journals/${original.id}`]: () =>
          ok({ journal: original, correctsJournal: null, correctingJournals: [] }),
      });
      renderQuick(`?from=${original.id}`);
      expect(await screen.findByLabelText("日付")).toHaveValue("2026-10-31");
      if (count === 2) {
        expect(screen.getByLabelText("摘要", { exact: true })).toHaveValue("コピーの摘要");
        expect(screen.getByLabelText("金額", { exact: true })).toHaveValue("1200");
      } else {
        expect(screen.getByLabelText("メモ")).toHaveValue("コピーの摘要");
        expect(screen.getByLabelText("3行目の金額")).toHaveValue("600");
      }
    },
  );

  it("複製元の取得失敗で空フォームを出さず、再取得後に複製できる", async () => {
    const original = savedJournal({
      date: "2025-12-20",
      memo: "再取得した複製",
      lines: [
        { side: "debit", accountId: supplies.id, amount: 1200 },
        { side: "credit", accountId: bank.id, amount: 1200 },
      ],
    });
    let failed = true;
    const calls = mockJournalApi(undefined, {
      [`GET ${ENTITY}/journals/${original.id}`]: () =>
        failed
          ? apiError(404, "JOURNAL_NOT_FOUND", "仕訳が見つかりません")
          : ok({ journal: original, correctsJournal: null, correctingJournals: [] }),
    });
    const u = user();
    renderQuick(`?from=${original.id}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("仕訳が見つかりません");
    expect(screen.queryByRole("form", { name: "仕訳" })).not.toBeInTheDocument();
    expect(calls.some((call) => ["PUT", "DELETE"].includes(call.method))).toBe(false);
    failed = false;
    await u.click(screen.getByRole("button", { name: "複製元を再読込" }));
    expect(await screen.findByLabelText("摘要", { exact: true })).toHaveValue("再取得した複製");
  });
});

describe("かんたん入力のレビューの指摘（011）", () => {
  const suggestion: JournalSuggestion = {
    debitAccountId: supplies.id,
    creditAccountId: bank.id,
    debitTaxCategory: "PURCHASE_10",
    creditTaxCategory: "OUT_OF_SCOPE",
    debitPartnerId: null,
    creditPartnerId: null,
    sourceJournalId: uuid(9001),
    date: "2026-09-01",
  };
  const posts = (calls: ApiCall[]) =>
    calls.filter((call) => call.method === "POST" && call.path === `${ENTITY}/journals`);
  const create = (suggestions: JournalSuggestion[]) => {
    const calls = mockJournalApi(
      (call) => ok({ journal: savedJournal(call.body as JournalBody), warnings: [] }, 201),
      { [`GET ${ENTITY}/journals/suggestions`]: () => ok({ suggestions }) },
    );
    return calls;
  };
  /** 日付・借方・貸方・金額を Enter で進め、摘要に焦点がある状態にする */
  async function fillUntilMemo(u: ReturnType<typeof user>) {
    renderQuick();
    await screen.findByLabelText("日付");
    await u.keyboard("{Enter}");
    await u.keyboard("6010{Enter}");
    await u.keyboard("1020{Enter}");
    await u.keyboard("1100{Enter}");
    expect(screen.getByLabelText("摘要", { exact: true })).toHaveFocus();
  }

  it("摘要でEnterを押したとき履歴の候補が出ていれば、登録せず候補の先頭のボタンへ焦点を移す", async () => {
    const calls = create([suggestion]);
    const u = user();
    await fillUntilMemo(u);
    await u.keyboard("文房具");
    await advance(SUGGEST_DEBOUNCE_MS);
    const first = await screen.findByRole("button", { name: "候補1を入れる" });
    await u.keyboard("{Enter}");
    expect(first).toHaveFocus();
    await advance(100);
    expect(posts(calls)).toHaveLength(0);
    // 候補を使わず、既存の登録のボタンから登録できる
    await u.click(screen.getByRole("button", { name: "登録" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
  });

  it("候補の読み込み・入力待ちの間にEnterを押しても登録せず、候補が出たら焦点を移す", async () => {
    const calls = create([suggestion]);
    const u = user();
    await fillUntilMemo(u);
    await u.keyboard("文房具{Enter}");
    expect(posts(calls)).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "候補1を入れる" })).toHaveFocus(),
    );
    expect(posts(calls)).toHaveLength(0);
  });

  it("候補が0件と分かっていれば、摘要のEnterで今までどおり登録する", async () => {
    const calls = create([]);
    const u = user();
    await fillUntilMemo(u);
    await u.keyboard("文房具");
    await advance(SUGGEST_DEBOUNCE_MS);
    await u.keyboard("{Enter}");
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
  });

  it("摘要が空ならEnterで登録する", async () => {
    const calls = create([suggestion]);
    const u = user();
    await fillUntilMemo(u);
    await u.keyboard("{Enter}");
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
  });

  it("画面を離れたとき、デバウンス待ちの下書きの最後の入力をその場で1回保存する", async () => {
    const calls = mockJournalApi(undefined, {
      [`PUT ${ENTITY}/journal-draft`]: () => ok({ updatedAt: "now" }),
    });
    const u = user();
    const { unmount } = renderQuick();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "未完成の摘要");
    const puts = () => calls.filter((call) => call.method === "PUT");
    expect(puts()).toHaveLength(0);
    unmount();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toMatchObject({ memo: "未完成の摘要" });
    await advance(DRAFT_SAVE_MS);
    expect(puts()).toHaveLength(1);
  });

  it("下書きの保存を済ませた後に離れても、重ねて保存しない", async () => {
    const calls = mockJournalApi(undefined, {
      [`PUT ${ENTITY}/journal-draft`]: () => ok({ updatedAt: "now" }),
    });
    const u = user();
    const { unmount } = renderQuick();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "保存済み");
    await advance(DRAFT_SAVE_MS);
    unmount();
    await advance(100);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });
});
