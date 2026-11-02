import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RECEIPT_MAX_BYTES } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/receipts/index";
import { apiError, formFields, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, receiptDetail } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T017: 証憑の追加（H: §2 の POST。FR-001〜005、FR-022、E1）

const LIST = "/api/entities/e1/receipts";
const NOTE = "紙の原本は捨てずに保存する";

const renderList = () =>
  renderRoute(Route, { path: "/e/$entityId/receipts/", url: "/e/e1/receipts" });

const emptyList = () => ({ [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }) });

const jpeg = (name = "領収書.jpg", size = 1000) =>
  new File([new Uint8Array(size)], name, { type: "image/jpeg" });

async function openForm() {
  return await screen.findByRole("form", { name: "証憑を追加" });
}

const fileInput = (form: HTMLElement) => within(form).getByLabelText("証憑のファイル");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("証憑の追加フォーム", () => {
  it("区分は表示名で選ぶ。「紙を撮影」を選ぶと「紙の原本は捨てずに保存する」の注記を示す", async () => {
    mockApi(emptyList());
    renderList();
    const form = await openForm();
    expect(within(form).queryByText(new RegExp(NOTE))).not.toBeInTheDocument();

    await userEvent.click(within(form).getByRole("radio", { name: "紙を撮影（原本は保存）" }));
    expect(within(form).getByText(new RegExp(NOTE))).toBeInTheDocument();

    await userEvent.click(within(form).getByRole("radio", { name: "電子取引" }));
    expect(within(form).queryByText(new RegExp(NOTE))).not.toBeInTheDocument();
  });

  it("ファイルと区分を送る。options は区分と、入れた値だけ（経路は送らない）", async () => {
    const calls = mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201),
    });
    renderList();
    const form = await openForm();
    const user = userEvent.setup();

    await user.upload(fileInput(form), jpeg());
    await user.click(within(form).getByRole("radio", { name: "電子取引" }));
    await user.type(within(form).getByLabelText("取引年月日"), "2026-10-20");
    await user.type(within(form).getByLabelText("金額"), "1,100");
    await user.type(within(form).getByLabelText("取引先"), "合成の店");
    await user.type(within(form).getByLabelText("メモ"), "会議");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    const fields = formFields(post?.form);
    expect(fields?.file).toMatchObject({ name: "領収書.jpg", size: 1000 });
    expect(JSON.parse(String(fields?.options))).toEqual({
      category: "electronic",
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
      memo: "会議",
    });
  });

  it("値は省ける（区分とファイルだけ）。成功すると結果と詳細へのリンクを出し、一覧を読み直す", async () => {
    let listed = 0;
    const calls = mockApi({
      [`GET ${LIST}`]: () => {
        listed += 1;
        return ok({ receipts: [], nextCursor: null });
      },
      [`POST ${LIST}`]: () =>
        ok({ receipt: receiptDetail({ warnings: [{ code: "FIELDS_MISSING" }] }) }, 201),
    });
    renderList();
    const form = await openForm();
    await userEvent.upload(fileInput(form), jpeg());
    await userEvent.click(within(form).getByRole("radio", { name: "紙を撮影（原本は保存）" }));
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));

    const status = await screen.findByRole("status");
    expect(within(status).getByText(/保存しました/)).toBeInTheDocument();
    expect(within(status).getByText("未入力の項目があります")).toBeInTheDocument();
    expect(within(status).getByRole("link", { name: "証憑を開く" })).toHaveAttribute(
      "href",
      `/e/e1/receipts/${RECEIPT_ID}`,
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(String(formFields(post?.form)?.options))).toEqual({ category: "paper_scan" });
    await waitFor(() => expect(listed).toBeGreaterThan(1));
  });

  it("警告（入力期間・解像度・階調）の文に「紙の原本は捨てずに保存する」を添える。保存は拒まれていない", async () => {
    mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () =>
        ok(
          {
            receipt: receiptDetail({
              category: "paper_scan",
              warnings: [
                { code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-06-30" } },
                {
                  code: "RESOLUTION_BELOW_GUIDE",
                  details: { width: 800, height: 600, minLong: 1280, minShort: 960 },
                },
                { code: "NOT_FULL_COLOR" },
              ],
            }),
          },
          201,
        ),
    });
    renderList();
    const form = await openForm();
    await userEvent.upload(fileInput(form), jpeg());
    await userEvent.click(within(form).getByRole("radio", { name: "紙を撮影（原本は保存）" }));
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));

    const status = await screen.findByRole("status");
    const warnings = within(status).getAllByRole("listitem");
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toHaveTextContent("2026-06-30");
    expect(warnings[1]).toHaveTextContent("800×600");
    for (const item of warnings) expect(item).toHaveTextContent(NOTE);
    expect(within(status).getByText(/保存しました/)).toBeInTheDocument();
  });

  it("20 MB を超えるファイルは送らずに止める。ちょうど 20 MB は送る", async () => {
    const calls = mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201),
    });
    renderList();
    const form = await openForm();
    const user = userEvent.setup();
    await user.click(within(form).getByRole("radio", { name: "電子取引" }));

    await user.upload(fileInput(form), jpeg("big.jpg", RECEIPT_MAX_BYTES + 1));
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(
      await within(form).findByText("ファイルが大きすぎます（20 MB まで）。"),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await user.upload(fileInput(form), jpeg("ok.jpg", RECEIPT_MAX_BYTES));
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
  });

  it("ファイルか区分がなければ送らずに知らせる。金額が正の整数でなければ止める", async () => {
    const calls = mockApi(emptyList());
    renderList();
    const form = await openForm();
    const user = userEvent.setup();

    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("ファイルを選んでください")).toBeInTheDocument();
    expect(within(form).getByText("区分を選んでください")).toBeInTheDocument();

    await user.upload(fileInput(form), jpeg());
    await user.click(within(form).getByRole("radio", { name: "電子取引" }));
    await user.type(within(form).getByLabelText("金額"), "0");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("1 円以上の整数で入力してください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("409 RECEIPT_DUPLICATE は既存の証憑へ案内する。削除済みなら示す", async () => {
    mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () =>
        apiError(409, "RECEIPT_DUPLICATE", "同じ内容の証憑がすでにあります", {
          receiptId: RECEIPT_ID,
          deleted: true,
        }),
    });
    renderList();
    const form = await openForm();
    await userEvent.upload(fileInput(form), jpeg());
    await userEvent.click(within(form).getByRole("radio", { name: "電子取引" }));
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("同じファイルがすでにあります。");
    expect(alert).toHaveTextContent("削除済みの証憑です");
    expect(within(form).getByRole("link", { name: "同じ内容の証憑を開く" })).toHaveAttribute(
      "href",
      `/e/e1/receipts/${RECEIPT_ID}`,
    );
  });

  it("対応していない形式（422）はサーバーのエラーを表示する", async () => {
    mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () => apiError(422, "RECEIPT_FORMAT_UNSUPPORTED", "対応していない形式です"),
    });
    renderList();
    const form = await openForm();
    await userEvent.upload(fileInput(form), jpeg("memo.jpg"));
    await userEvent.click(within(form).getByRole("radio", { name: "電子取引" }));
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "このファイルは扱えません。JPEG・PNG・HEIC・PDF のファイルを選んでください。",
    );
  });
});
