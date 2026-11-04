import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route as DetailRoute } from "@/routes/e/$entityId/invoices/$invoiceId";
import { Route as ListRoute } from "@/routes/e/$entityId/invoices/index";
import { INVOICE_DETAIL } from "../invoicing-fixtures";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 005 US2: 消し込みの画面（FR-017〜022。H:§4.1・§4.2、§3.5）

const BASE = "/api/entities/e1";
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";

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
const ACCOUNTS = [
  account(1020, "普通預金"),
  account(1100, "売掛金"),
  account(5250, "支払手数料", {
    category: "expense",
    normalSide: "debit",
    reportSection: "PL_EXPENSE",
  }),
];
const SUB_ACCOUNTS = [{ id: "sub1", name: "○○銀行", isActive: true }];

const PAYMENT = {
  id: "pay1",
  receivedOn: "2026-11-10",
  amount: 99_560,
  feeAmount: 440,
  depositAccountId: "acc1020",
  depositSubAccountId: null,
  journalId: "jp1",
  voidedAt: null,
  voidReason: null,
  voidJournalId: null,
};

const REMAINING_DETAIL = {
  ...INVOICE_DETAIL,
  total: 100_000,
  remaining: 100_000,
  items: [{ ...INVOICE_DETAIL.items[0], amount: 100_000 }],
};

const accountRoutes = {
  [`GET ${BASE}/accounts`]: () => ok({ accounts: ACCOUNTS }),
  [`GET ${BASE}/accounts/acc1020/sub-accounts`]: () => ok({ subAccounts: SUB_ACCOUNTS }),
};

