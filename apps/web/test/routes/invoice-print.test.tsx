import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/invoices/$invoiceId_.print";
import { INVOICE_DETAIL } from "../invoicing-fixtures";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const BASE = "/api/entities/e1";

function renderPrint(detail: unknown = INVOICE_DETAIL) {
  mockApi({ [`GET ${BASE}/invoices/inv1`]: () => ok(detail) });
  return renderRoute(Route, {
    path: "/e/$entityId/invoices/$invoiceId/print",
    url: "/e/e1/invoices/inv1/print",
  });
}

beforeEach(() => {
  document.title = "元のタイトル";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("請求書の印刷用の画面（US1。FR-011・012、SC-005）", () => {
  it("宛名・発行者・番号・日付・明細・合計・振込先を出し、開いている間だけ title を請求番号にする", async () => {
    const { unmount } = renderPrint();

    const sheet = await screen.findByRole("article", { name: "請求書 2026-0001" });
    expect(within(sheet).getByText("株式会社A 御中")).toBeInTheDocument();
    expect(within(sheet).getByText("山田設計")).toBeInTheDocument();
    expect(within(sheet).getByText("山田 太郎")).toBeInTheDocument();
    expect(within(sheet).getByText("東京都千代田区")).toBeInTheDocument();
    expect(within(sheet).getByText("請求番号 2026-0001")).toBeInTheDocument();
    expect(within(sheet).getByText("発行日 2026-11-05")).toBeInTheDocument();
    expect(within(sheet).getByText("支払期限 2026-11-30")).toBeInTheDocument();
    const items = within(sheet).getByRole("table", { name: "明細" });
    expect(within(items).getByText("システム開発")).toBeInTheDocument();
    expect(within(items).getByText("40.5 時間")).toBeInTheDocument();
    expect(within(items).getByText("10,000")).toBeInTheDocument();
    expect(within(items).getByText("405,000")).toBeInTheDocument();
    expect(within(sheet).getByText("ご請求金額 405,000 円")).toBeInTheDocument();
    expect(within(sheet).getByText(/○○銀行 普通 1234567/)).toBeInTheDocument();
    expect(document.title).toBe("2026-0001");

    unmount();
    expect(document.title).toBe("元のタイトル");
  });

  it("税込のみの請求書には、税率ごとの内訳を出さない", async () => {
    renderPrint({ ...INVOICE_DETAIL, taxDisplay: "inclusive_only", taxBreakdown: [] });

    const sheet = await screen.findByRole("article", { name: "請求書 2026-0001" });
    expect(within(sheet).queryByRole("table", { name: "消費税の内訳" })).not.toBeInTheDocument();
    expect(within(sheet).getByText("ご請求金額 405,000 円")).toBeInTheDocument();
  });

  it("別記の請求書には、税率ごとの税抜・税額・税込を出す", async () => {
    renderPrint();

    const sheet = await screen.findByRole("article", { name: "請求書 2026-0001" });
    const breakdown = within(sheet).getByRole("table", { name: "消費税の内訳" });
    const row = within(breakdown).getByRole("row", { name: /10%/ });
    expect(within(row).getByText("368,182")).toBeInTheDocument();
    expect(within(row).getByText("36,818")).toBeInTheDocument();
    expect(within(row).getByText("405,000")).toBeInTheDocument();
  });

  it("登録番号は設定されているときだけ出す", async () => {
    renderPrint();
    const sheet = await screen.findByRole("article", { name: "請求書 2026-0001" });
    expect(within(sheet).getByText("登録番号 T1234567890123")).toBeInTheDocument();
  });

  it("登録番号も屋号もなければ、その行を出さない", async () => {
    renderPrint({
      ...INVOICE_DETAIL,
      issuer: { ...INVOICE_DETAIL.issuer, registrationNumber: null, tradeName: null },
    });
    const sheet = await screen.findByRole("article", { name: "請求書 2026-0001" });
    expect(within(sheet).queryByText(/登録番号/)).not.toBeInTheDocument();
    expect(within(sheet).queryByText("山田設計")).not.toBeInTheDocument();
    expect(within(sheet).getByText("山田 太郎")).toBeInTheDocument();
  });

  it("印刷の操作は印刷の対象外（no-print）に置く", async () => {
    renderPrint();
    const button = await screen.findByRole("button", { name: "印刷・PDF に保存" });
    expect(button.closest(".no-print")).not.toBeNull();
  });
});
