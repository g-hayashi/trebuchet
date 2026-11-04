import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route } from "@/routes/e/$entityId/invoices/index";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 011 US5（T026）: 請求の画面の入口（流れ・取引先の登録と編集・一覧の入金・既定の表示）

const BASE = "/api/entities/e1";
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const DEPOSIT_KEY = "trebuchet.depositAccount.e1";

const PARTNER_A = {
  id: P1,
  name: "株式会社A",
  honorific: "御中",
  memo: "月末締め",
  isActive: true,
};
const PARTNER_B = { id: P2, name: "B 商事", honorific: null, memo: null, isActive: true };

const HOURLY = {
  partnerId: P1,
  billingType: "hourly",
  unitPrice: 10_000,
  monthlyAmount: null,
  dueMonthsAfter: 1,
  dueDay: 31,
  defaultItemName: "システム開発",
  billingName: null,
  updatedAt: "2026-10-24T09:00:00.000Z",
  partnerName: "株式会社A",
  honorific: "御中",
  partnerActive: true,
};

const summary = (over: Record<string, unknown>) => ({
  id: "inv1",
  invoiceNo: "2026-0001",
  partnerId: P1,
  recipientName: "株式会社A",
  targetMonth: "2026-10",
  issueDate: "2026-11-05",
  dueDate: "2026-11-30",
  total: 405_000,
  paid: 0,
  remaining: 405_000,
  status: "unpaid",
  overdue: false,
  ...over,
});
const INVOICES = [
  summary({}),
  summary({
    id: "inv2",
    invoiceNo: "2026-0002",
    partnerId: P2,
    recipientName: "B 商事",
    total: 100_000,
    paid: 100_000,
    remaining: 0,
    status: "paid",
  }),
  summary({ id: "inv3", invoiceNo: "2026-0003", status: "voided", remaining: 0 }),
];

