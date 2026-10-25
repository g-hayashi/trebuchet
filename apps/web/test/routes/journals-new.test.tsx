import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route } from "@/routes/e/$entityId/journals/new";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
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
    [`GET ${ENTITY}/partners`]: () => ok({ partners: [partnerA] }),
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

function renderNewJournal() {
  return renderRoute(Route, { path: "/e/$entityId/journals/new", url: "/e/e1/journals/new" });
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

const user = () => userEvent.setup();

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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-31T10:00:00+09:00"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("仕訳の入力画面（US2）", () => {
  it("借方・貸方の2行と今日の日付で始まり、行を追加・削除できる", async () => {
    mockJournalApi();
    const u = user();
    renderNewJournal();

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
    renderNewJournal();
    const save = await screen.findByRole("button", { name: "登録する" });
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
    renderNewJournal();
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
    renderNewJournal();
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
    const { queryClient } = renderNewJournal();
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
    await u.click(screen.getByRole("button", { name: "登録する" }));

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
    expect(screen.getByLabelText("1行目の金額")).toHaveValue("");
    expect(screen.getByLabelText("メモ")).toHaveValue("");
    expect(screen.getByLabelText("日付")).toHaveValue("2026-10-31");
  });

  it("US2-2: 借方2行・貸方1行の複合仕訳を登録できる", async () => {
    let posted: JournalBody | undefined;
    mockJournalApi((call) => {
      posted = call.body as JournalBody;
      return ok({ journal: savedJournal(posted, 7), warnings: [] }, 201);
    });
    const u = user();
    renderNewJournal();
    await screen.findByLabelText("1行目の勘定科目");

    await fillLine(u, 1, { account: "普通預金", amount: "487037" });
    await u.click(screen.getByRole("button", { name: "行を追加" }));
    await fillLine(u, 2, { side: "借方", account: "事業主貸", amount: "7963" });
    await fillLine(u, 3, { side: "貸方", account: "売掛金", amount: "495000" });
    await u.click(screen.getByRole("button", { name: "登録する" }));

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
    renderNewJournal();
    await screen.findByLabelText("1行目の勘定科目");
    await fillLine(u, 1, { account: "売掛金", amount: "495000" });
    await fillLine(u, 2, { account: "売上高", amount: "495000" });
    await u.click(screen.getByRole("button", { name: "登録する" }));

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
    renderNewJournal();
    await screen.findByLabelText("1行目の勘定科目");
    await u.clear(screen.getByLabelText("日付"));
    await u.type(screen.getByLabelText("日付"), "2027-01-05");
    await fillLine(u, 1, { account: "売掛金", amount: "495000" });
    await fillLine(u, 2, { account: "売上高", amount: "495000" });
    await u.click(screen.getByRole("button", { name: "登録する" }));

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
    renderNewJournal();
    await screen.findByLabelText("1行目の勘定科目");
    await fillLine(u, 1, { account: "売掛金", amount: "1000" });
    await fillLine(u, 2, { account: "売上高", amount: "1000" });
    await u.click(screen.getByRole("button", { name: "登録する" }));

    const date = screen.getByLabelText("日付");
    await waitFor(() => expect(messageOf(date)).toContain("2026年度は締め済みです"));
    expect(screen.queryByRole("link", { name: "会計期間を作成する" })).not.toBeInTheDocument();

    reply = apiError(400, "VALIDATION", "入力が正しくありません", {
      issues: [{ path: ["lines", "1", "amount"], message: "金額が大きすぎます" }],
    });
    await u.click(screen.getByRole("button", { name: "登録する" }));
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
    await u.click(screen.getByRole("button", { name: "登録する" }));

    await waitFor(() => expect(body).toMatchObject({ correctsJournalId: original.id }));
    expect(await screen.findByText("仕訳 No.2 を登録しました。")).toBeInTheDocument();
  });
});