function setupDetail(detail: unknown = REMAINING_DETAIL, extra = {}) {
  const calls = mockApi({
    ...accountRoutes,
    [`GET ${BASE}/invoices/inv1`]: () => ok(detail),
    ...extra,
  });
  renderRoute(DetailRoute, {
    path: "/e/$entityId/invoices/$invoiceId",
    url: "/e/e1/invoices/inv1",
  });
  return calls;
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fillPayment = async (
  user: ReturnType<typeof userEvent.setup>,
  { amount, fee = false }: { amount: string; fee?: boolean },
) => {
  const form = await screen.findByRole("form", { name: "入金の消し込み" });
  fireEvent.change(within(form).getByLabelText("入金日"), { target: { value: "2026-11-10" } });
  const amountInput = within(form).getByLabelText("入金額");
  await user.clear(amountInput);
  await user.type(amountInput, amount);
  await user.selectOptions(within(form).getByLabelText("入金先の科目"), "acc1020");
  if (fee) await user.click(within(form).getByLabelText("差額を振込手数料として扱う"));
  return form;
};

describe("消し込みの入力（詳細。FR-017〜019）", () => {
  it("残額を示し、差額を手数料として扱う入力は手数料の額を示して POST する", async () => {
    let paid = false;
    const calls = setupDetail(REMAINING_DETAIL, {
      [`GET ${BASE}/invoices/inv1`]: () =>
        ok(
          paid
            ? {
                ...REMAINING_DETAIL,
                status: "paid",
                paid: 100_000,
                remaining: 0,
                payments: [PAYMENT],
              }
            : REMAINING_DETAIL,
        ),
      [`POST ${BASE}/invoices/inv1/payments`]: () => {
        paid = true;
        return ok({ payment: PAYMENT, invoice: REMAINING_DETAIL, journal: { id: "jp1" } }, 201);
      },
    });
    const user = userEvent.setup();
    const form = await fillPayment(user, { amount: "99560", fee: true });
    expect(within(form).getByText("消し込める残額 100,000 円")).toBeInTheDocument();
    expect(within(form).getByText("振込手数料 440 円")).toBeInTheDocument();

    await within(form).findByRole("option", { name: "○○銀行" });
    await user.selectOptions(within(form).getByLabelText("補助科目"), "sub1");
    await user.click(within(form).getByRole("button", { name: "消し込む" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      receivedOn: "2026-11-10",
      amount: 99_560,
      depositAccountId: "acc1020",
      depositSubAccountId: "sub1",
      treatDifferenceAsFee: true,
    });
    // 消し込みの一覧に出て、入金済みになり、入力の欄は消える
    const table = await screen.findByRole("table", { name: "消し込みの一覧" });
    expect(within(table).getByText("2026-11-10")).toBeInTheDocument();
    expect(within(table).getByText("99,560")).toBeInTheDocument();
    expect(within(table).getByText("440")).toBeInTheDocument();
    expect(await screen.findByText("入金済み")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "入金の消し込み" })).not.toBeInTheDocument();
  });

  it("手数料にしない入力は treatDifferenceAsFee を送らない", async () => {
    const calls = setupDetail(REMAINING_DETAIL, {
      [`POST ${BASE}/invoices/inv1/payments`]: () =>
        ok({ payment: PAYMENT, invoice: REMAINING_DETAIL, journal: { id: "jp1" } }, 201),
    });
    const user = userEvent.setup();
    const form = await fillPayment(user, { amount: "30000" });
    expect(within(form).queryByText(/振込手数料 /)).not.toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "消し込む" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      receivedOn: "2026-11-10",
      amount: 30_000,
      depositAccountId: "acc1020",
    });
  });

  it("残額を超える入金（PAYMENT_EXCEEDS_BALANCE）は残額つきの文言で出す", async () => {
    setupDetail(REMAINING_DETAIL, {
      [`POST ${BASE}/invoices/inv1/payments`]: () =>
        apiError(422, "PAYMENT_EXCEEDS_BALANCE", "入金額が請求の残額を超えています", {
          remaining: 100_000,
          applied: 100_001,
        }),
    });
    const user = userEvent.setup();
    const form = await fillPayment(user, { amount: "100001" });
    await user.click(within(form).getByRole("button", { name: "消し込む" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "入金額が請求の残額（100,000 円）を超えています。",
    );
  });

  it("入金額が空、入金先が未選択、手数料にできる差額がないときは送らずに知らせる", async () => {
    const calls = setupDetail();
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "入金の消し込み" });
    await user.clear(within(form).getByLabelText("入金額"));
    await user.click(within(form).getByRole("button", { name: "消し込む" }));
    expect(
      await within(form).findByText("入金額は 1 円以上の整数で入力してください"),
    ).toBeVisible();

    await user.type(within(form).getByLabelText("入金額"), "100000");
    await user.click(within(form).getByRole("button", { name: "消し込む" }));
    expect(await within(form).findByText("入金先の科目を選んでください")).toBeVisible();

    await user.selectOptions(within(form).getByLabelText("入金先の科目"), "acc1020");
    await user.click(within(form).getByLabelText("差額を振込手数料として扱う"));
    await user.click(within(form).getByRole("button", { name: "消し込む" }));
    expect(await within(form).findByText(/手数料にできる差額がありません/)).toBeVisible();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it.each([
    ["取消済み", { status: "voided", remaining: 0 }],
    ["入金済み", { status: "paid", paid: 100_000, remaining: 0 }],
  ])("%s の請求書には入力を出さない", async (_name, over) => {
    setupDetail({ ...REMAINING_DETAIL, ...over });
    await screen.findByRole("heading", { name: /請求書/ });
    await screen.findAllByText("株式会社A 御中");
    expect(screen.queryByRole("form", { name: "入金の消し込み" })).not.toBeInTheDocument();
  });
});

