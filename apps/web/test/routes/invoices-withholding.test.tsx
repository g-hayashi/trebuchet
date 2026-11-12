import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/invoices/withholding";
import { ENTITY as BASE } from "../fixtures";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 013 US3: 源泉徴収の一覧（R8、contracts §4）

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";

const SUMMARY_2026 = {
  year: 2026,
  partners: [
    {
      partnerId: P1,
      partnerName: "株式会社A",
      paymentCount: 2,
      appliedTotal: 1_500_000,
      withholdingTotal: 153_150,
      payments: [
        {
          paymentId: "pay1",
          invoiceId: "inv1",
          invoiceNo: "20261031-001",
          receivedOn: "2026-11-10",
          applied: 1_000_000,
          withholdingAmount: 102_100,
        },
        {
          paymentId: "pay2",
          invoiceId: "inv2",
          invoiceNo: "20261130-001",
          receivedOn: "2026-12-20",
          applied: 500_000,
          withholdingAmount: 51_050,
        },
      ],
    },
    {
      partnerId: P2,
      partnerName: "B 商事",
      paymentCount: 1,
      appliedTotal: 300_000,
      withholdingTotal: 30_630,
      payments: [
        {
          paymentId: "pay3",
          invoiceId: "inv3",
          invoiceNo: "20261031-002",
          receivedOn: "2026-11-15",
          applied: 300_000,
          withholdingAmount: 30_630,
        },
      ],
    },
  ],
  appliedTotal: 1_800_000,
  withholdingTotal: 183_780,
};

const empty = (year: number) => ({ year, partners: [], appliedTotal: 0, withholdingTotal: 0 });

function setup(url: string, summaryOf: (year: number) => unknown = () => SUMMARY_2026) {
  const calls = mockApi(
    Object.fromEntries(
      [2025, 2026, 2027].map((year) => [
        `GET ${BASE}/withholding/${year}`,
        () => ok(summaryOf(year)),
      ]),
    ),
  );
  renderRoute(Route, { path: "/e/$entityId/invoices/withholding", url });
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("源泉徴収の一覧（013 US3）", () => {
  it("取引先ごとの行（件数・支払金額・源泉徴収税額）と合計を出す", async () => {
    setup("/e/e1/invoices/withholding?year=2026");

    expect(
      await screen.findByRole("heading", { name: "源泉徴収の一覧", level: 1 }),
    ).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "取引先ごとの源泉徴収" });
    const rowA = within(table).getByRole("row", { name: /株式会社A/ });
    expect(within(rowA).getByText("2")).toBeInTheDocument();
    expect(within(rowA).getByText("1,500,000")).toBeInTheDocument();
    expect(within(rowA).getByText("153,150")).toBeInTheDocument();
    const rowB = within(table).getByRole("row", { name: /B 商事/ });
    expect(within(rowB).getByText("300,000")).toBeInTheDocument();
    expect(within(rowB).getByText("30,630")).toBeInTheDocument();
    // 取引先名の順（応答の順）
    const names = within(table)
      .getAllByRole("row")
      .map((r) => r.textContent);
    expect(names.findIndex((t) => t?.includes("株式会社A"))).toBeLessThan(
      names.findIndex((t) => t?.includes("B 商事")),
    );
    const total = within(table).getByRole("row", { name: /合計/ });
    expect(within(total).getByText("1,800,000")).toBeInTheDocument();
    expect(within(total).getByText("183,780")).toBeInTheDocument();
    expect(within(total).getByText("3")).toBeInTheDocument();
  });

  it("行を開くと、入金日・請求番号・支払金額・源泉徴収税額の明細が出る。もう一度で閉じる", async () => {
    setup("/e/e1/invoices/withholding?year=2026");
    const user = userEvent.setup();
    const table = await screen.findByRole("table", { name: "取引先ごとの源泉徴収" });
    expect(screen.queryByRole("table", { name: "株式会社Aの明細" })).not.toBeInTheDocument();

    const toggle = within(table).getByRole("button", { name: "株式会社A" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const detail = await screen.findByRole("table", { name: "株式会社Aの明細" });
    const row = within(detail).getByRole("row", { name: /20261031-001/ });
    expect(within(row).getByText("2026-11-10")).toBeInTheDocument();
    expect(within(row).getByText("1,000,000")).toBeInTheDocument();
    expect(within(row).getByText("102,100")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "20261031-001" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoices/inv1"),
    );
    expect(within(detail).getByRole("row", { name: /20261130-001/ })).toBeInTheDocument();
    // 他の取引先の明細は開いていない
    expect(screen.queryByRole("table", { name: "B 商事の明細" })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.queryByRole("table", { name: "株式会社Aの明細" })).not.toBeInTheDocument();
  });

  it("年を選ぶと、その年の一覧を取り直し、URL の年も変わる", async () => {
    const calls = setup("/e/e1/invoices/withholding?year=2026", (year) =>
      year === 2026 ? SUMMARY_2026 : empty(year),
    );
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "取引先ごとの源泉徴収" });

    const select = screen.getByLabelText("年");
    expect(select).toHaveValue("2026");
    await user.selectOptions(select, "2025");
    await waitFor(() =>
      expect(calls.some((c) => c.path === `${BASE}/withholding/2025`)).toBe(true),
    );
    expect(
      await screen.findByText("2025 年に源泉徴収された入金はありません。"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "取引先ごとの源泉徴収" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("年")).toHaveValue("2025");
  });

  it("年の指定がなければ今年を開く。該当がなければ空の知らせを出す", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-03-10T12:00:00+09:00"));
    const calls = setup("/e/e1/invoices/withholding", (year) => empty(year));

    expect(
      await screen.findByText("2027 年に源泉徴収された入金はありません。"),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.path.includes("/withholding/")).map((c) => c.path)).toEqual([
      `${BASE}/withholding/2027`,
    ]);
    expect(screen.getByLabelText("年")).toHaveValue("2027");
  });
});