const account = (n: number, name: string, over: Partial<Account> = {}): Account => ({
  id: `acc${n}`,
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
const ACCOUNTS = [account(1020, "普通預金"), account(1010, "現金")];

type Routes = Parameters<typeof mockApi>[0];

function setup({
  terms = [HOURLY],
  invoices = INVOICES,
  url = "/e/e1/invoices",
  extra = {},
}: {
  terms?: unknown[];
  invoices?: unknown[];
  url?: string;
  extra?: Routes;
} = {}) {
  const calls = mockApi({
    [`GET ${BASE}/partners`]: () => ok({ partners: [PARTNER_A, PARTNER_B] }),
    [`GET ${BASE}/billing-terms`]: () => ok({ terms }),
    [`GET ${BASE}/invoices`]: () => ok({ invoices, outstandingByPartner: [] }),
    [`GET ${BASE}/accounts`]: () => ok({ accounts: ACCOUNTS }),
    ...extra,
  });
  const view = renderRoute(Route, { path: "/e/$entityId/invoices/", url });
  return { calls, ...view };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("請求の流れと入口（FR-031・032）", () => {
  it("工数 → 請求書を作る → 入金 の流れを示し、未回収があるときは入金が今の段階", async () => {
    setup();
    const steps = await screen.findByRole("list", { name: "請求の流れ" });
    const items = within(steps).getAllByRole("listitem");
    expect(items.map((li) => li.textContent?.replace(/^[①②③]\s*/, ""))).toEqual([
      "工数",
      "請求書を作る",
      "入金",
    ]);
    await waitFor(() => expect(items[2]).toHaveAttribute("aria-current", "step"));
  });

  it("請求の条件がまだない間は、工数が今の段階", async () => {
    setup({ terms: [], invoices: [] });
    const steps = await screen.findByRole("list", { name: "請求の流れ" });
    const items = within(steps).getAllByRole("listitem");
    await waitFor(() => expect(items[0]).toHaveAttribute("aria-current", "step"));
  });

  it("工数・請求書・請求の設定・取引先への入口を 1 か所に置く", async () => {
    setup();
    await screen.findByRole("table", { name: "請求書の一覧" });
    expect(screen.getByRole("link", { name: "工数の入力" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/work-hours"),
    );
    expect(screen.getByRole("link", { name: "請求書を作る" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoices/new"),
    );
    expect(screen.getByRole("link", { name: "請求の設定" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoice-settings"),
    );
    const partners = screen.getByRole("table", { name: "取引先の一覧" });
    expect(within(partners).getByText("株式会社A")).toBeInTheDocument();
    expect(within(partners).getByText(/時間単価 10,000 円/)).toBeInTheDocument();
    expect(within(partners).getByText("未設定")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取引先を登録" })).toBeInTheDocument();
  });
});

describe("一覧の既定の表示（FR-035）", () => {
  it("既定は未入金・期限切れ（一部入金を含む）。入金済み・取消済みは出さない", async () => {
    const { calls } = setup();
    const table = await screen.findByRole("table", { name: "請求書の一覧" });
    expect(within(table).getByRole("row", { name: /2026-0001/ })).toBeInTheDocument();
    expect(within(table).queryByRole("row", { name: /2026-0002/ })).not.toBeInTheDocument();
    expect(within(table).queryByRole("row", { name: /2026-0003/ })).not.toBeInTheDocument();
    expect(calls.find((c) => c.path === `${BASE}/invoices`)?.query).toEqual({});
  });

  it("状態を「すべて」にすると入金済み・取消済みも出す（status はサーバーへ送らない）", async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "請求書の一覧" });
    await user.selectOptions(screen.getByLabelText("状態"), "all");
    const table = await screen.findByRole("row", { name: /2026-0002/ });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /2026-0003/ })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === `${BASE}/invoices`).every((c) => !c.query.status)).toBe(
      true,
    );
  });
});

describe("一覧の行からの入金（FR-035）", () => {
  const PAYMENT_RESULT = {
    payment: { id: "pay1" },
    invoice: { id: "inv1", remaining: 0 },
    journal: { id: "jp1" },
  };

  async function openPayment(user: ReturnType<typeof userEvent.setup>) {
    const table = await screen.findByRole("table", { name: "請求書の一覧" });
    const row = within(table).getByRole("row", { name: /2026-0001/ });
    await user.click(within(row).getByRole("button", { name: "入金（2026-0001）" }));
    return screen.findByRole("dialog");
  }

  it("入金済み・取消済みの行には入金の操作を出さない", async () => {
    setup({ url: "/e/e1/invoices?status=all" });
    await screen.findByRole("row", { name: /2026-0002/ });
    expect(
      within(screen.getByRole("row", { name: /2026-0002/ })).queryByRole("button", {
        name: /^入金/,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("row", { name: /2026-0003/ })).queryByRole("button", {
        name: /^入金/,
      }),
    ).not.toBeInTheDocument();
  });

  it("前回使った入金先を既定にし、消し込んだら閉じて、入金先を覚える", async () => {
    localStorage.setItem(DEPOSIT_KEY, "acc1010");
    const user = userEvent.setup();
    const { calls } = setup({
      extra: {
        [`POST ${BASE}/invoices/inv1/payments`]: () => ok(PAYMENT_RESULT, 201),
      },
    });
    const dialog = await openPayment(user);
    const form = within(dialog).getByRole("form", { name: "入金の消し込み" });
    await waitFor(() => expect(within(form).getByLabelText("入金先の科目")).toHaveValue("acc1010"));
    fireEvent.change(within(form).getByLabelText("入金日"), { target: { value: "2026-11-10" } });
    await user.selectOptions(within(form).getByLabelText("入金先の科目"), "acc1020");
    await user.click(within(form).getByRole("button", { name: "消し込む" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      receivedOn: "2026-11-10",
      amount: 405_000,
      depositAccountId: "acc1020",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(localStorage.getItem(DEPOSIT_KEY)).toBe("acc1020");
  });

  it("覚えた入金先が使えない科目（使用停止・存在しない）なら、既定にしない", async () => {
    localStorage.setItem(DEPOSIT_KEY, "acc9999");
    const user = userEvent.setup();
    setup();
    const dialog = await openPayment(user);
    const form = within(dialog).getByRole("form", { name: "入金の消し込み" });
    await within(form).findByRole("option", { name: "普通預金" });
    expect(within(form).getByLabelText("入金先の科目")).toHaveValue("");
  });
});

describe("取引先の登録と編集（FR-034）", () => {
  const openRegister = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: "取引先を登録" }));
    const dialog = await screen.findByRole("dialog");
    return within(dialog).getByRole("form", { name: "取引先を登録" });
  };

  it("名前と敬称だけなら、請求の条件なし（null）で POST /partners/profile する", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      extra: {
        [`POST ${BASE}/partners/profile`]: () =>
          ok(
            {
              partner: { id: "p3", name: "C 工業", honorific: "様", memo: null, isActive: true },
              billingTerms: null,
            },
            201,
          ),
      },
    });
    const form = await openRegister(user);
    expect(within(form).queryByLabelText("既定の品名")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("名称"), "C 工業");
    await user.selectOptions(within(form).getByLabelText("敬称"), "様");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`${BASE}/partners/profile`);
    expect(post?.body).toEqual({
      partner: { name: "C 工業", honorific: "様", memo: "", isActive: true },
      billingTerms: null,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("請求の条件を設定すると、名前・敬称・条件を 1 回の POST で送り、取引先・条件・工数を読み直す", async () => {
    const user = userEvent.setup();
    const { calls, queryClient } = setup({
      extra: {
        [`POST ${BASE}/partners/profile`]: () =>
          ok(
            {
              partner: { id: "p3", name: "C 工業", honorific: null, memo: null, isActive: true },
              billingTerms: { ...HOURLY, partnerId: "p3", unitPrice: 8000 },
            },
            201,
          ),
      },
    });
    await screen.findByRole("table", { name: "取引先の一覧" });
    queryClient.setQueryData(["entities", "e1", "work-hours", "2026-10"], []);
    const form = await openRegister(user);
    await user.type(within(form).getByLabelText("名称"), "C 工業");
    await user.click(within(form).getByLabelText("請求の条件を設定する"));
    await user.type(within(form).getByLabelText("時間単価（円）"), "8000");
    await user.type(within(form).getByLabelText("既定の品名"), "保守");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      partner: { name: "C 工業", honorific: null },
      billingTerms: {
        billingType: "hourly",
        unitPrice: 8000,
        defaultItemName: "保守",
        dueMonthsAfter: 1,
        dueDay: 31,
      },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // 請求の条件のある取引先が工数の対象になる（工数の問い合わせを無効にして読み直させる）
    expect(
      queryClient.getQueryState(["entities", "e1", "work-hours", "2026-10"])?.isInvalidated,
    ).toBe(true);
    expect(calls.filter((c) => c.method === "GET" && c.path === `${BASE}/partners`).length).toBe(2);
    expect(
      calls.filter((c) => c.method === "GET" && c.path === `${BASE}/billing-terms`).length,
    ).toBe(2);
  });

  it("条件を設定するのに金額・品名が空なら、送らずに欄ごとに知らせる", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const form = await openRegister(user);
    await user.type(within(form).getByLabelText("名称"), "C 工業");
    await user.click(within(form).getByLabelText("請求の条件を設定する"));
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(
      await within(form).findByText("単価は 1 円以上の整数で入力してください"),
    ).toBeInTheDocument();
    expect(within(form).getByText("既定の品名を入力してください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("名前が空なら送らずに知らせる", async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const form = await openRegister(user);
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("名称を入力してください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("編集は今の値を入れて開き、PUT /partners/:id/profile で保存する。使用停止も 1 つの欄で変えられる", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      extra: {
        [`PUT ${BASE}/partners/${P1}/profile`]: () =>
          ok({
            partner: { ...PARTNER_A, name: "株式会社A 改", isActive: false },
            billingTerms: HOURLY,
          }),
      },
    });
    const table = await screen.findByRole("table", { name: "取引先の一覧" });
    await user.click(within(table).getByRole("button", { name: "取引先の編集（株式会社A）" }));
    const dialog = await screen.findByRole("dialog");
    const form = within(dialog).getByRole("form", { name: "取引先の編集（株式会社A）" });
    expect(within(form).getByLabelText("名称")).toHaveValue("株式会社A");
    expect(within(form).getByLabelText("敬称")).toHaveValue("御中");
    expect(within(form).getByLabelText("メモ")).toHaveValue("月末締め");
    expect(within(form).getByLabelText("請求の条件を設定する")).toBeChecked();
    expect(within(form).getByLabelText("時間単価（円）")).toHaveValue("10000");

    await user.type(within(form).getByLabelText("名称"), " 改");
    await user.click(within(form).getByLabelText("使用停止にする"));
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({
      partner: { name: "株式会社A 改", honorific: "御中", memo: "月末締め", isActive: false },
      billingTerms: { billingType: "hourly", unitPrice: 10_000, defaultItemName: "システム開発" },
    });
  });

  it("条件の設定を外して保存すると、billingTerms は null で送る", async () => {
    const user = userEvent.setup();
    const { calls } = setup({
      extra: {
        [`PUT ${BASE}/partners/${P1}/profile`]: () =>
          ok({ partner: PARTNER_A, billingTerms: null }),
      },
    });
    const table = await screen.findByRole("table", { name: "取引先の一覧" });
    await user.click(within(table).getByRole("button", { name: "取引先の編集（株式会社A）" }));
    const form = within(await screen.findByRole("dialog")).getByRole("form", {
      name: "取引先の編集（株式会社A）",
    });
    await user.click(within(form).getByLabelText("請求の条件を設定する"));
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { billingTerms: unknown } | undefined)?.billingTerms).toBe(null);
  });
});
