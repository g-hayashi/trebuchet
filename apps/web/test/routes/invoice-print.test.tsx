import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/invoices/$invoiceId";
import { advance, useFakeClock } from "../fake-timers";
import { ENTITY as BASE } from "../fixtures";
import { INVOICE_DETAIL } from "../invoicing-fixtures";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

function renderDetail(detail: unknown = INVOICE_DETAIL, demo = false) {
  mockApi({
    [`GET ${BASE}/invoices/inv1`]: () => ok(detail),
    "GET /api/entities": () =>
      ok({
        entities: [
          { id: "e1", name: "事業体", kind: "individual", createdAt: "2026-01-01T00:00:00Z", demo },
        ],
      }),
  });
  return renderRoute(Route, {
    path: "/e/$entityId/invoices/$invoiceId",
    url: "/e/e1/invoices/inv1",
  });
}

/** 印刷用の請求書。画面では隠してあり、印刷のときだけ出る（011 FR-036）ので hidden を含めて探す */
const findSheet = () => screen.findByRole("article", { name: "請求書 2026-0001", hidden: true });

beforeEach(() => {
  document.title = "元のタイトル";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("請求書の印刷（詳細の画面から直接。US1 FR-011・012、US5 FR-036・037、SC-005・008）", () => {
  it("税抜入力は内訳非表示でも小計と消費税相当額を表示する", async () => {
    renderDetail({
      ...INVOICE_DETAIL,
      priceMode: "exclusive",
      taxDisplay: "inclusive_only",
      issuer: { ...INVOICE_DETAIL.issuer, registrationNumber: null },
      total: 445500,
      taxBreakdown: [{ rate: 10, exclusive: 405000, tax: 40500, inclusive: 445500 }],
    });
    const sheet = await findSheet();
    expect(
      within(sheet).getByRole("columnheader", { name: "金額（税抜）", hidden: true }),
    ).toBeInTheDocument();
    expect(within(sheet).getByText("小計（税抜）405,000 円")).toBeInTheDocument();
    expect(within(sheet).getByText("消費税相当額 40,500 円")).toBeInTheDocument();
  });

  it("宛名・発行者・番号・日付・明細・合計・振込先を出し、開いている間だけ title を請求番号にする", async () => {
    const { unmount } = renderDetail();

    const sheet = await findSheet();
    expect(within(sheet).getByText("株式会社A 御中")).toBeInTheDocument();
    expect(within(sheet).getByText("山田設計")).toBeInTheDocument();
    expect(within(sheet).getByText("山田 太郎")).toBeInTheDocument();
    expect(within(sheet).getByText("東京都千代田区")).toBeInTheDocument();
    expect(within(sheet).getByText("請求番号 2026-0001")).toBeInTheDocument();
    expect(within(sheet).getByText("発行日 2026-11-05")).toBeInTheDocument();
    expect(within(sheet).getByText("支払期限 2026-11-30")).toBeInTheDocument();
    const items = within(sheet).getByRole("table", { name: "明細", hidden: true });
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
    renderDetail({ ...INVOICE_DETAIL, taxDisplay: "inclusive_only", taxBreakdown: [] });

    const sheet = await findSheet();
    expect(
      within(sheet).queryByRole("table", { name: "消費税の内訳", hidden: true }),
    ).not.toBeInTheDocument();
    expect(within(sheet).getByText("ご請求金額 405,000 円")).toBeInTheDocument();
  });

  it("別記の請求書には、税率ごとの税抜・税額・税込を出す", async () => {
    renderDetail();

    const sheet = await findSheet();
    const breakdown = within(sheet).getByRole("table", { name: "消費税の内訳", hidden: true });
    const row = within(breakdown).getByRole("row", { name: /10%/, hidden: true });
    expect(within(row).getByText("368,182")).toBeInTheDocument();
    expect(within(row).getByText("36,818")).toBeInTheDocument();
    expect(within(row).getByText("405,000")).toBeInTheDocument();
  });

  it("登録番号は設定されているときだけ出す", async () => {
    renderDetail();
    const sheet = await findSheet();
    expect(within(sheet).getByText("登録番号 T1234567890123")).toBeInTheDocument();
  });

  it("登録番号も屋号もなければ、その行を出さない", async () => {
    renderDetail({
      ...INVOICE_DETAIL,
      issuer: { ...INVOICE_DETAIL.issuer, registrationNumber: null, tradeName: null },
    });
    const sheet = await findSheet();
    expect(within(sheet).queryByText(/登録番号/)).not.toBeInTheDocument();
    expect(within(sheet).queryByText("山田設計")).not.toBeInTheDocument();
    expect(within(sheet).getByText("山田 太郎")).toBeInTheDocument();
  });

  it("屋号と氏名が同じときは、発行元の名前を 1 回だけ出す（FR-037）", async () => {
    renderDetail({
      ...INVOICE_DETAIL,
      issuer: { ...INVOICE_DETAIL.issuer, tradeName: "山田 太郎" },
    });
    const sheet = await findSheet();
    expect(within(sheet).getAllByText("山田 太郎")).toHaveLength(1);
  });

  it("demo の事業体の請求書には、印刷にも「デモ（架空のデータ）」を出す。通常の事業体では出さない（014 T007）", async () => {
    useFakeClock();
    const { unmount } = renderDetail(INVOICE_DETAIL, true);
    const sheet = await findSheet();
    expect(await within(sheet).findByText("デモ（架空のデータ）")).toBeInTheDocument();
    unmount();

    renderDetail(INVOICE_DETAIL, false);
    const normal = await findSheet();
    // 事業体の一覧の取得が終わるのを待ってから、印が無いことを確かめる
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).endsWith("/api/entities"))).toBe(
        true,
      ),
    );
    await advance(100);
    expect(within(normal).queryByText("デモ（架空のデータ）")).not.toBeInTheDocument();
  });

  it("請求書は data-print-root の中に 1 通だけ置く", async () => {
    renderDetail();
    const sheet = await findSheet();
    const roots = document.querySelectorAll("[data-print-root]");
    expect(roots).toHaveLength(1);
    expect(roots[0]?.contains(sheet)).toBe(true);
    expect(roots[0]?.querySelectorAll("article")).toHaveLength(1);
  });

  it("data-print-root は hidden 属性で隠さない（preflight の `[hidden]` は layer 内の !important で、print.css では上書きできず印刷が空白になる）", async () => {
    renderDetail();
    await findSheet();
    const root = document.querySelector<HTMLElement>("[data-print-root]");
    expect(root).not.toBeNull();
    expect(root?.hasAttribute("hidden")).toBe(false);
    expect(root?.style.display).toBe("none");
  });

  it("「印刷・PDF に保存」は別のページへ移らず、押すと window.print() を呼ぶ", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const { router } = renderDetail();
    const button = await screen.findByRole("button", { name: "印刷・PDF に保存" });
    expect(screen.queryByRole("link", { name: "印刷・PDF に保存" })).not.toBeInTheDocument();
    expect(button.closest("[data-print-root]")).toBeNull();

    await userEvent.setup().click(button);

    expect(print).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/e/e1/invoices/inv1");
  });

  it("ブラウザの印刷の設定でヘッダーとフッターを消せることを、印刷の対象の外に小さく書く", async () => {
    renderDetail();
    const note = await screen.findByText("ブラウザの印刷の設定でヘッダーとフッターを消せます");
    expect(note.closest("[data-print-root]")).toBeNull();
  });

  it("取り消した請求書の印刷でも請求書は出る（画面で取消済みと分かる）", async () => {
    renderDetail({ ...INVOICE_DETAIL, status: "voided", remaining: 0 });
    expect(await findSheet()).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("2026-0001"));
  });
});

