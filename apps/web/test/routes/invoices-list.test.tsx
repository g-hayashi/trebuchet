import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/invoices/index";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const BASE = "/api/entities/e1";
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const PARTNERS = [
  { id: P1, name: "株式会社A", honorific: "御中", memo: null, isActive: true },
  { id: P2, name: "B 商事", honorific: null, memo: null, isActive: true },
];

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

function setup(url = "/e/e1/invoices") {
  const calls = mockApi({
    [`GET ${BASE}/partners`]: () => ok({ partners: PARTNERS }),
    [`GET ${BASE}/invoices`]: () =>
      ok({
        invoices: [
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
        ],
        outstandingByPartner: [],
      }),
  });
  renderRoute(Route, { path: "/e/$entityId/invoices/", url });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("請求書の一覧（US1。FR-020 の基本形）", () => {
  it("番号・取引先・対象月・合計・状態・残額を出し、番号は詳細へのリンクにする（状態「すべて」）", async () => {
    setup("/e/e1/invoices?status=all");

    const table = await screen.findByRole("table", { name: "請求書の一覧" });
    const row1 = within(table).getByRole("row", { name: /2026-0001/ });
    expect(within(row1).getByRole("link", { name: "2026-0001" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoices/inv1"),
    );
    expect(within(row1).getByText("株式会社A")).toBeInTheDocument();
    expect(within(row1).getByText("2026-10")).toBeInTheDocument();
    // 合計と残額（未入金なので同じ金額）
    expect(within(row1).getAllByText("405,000")).toHaveLength(2);
    expect(within(row1).getByText("未入金")).toBeInTheDocument();
    const row2 = within(table).getByRole("row", { name: /2026-0002/ });
    expect(within(row2).getByText("入金済み")).toBeInTheDocument();
    const row3 = within(table).getByRole("row", { name: /2026-0003/ });
    expect(within(row3).getByText("取消済み")).toBeInTheDocument();
  });

  it("取引先・対象月で絞り込むと、クエリに載せて読み直す", async () => {
    const calls = setup();
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "請求書の一覧" });

    await user.selectOptions(screen.getByLabelText("取引先"), P1);
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === `${BASE}/invoices`).some((c) => c.query.partnerId === P1),
      ).toBe(true),
    );
    fireMonth(screen.getByLabelText("対象月"), "2026-10");
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.path === `${BASE}/invoices`)
          .some((c) => c.query.partnerId === P1 && c.query.month === "2026-10"),
      ).toBe(true),
    );
  });

  it("URL の絞り込みを読み込みのクエリに使う", async () => {
    const calls = setup(`/e/e1/invoices?partnerId=${P2}&month=2026-09`);
    await screen.findByRole("table", { name: "請求書の一覧" });
    expect(calls.find((c) => c.path === `${BASE}/invoices`)?.query).toEqual({
      partnerId: P2,
      month: "2026-09",
    });
  });

  it("URL の status（ホームの押し先。011 T009）を読み込みのクエリに使う", async () => {
    const calls = setup("/e/e1/invoices?status=overdue");
    await screen.findByRole("table", { name: "請求書の一覧" });
    expect(calls.find((c) => c.path === `${BASE}/invoices`)?.query).toEqual({ status: "overdue" });
  });

  it("請求書の作成への導線を置く（工数・請求の設定の入口はメニュー）", async () => {
    setup();
    await screen.findByRole("table", { name: "請求書の一覧" });
    expect(screen.queryByRole("link", { name: "請求の設定" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "工数の入力" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "請求書を作る" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoices/new"),
    );
  });
});

/** type="month" の入力は userEvent.type で打てないので、値の変更の発火で代える */
function fireMonth(input: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
