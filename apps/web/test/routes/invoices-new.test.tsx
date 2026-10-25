import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/invoices/new";
import { type ApiReply, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const BASE = "/api/entities/e1";
const PARTNERS = [
  { id: "p1", name: "株式会社A", honorific: "御中", memo: null, isActive: true },
  { id: "p2", name: "B 商事", honorific: null, memo: null, isActive: true },
  { id: "p3", name: "C 社", honorific: "様", memo: null, isActive: true },
];

const hourlyDraft = (over: Record<string, unknown> = {}) => ({
  partnerId: "p1",
  targetMonth: "2026-10",
  issueDate: "2026-11-05",
  salesDate: "2026-10-31",
  dueDate: "2026-11-30",
  items: [
    {
      name: "システム開発",
      quantity: 40.5,
      unit: "時間",
      unitPrice: 10_000,
      amount: 405_000,
      taxCategory: "SALES_10",
    },
  ],
  total: 405_000,
  taxDisplay: "inclusive_only",
  taxBreakdown: [],
  warnings: [],
  ...over,
});

const monthlyDraft = {
  partnerId: "p2",
  targetMonth: "2026-10",
  issueDate: "2026-11-05",
  salesDate: "2026-10-31",
  dueDate: "2026-11-30",
  items: [{ name: "保守費", amount: 100_000, taxCategory: "SALES_10" }],
  total: 100_000,
  taxDisplay: "inclusive_only",
  taxBreakdown: [],
  warnings: [],
};

const INVOICE = {
  id: "inv1",
  invoiceNo: "2026-0001",
  partnerId: "p1",
  recipientName: "株式会社A",
  targetMonth: "2026-10",
  issueDate: "2026-11-05",
  dueDate: "2026-11-30",
  total: 405_000,
  paid: 0,
  remaining: 405_000,
  status: "unpaid",
  overdue: false,
};

function setup(
  drafts: unknown[],
  extra: Record<string, () => ApiReply> = {},
  skipped: { partnerId: string; reason: string }[] = [],
) {
  const calls = mockApi({
    [`GET ${BASE}/partners`]: () => ok({ partners: PARTNERS }),
    [`POST ${BASE}/invoices/drafts`]: () => ok({ drafts, skipped }),
    ...extra,
  });
  renderRoute(Route, {
    path: "/e/$entityId/invoices/new",
    url: "/e/e1/invoices/new?month=2026-10",
  });
  return calls;
}

const user = () => userEvent.setup();

async function makeDrafts(u: ReturnType<typeof userEvent.setup>) {
  await u.click(await screen.findByRole("button", { name: "案を作る" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("請求書の案と発行（US1。FR-006〜016）", () => {
  it("対象月の案を作り、取引先ごとに明細・合計・日付を出す", async () => {
    const calls = setup([hourlyDraft(), monthlyDraft]);
    const u = user();
    await makeDrafts(u);

    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    expect(calls.find((c) => c.path === `${BASE}/invoices/drafts`)?.body).toEqual({
      month: "2026-10",
    });
    expect(within(a).getByLabelText("品名 1")).toHaveValue("システム開発");
    expect(within(a).getByLabelText("数量 1")).toHaveValue(40.5);
    expect(within(a).getByLabelText("単価 1")).toHaveValue(10_000);
    expect(within(a).getByLabelText("金額 1")).toHaveValue("405,000");
    expect(within(a).getByText("合計 405,000 円")).toBeInTheDocument();
    expect(within(a).getByLabelText("発行日")).toHaveValue("2026-11-05");
    expect(within(a).getByLabelText("売上の計上日")).toHaveValue("2026-10-31");
    expect(within(a).getByText(/支払期限 2026-11-30/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "請求書の案（B 商事）" })).toBeInTheDocument();
  });

  it("工数がなくて案を作れなかった取引先を知らせる", async () => {
    setup([hourlyDraft()], {}, [
      { partnerId: "p2", reason: "NO_HOURS" },
      { partnerId: "p3", reason: "ZERO_HOURS" },
    ]);
    await makeDrafts(user());

    await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    expect(screen.getByText(/B 商事.*工数が未入力/)).toBeInTheDocument();
    expect(screen.getByText(/C 社.*工数が 0/)).toBeInTheDocument();
  });

  it("数量を直すと金額と合計を再計算する（0.5 刻み、端数は切り捨て）", async () => {
    setup([hourlyDraft()]);
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });

    await u.clear(within(a).getByLabelText("単価 1"));
    await u.type(within(a).getByLabelText("単価 1"), "3333");
    // floor(40.5 * 3333) = 134986
    expect(within(a).getByLabelText("金額 1")).toHaveValue("134,986");
    expect(within(a).getByText("合計 134,986 円")).toBeInTheDocument();
  });

  it("明細は最大 5 行まで足せ、行を消せる。月額の行は金額を直接入力する", async () => {
    setup([monthlyDraft]);
    const u = user();
    await makeDrafts(u);
    const b = await screen.findByRole("region", { name: "請求書の案（B 商事）" });

    for (let i = 0; i < 4; i += 1) {
      await u.click(within(b).getByRole("button", { name: "明細を追加" }));
    }
    expect(within(b).getByLabelText("品名 5")).toBeInTheDocument();
    expect(within(b).getByRole("button", { name: "明細を追加" })).toBeDisabled();

    await u.type(within(b).getByLabelText("品名 2"), "出張費");
    await u.type(within(b).getByLabelText("金額 2"), "2500");
    expect(within(b).getByText("合計 102,500 円")).toBeInTheDocument();

    await u.click(within(b).getByRole("button", { name: "明細 2 を削除" }));
    expect(within(b).queryByLabelText("品名 5")).not.toBeInTheDocument();
    expect(within(b).getByText("合計 100,000 円")).toBeInTheDocument();
  });

  it("発行すると POST /invoices に、発行日・売上の計上日（既定値）と明細を載せる", async () => {
    const calls = setup([hourlyDraft()], {
      [`POST ${BASE}/invoices`]: () => ok({ invoice: INVOICE, journal: { id: "j1" } }, 201),
    });
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });

    await u.click(within(a).getByRole("button", { name: "発行する" }));

    await waitFor(() => expect(within(a).getByRole("status")).toHaveTextContent("2026-0001"));
    expect(within(a).getByRole("link", { name: "請求書 2026-0001 を開く" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoices/inv1"),
    );
    expect(calls.find((c) => c.method === "POST" && c.path === `${BASE}/invoices`)?.body).toEqual({
      partnerId: "p1",
      targetMonth: "2026-10",
      issueDate: "2026-11-05",
      salesDate: "2026-10-31",
      items: [
        {
          name: "システム開発",
          quantity: 40.5,
          unit: "時間",
          unitPrice: 10_000,
          amount: 405_000,
          taxCategory: "SALES_10",
        },
      ],
    });
  });

  it("発行日と売上の計上日を変えると、変えた値が発行の入力に載る", async () => {
    const calls = setup([monthlyDraft], {
      [`POST ${BASE}/invoices`]: () =>
        ok({ invoice: { ...INVOICE, partnerId: "p2" }, journal: { id: "j1" } }, 201),
    });
    const u = user();
    await makeDrafts(u);
    const b = await screen.findByRole("region", { name: "請求書の案（B 商事）" });

    await u.clear(within(b).getByLabelText("発行日"));
    await u.type(within(b).getByLabelText("発行日"), "2026-11-10");
    await u.clear(within(b).getByLabelText("売上の計上日"));
    await u.type(within(b).getByLabelText("売上の計上日"), "2026-11-01");
    await u.click(within(b).getByRole("button", { name: "発行する" }));

    await waitFor(() => expect(within(b).getByRole("status")).toBeInTheDocument());
    expect(calls.find((c) => c.method === "POST" && c.path === `${BASE}/invoices`)?.body).toEqual({
      partnerId: "p2",
      targetMonth: "2026-10",
      issueDate: "2026-11-10",
      salesDate: "2026-11-01",
      items: [{ name: "保守費", amount: 100_000, taxCategory: "SALES_10" }],
    });
  });

  it("同じ月の請求書がある警告は、確認のチェックを入れるまで発行できず、確認を載せて送る", async () => {
    const calls = setup(
      [
        hourlyDraft({
          warnings: [
            {
              code: "INVOICE_DUPLICATE_MONTH",
              message: "この取引先・月の請求書がすでにあります",
            },
          ],
        }),
      ],
      {
        [`POST ${BASE}/invoices`]: () => ok({ invoice: INVOICE, journal: { id: "j1" } }, 201),
      },
    );
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });

    expect(within(a).getByText(/この取引先・月の請求書がすでにあります/)).toBeInTheDocument();
    expect(within(a).getByRole("button", { name: "発行する" })).toBeDisabled();
    await u.click(within(a).getByLabelText("それでも発行する"));
    await u.click(within(a).getByRole("button", { name: "発行する" }));

    await waitFor(() => expect(within(a).getByRole("status")).toBeInTheDocument());
    expect(calls.find((c) => c.method === "POST" && c.path === `${BASE}/invoices`)?.body).toEqual(
      expect.objectContaining({ confirmDuplicate: true }),
    );
  });

  it("発行者の設定が足りないときは、設定の画面へ案内する", async () => {
    setup([hourlyDraft()], {
      [`POST ${BASE}/invoices`]: () =>
        apiError(422, "INVOICE_ISSUER_INCOMPLETE", "発行者の設定が不足しています"),
    });
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    await u.click(within(a).getByRole("button", { name: "発行する" }));

    expect(await within(a).findByRole("alert")).toHaveTextContent("発行者の設定が不足");
    expect(within(a).getByRole("link", { name: "請求の設定を開く" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoice-settings"),
    );
  });

  it("締め済みの期間・消費税の設定の空白のエラーを文言にして出す", async () => {
    let n = 0;
    setup([hourlyDraft()], {
      [`POST ${BASE}/invoices`]: () => {
        n += 1;
        return n === 1
          ? apiError(409, "PERIOD_CLOSED", "締め済み")
          : apiError(422, "TAX_SETTING_GAP", "2026-11-05 の設定がありません");
      },
    });
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });

    await u.click(within(a).getByRole("button", { name: "発行する" }));
    expect(await within(a).findByRole("alert")).toHaveTextContent(
      "締め済みの会計期間は変更できません。",
    );
    await u.click(within(a).getByRole("button", { name: "発行する" }));
    await waitFor(() =>
      expect(within(a).getByRole("alert")).toHaveTextContent(
        "消費税の設定の期間に空白または重複があります。",
      ),
    );
  });

  it("金額が 0 の案は、発行前に入力を促す（発行できない）", async () => {
    const calls = setup([{ ...monthlyDraft, items: [{ name: "保守費", amount: 0 }], total: 0 }]);
    const u = user();
    await makeDrafts(u);
    const b = await screen.findByRole("region", { name: "請求書の案（B 商事）" });

    expect(within(b).getByRole("button", { name: "発行する" })).toBeDisabled();
    expect(within(b).getByText(/金額が 0 円/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === `${BASE}/invoices`)).toBe(false);
  });
});