describe("全体の印刷用の CSS（src/print.css。FR-036）", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../src/print.css"), "utf8");

  it("印刷では [data-print-root] 以外を出さず、@page の余白は 0（余白は要素の padding）にする", () => {
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/@page\s*{[^}]*margin:\s*0/);
    expect(css).toMatch(/\[data-print-root\]/);
    expect(css).toMatch(/display:\s*none/);
    expect(css).toMatch(/padding:/);
  });
});

describe("源泉徴収（013 R8・FR-005）", () => {
  const WITH_WITHHOLDING = {
    ...INVOICE_DETAIL,
    total: 330_000,
    taxBreakdown: [{ rate: 10, exclusive: 300_000, tax: 30_000, inclusive: 330_000 }],
    withholdingBase: 300_000,
    withholdingTax: 30_630,
    netAmount: 299_370,
  };

  it("源泉徴収税額があるとき、合計の後に「源泉徴収税額」「差引請求額」の 2 行を出す", async () => {
    renderDetail(WITH_WITHHOLDING);
    const sheet = await findSheet();
    const total = within(sheet).getByText("合計 330,000 円");
    const tax = within(sheet).getByText("源泉徴収税額 30,630 円");
    const net = within(sheet).getByText("差引請求額 299,370 円");
    expect(total.compareDocumentPosition(tax) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tax.compareDocumentPosition(net) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("源泉徴収税額があるとき、見出しの「ご請求金額」は差引請求額（合計ではない）", async () => {
    renderDetail(WITH_WITHHOLDING);
    const sheet = await findSheet();
    expect(within(sheet).getByText("ご請求金額 299,370 円")).toBeInTheDocument();
    expect(within(sheet).queryByText("ご請求金額 330,000 円")).not.toBeInTheDocument();
  });

  it("源泉徴収税額が 0 なら、「ご請求金額」は合計。源泉徴収の行を出さない", async () => {
    renderDetail(INVOICE_DETAIL);
    const sheet = await findSheet();
    expect(within(sheet).getByText("ご請求金額 405,000 円")).toBeInTheDocument();
    expect(within(sheet).getByText("合計 405,000 円")).toBeInTheDocument();
    expect(within(sheet).queryByText(/源泉徴収税額/)).not.toBeInTheDocument();
    expect(within(sheet).queryByText(/差引請求額/)).not.toBeInTheDocument();
  });
});
