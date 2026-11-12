import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/receipts/$receiptId";
import { apiError, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, RECEIPT_SHA, receiptDetail } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T017: 証憑の詳細（H: §2 の GET 詳細・GET ファイル。FR-009、R9、R12）

const DETAIL = `/api/entities/e1/receipts/${RECEIPT_ID}`;
const FILE = `${DETAIL}/files/${RECEIPT_SHA}`;

const renderDetail = () =>
  renderRoute(Route, {
    path: "/e/$entityId/receipts/$receiptId",
    url: `/e/e1/receipts/${RECEIPT_ID}`,
  });

const withDetail = (over: Parameters<typeof receiptDetail>[0] = {}) =>
  mockApi({ [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail(over) }) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("証憑の詳細", () => {
  it("原本・値・結びつきは上にあり、情報・履歴・差し替え・削除は閉じたdetailsで下に並ぶ", async () => {
    withDetail();
    renderDetail();
    const image = await screen.findByRole("img", { name: "証憑の画像" });
    const values = screen.getByRole("form", { name: "証憑の値" });
    const links = screen.getByRole("region", { name: "仕訳との結びつき" });
    expect(image.closest("details")).toBeNull();
    expect(values.closest("details")).toBeNull();
    expect(links.closest("details")).toBeNull();
    for (const name of ["証憑の情報", "履歴", "ファイルの差し替え", "削除"]) {
      const summary = screen.getByText(name, { selector: "summary" });
      const details = summary.closest("details") as HTMLDetailsElement;
      expect(details).not.toHaveAttribute("open");
      for (const primary of [image, values, links])
        expect(
          primary.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      await userEvent.click(summary);
      expect(details).toHaveAttribute("open");
      await userEvent.click(summary);
      expect(details).not.toHaveAttribute("open");
    }
  });
  it("受領日時・ハッシュ・元の名前・形式・大きさ・経路・区分を表示する", async () => {
    withDetail({ receivedAt: "2026-10-20T12:00:00.000Z" });
    renderDetail();
    await userEvent.click(await screen.findByText("証憑の情報", { selector: "summary" }));
    const info = await screen.findByRole("region", { name: "証憑の情報" });
    const value = (name: string) => {
      const term = within(info).getByText(name, { selector: "dt" });
      return term.nextElementSibling as HTMLElement;
    };
    expect(value("受領日時")).toHaveTextContent(/2026\/10\/20/);
    expect(value("SHA-256")).toHaveTextContent(RECEIPT_SHA);
    expect(value("元の名前")).toHaveTextContent("領収書.jpg");
    expect(value("形式")).toHaveTextContent("JPEG");
    expect(value("大きさ")).toHaveTextContent("2.4 MB");
    expect(value("経路")).toHaveTextContent("この Mac から");
    expect(value("区分")).toHaveTextContent("電子取引");
    expect(value("画像の大きさ")).toHaveTextContent("4032×3024");
  });

  it("画像は表示用のファイルを表示し、原本を取り出すリンクを出す", async () => {
    withDetail();
    renderDetail();

    const image = await screen.findByRole("img", { name: "証憑の画像" });
    expect(image).toHaveAttribute("src", `${FILE}?variant=display`);
    expect(screen.getByRole("link", { name: "原本を取り出す" })).toHaveAttribute(
      "href",
      `${FILE}?variant=original&download=1`,
    );
  });

  it("PDF は埋め込みで表示する", async () => {
    withDetail({
      mediaType: "application/pdf",
      currentFile: {
        ...receiptDetail().currentFile,
        mediaType: "application/pdf",
        width: null,
        height: null,
        fullColor: null,
      },
    });
    renderDetail();

    const pdf = await screen.findByLabelText("証憑の PDF");
    expect(pdf.tagName).toBe("OBJECT");
    expect(pdf).toHaveAttribute("data", `${FILE}?variant=display`);
    expect(pdf).toHaveAttribute("type", "application/pdf");
  });

  it("HEIC は表示用に変換した画像だと示す", async () => {
    withDetail({
      mediaType: "image/heic",
      currentFile: { ...receiptDetail().currentFile, mediaType: "image/heic" },
    });
    renderDetail();
    expect(await screen.findByText(/表示用に JPEG へ変換した画像です/)).toBeInTheDocument();
  });

  it("警告を示し、解像度・階調・入力期間の警告には「紙の原本は捨てずに保存する」を添える", async () => {
    withDetail({
      category: "paper_scan",
      warnings: [
        { code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-06-30" } },
        { code: "NOT_FULL_COLOR" },
        { code: "FIELDS_MISSING" },
      ],
    });
    renderDetail();

    const warnings = await screen.findByRole("list", { name: "警告" });
    const items = within(warnings).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("2026-06-30");
    expect(items[0]).toHaveTextContent("紙の原本は捨てずに保存する");
    expect(items[1]).toHaveTextContent("紙の原本は捨てずに保存する");
    expect(items[2]).toHaveTextContent("未入力の項目があります");
    expect(items[2]).not.toHaveTextContent("紙の原本は捨てずに保存する");
  });

  it("結びついた仕訳へのリンクを出す。一覧へ戻るリンクがある", async () => {
    withDetail({
      linkState: "linked",
      journal: { id: "j1", journalNo: 12, date: "2026-10-20", status: "active" },
    });
    renderDetail();
    expect(await screen.findByRole("link", { name: "仕訳 No.12 を開く" })).toHaveAttribute(
      "href",
      "/e/e1/journals/j1",
    );
    expect(screen.getByRole("link", { name: "証憑の一覧" })).toHaveAttribute(
      "href",
      "/e/e1/receipts",
    );
  });

  it("削除済みの証憑は削除済みと理由を示し、値の入力フォームを出さない（ファイルは取り出せる）", async () => {
    withDetail({
      deleted: true,
      deletedAt: "2026-10-25T00:00:00.000Z",
      deletedReason: "重複して登録した",
    });
    renderDetail();
    expect(await screen.findByText(/削除済み/)).toBeInTheDocument();
    expect(screen.getByText(/重複して登録した/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "証憑の値" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "原本を取り出す" })).toBeInTheDocument();
  });

  it("証憑がなければ（404）エラーを示す", async () => {
    mockApi({
      [`GET ${DETAIL}`]: () => apiError(404, "RECEIPT_NOT_FOUND", "証憑が見つかりません"),
    });
    renderDetail();
    expect(await screen.findByRole("alert")).toHaveTextContent("証憑が見つかりません");
  });
});
