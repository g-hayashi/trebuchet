import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/invoices/$invoiceId";
import { INVOICE_DETAIL } from "../invoicing-fixtures";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const BASE = "/api/entities/e1";

const DETAIL = INVOICE_DETAIL;

function setup(detail: unknown = DETAIL, extra = {}) {
  const calls = mockApi({
    [`GET ${BASE}/invoices/inv1`]: () => ok(detail),
    ...extra,
  });
  renderRoute(Route, { path: "/e/$entityId/invoices/$invoiceId", url: "/e/e1/invoices/inv1" });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("請求書の詳細（US1。FR-010〜014）", () => {
  it("税抜入力は内訳非表示でも小計と消費税相当額を表示する", async () => {
    setup({
      ...DETAIL,
      priceMode: "exclusive",
      taxDisplay: "inclusive_only",
      issuer: { ...DETAIL.issuer, registrationNumber: null },
      total: 445500,
      taxBreakdown: [{ rate: 10, exclusive: 405000, tax: 40500, inclusive: 445500 }],
    });
    await screen.findByRole("heading", { name: "請求書 2026-0001" });
    expect(screen.getByRole("columnheader", { name: "単価（税抜）" })).toBeInTheDocument();
    // 同じ文は印刷用の請求書（data-print-root。画面では隠れる）にもあるので、画面の側（先頭）を見る
    expect(screen.getAllByText("小計（税抜）405,000 円")[0]).toBeVisible();
    expect(screen.getAllByText("消費税相当額 40,500 円")[0]).toBeVisible();
  });
  it("番号・宛名・日付・明細・合計・状態・残額を出し、売上の仕訳と印刷にリンクする", async () => {
    setup();

    expect(await screen.findByRole("heading", { name: "請求書 2026-0001" })).toBeInTheDocument();
    expect(screen.getAllByText("株式会社A 御中")[0]).toBeVisible();
    expect(screen.getByText("未入金")).toBeInTheDocument();
    expect(screen.getAllByText(/支払期限 2026-11-30/)[0]).toBeVisible();
    expect(screen.getByText(/売上の計上日 2026-10-31/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "明細" });
    expect(within(table).getByText("システム開発")).toBeInTheDocument();
    expect(within(table).getByText("405,000")).toBeInTheDocument();
    expect(screen.getAllByText("合計 405,000 円")[0]).toBeVisible();
    expect(screen.getByText("残額 405,000 円")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "売上の仕訳を開く" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/journals/j1"),
    );
    // 発行済みの請求書の主な操作
    expect(screen.getByRole("button", { name: "印刷・PDF に保存" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "印刷・PDF に保存" })).not.toBeInTheDocument();
  });

  it("取り消すと理由を POST し、取消済みの表示と取消の仕訳へのリンクに変わる", async () => {
    let voided = false;
    const calls = setup(DETAIL, {
      [`GET ${BASE}/invoices/inv1`]: () =>
        ok(
          voided
            ? {
                ...DETAIL,
                status: "voided",
                remaining: 0,
                voidedAt: "2026-11-06T00:00:00.000Z",
                voidReason: "宛先の誤り",
                voidJournalId: "j2",
              }
            : DETAIL,
        ),
      [`POST ${BASE}/invoices/inv1/void`]: () => {
        voided = true;
        return ok({ invoice: DETAIL, journal: { id: "j2" } });
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "取り消す" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("理由"), "宛先の誤り");
    await user.click(within(dialog).getByRole("button", { name: "取消を確定" }));

    expect(await screen.findByText("取消済み")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ reason: "宛先の誤り" });
    expect(screen.getByText(/理由: 宛先の誤り/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "取消の仕訳を開く" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/journals/j2"),
    );
    expect(screen.queryByRole("button", { name: "取り消す" })).not.toBeInTheDocument();
  });

  it("入金の消し込みがあって取り消せないときは、理由の画面にエラーを出す", async () => {
    setup(DETAIL, {
      [`POST ${BASE}/invoices/inv1/void`]: () =>
        apiError(409, "INVOICE_HAS_PAYMENTS", "入金の消し込みを先に取り消してください"),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "取り消す" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("理由"), "誤り");
    await user.click(within(dialog).getByRole("button", { name: "取消を確定" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("入金の消し込みを先に");
  });

  it("締め済みの年度の取消のエラーを文言にして出す", async () => {
    setup(DETAIL, {
      [`POST ${BASE}/invoices/inv1/void`]: () => apiError(409, "PERIOD_CLOSED", "締め済み"),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "取り消す" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("理由"), "誤り");
    await user.click(within(dialog).getByRole("button", { name: "取消を確定" }));

    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "締め済みの会計期間は変更できません。",
      ),
    );
  });

  it("請求書が見つからないときはエラーを出す", async () => {
    mockApi({
      [`GET ${BASE}/invoices/inv1`]: () =>
        apiError(404, "INVOICE_NOT_FOUND", "請求書が見つかりません"),
    });
    renderRoute(Route, { path: "/e/$entityId/invoices/$invoiceId", url: "/e/e1/invoices/inv1" });
    expect(await screen.findByRole("alert")).toHaveTextContent("請求書が見つかりません");
  });
});