describe("消し込みの一覧と取消（詳細。FR-021）", () => {
  const PAID_DETAIL = {
    ...REMAINING_DETAIL,
    status: "paid",
    paid: 100_000,
    remaining: 0,
    payments: [PAYMENT],
  };

  it("理由つきで取り消すと POST し、取消済みの表示になって入力の欄が戻る", async () => {
    let voided = false;
    const calls = setupDetail(PAID_DETAIL, {
      [`GET ${BASE}/invoices/inv1`]: () =>
        ok(
          voided
            ? {
                ...REMAINING_DETAIL,
                payments: [
                  {
                    ...PAYMENT,
                    voidedAt: "2026-11-12T00:00:00.000Z",
                    voidReason: "入金の誤り",
                    voidJournalId: null,
                  },
                ],
              }
            : PAID_DETAIL,
        ),
      [`POST ${BASE}/invoices/inv1/payments/pay1/void`]: () => {
        voided = true;
        return ok({ payment: PAYMENT, invoice: PAID_DETAIL, journal: { id: "jp1" } });
      },
    });
    const user = userEvent.setup();
    const table = await screen.findByRole("table", { name: "消し込みの一覧" });
    expect(screen.queryByRole("form", { name: "入金の消し込み" })).not.toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "消し込みを取り消す" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("理由"), "入金の誤り");
    await user.click(within(dialog).getByRole("button", { name: "取消を確定" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ reason: "入金の誤り" });
    const after = await screen.findByRole("table", { name: "消し込みの一覧" });
    expect(await within(after).findByText("取消済み")).toBeInTheDocument();
    expect(within(after).getByText(/入金の誤り/)).toBeInTheDocument();
    expect(within(after).queryByRole("button", { name: "消し込みを取り消す" })).toBeNull();
    expect(await screen.findByRole("form", { name: "入金の消し込み" })).toBeInTheDocument();
  });

  it("入金の仕訳へのリンクを置く", async () => {
    setupDetail(PAID_DETAIL);
    const table = await screen.findByRole("table", { name: "消し込みの一覧" });
    expect(within(table).getByRole("link", { name: "仕訳を開く" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/journals/jp1"),
    );
  });
});

describe("請求書の一覧（期限切れ・状態の絞り込み・未回収。FR-020・022）", () => {
  const summary = (over: Record<string, unknown>) => ({
    id: "inv1",
    invoiceNo: "2026-0001",
    partnerId: P1,
    recipientName: "株式会社A",
    targetMonth: "2026-08",
    issueDate: "2026-08-31",
    dueDate: "2026-09-30",
    total: 100_000,
    paid: 0,
    remaining: 100_000,
    status: "unpaid",
    overdue: true,
    ...over,
  });

  function setupList(url = "/e/e1/invoices") {
    const calls = mockApi({
      [`GET ${BASE}/partners`]: () =>
        ok({
          partners: [
            { id: P1, name: "株式会社A", honorific: "御中", memo: null, isActive: true },
            { id: P2, name: "B 商事", honorific: null, memo: null, isActive: true },
          ],
        }),
      [`GET ${BASE}/invoices`]: () =>
        ok({
          invoices: [
            summary({}),
            summary({
              id: "inv2",
              invoiceNo: "2026-0002",
              partnerId: P2,
              recipientName: "B 商事",
              overdue: false,
              dueDate: "2026-12-31",
              total: 50_000,
              remaining: 50_000,
            }),
          ],
          outstandingByPartner: [
            { partnerId: P1, partnerName: "株式会社A", outstanding: 100_000, overdue: 100_000 },
            { partnerId: P2, partnerName: "B 商事", outstanding: 50_000, overdue: 0 },
          ],
        }),
    });
    renderRoute(ListRoute, { path: "/e/$entityId/invoices/", url });
    return calls;
  }

  it("期限切れの請求書に印を付け、そうでないものには付けない", async () => {
    setupList();
    const table = await screen.findByRole("table", { name: "請求書の一覧" });
    const late = within(table).getByRole("row", { name: /2026-0001/ });
    expect(within(late).getByText("期限切れ")).toBeInTheDocument();
    expect(within(late).getByText("未入金")).toBeInTheDocument();
    const ok2 = within(table).getByRole("row", { name: /2026-0002/ });
    expect(within(ok2).queryByText("期限切れ")).not.toBeInTheDocument();
  });

  it("取引先ごとの未回収（残額と、うち期限切れ）を出す", async () => {
    setupList();
    const summaryTable = await screen.findByRole("table", { name: "取引先ごとの未回収" });
    const a = within(summaryTable).getByRole("row", { name: /株式会社A/ });
    expect(within(a).getAllByText("100,000")).toHaveLength(2);
    const b = within(summaryTable).getByRole("row", { name: /B 商事/ });
    expect(within(b).getByText("50,000")).toBeInTheDocument();
    expect(within(b).getByText("0")).toBeInTheDocument();
  });

  it("状態で絞り込むとクエリに載せて読み直す（期限切れを含む）。URL の status も使う", async () => {
    const calls = setupList();
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "請求書の一覧" });
    await user.selectOptions(screen.getByLabelText("状態"), "overdue");
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.path === `${BASE}/invoices`)
          .some((c) => c.query.status === "overdue"),
      ).toBe(true),
    );
  });

  it("URL の status を読み込みのクエリに使う", async () => {
    const calls = setupList("/e/e1/invoices?status=partial");
    await screen.findByRole("table", { name: "請求書の一覧" });
    expect(calls.find((c) => c.path === `${BASE}/invoices`)?.query).toEqual({ status: "partial" });
  });
});
