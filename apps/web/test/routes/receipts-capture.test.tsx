import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RECEIPT_MAX_BYTES } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/receipts/capture";
import { Route as HomeRoute } from "@/routes/index";
import { apiError, formFields, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, receiptDetail } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T018: スマホからの撮影・選択（R16、FR-006、US2）。端末のカメラは jsdom にないので、input の属性とファイルの選択で確かめる

const LIST = "/api/entities/e1/receipts";
const NOTE = "紙の原本は捨てずに保存する";

const renderCapture = () =>
  renderRoute(Route, { path: "/e/$entityId/receipts/capture", url: "/e/e1/receipts/capture" });

const jpeg = (name = "領収書.jpg", size = 1000) =>
  new File([new Uint8Array(size)], name, { type: "image/jpeg" });

async function openForm() {
  return await screen.findByRole("form", { name: "証憑を撮る" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("撮影・選択の入力", () => {
  it("撮影は capture=environment の画像、選択は capture なしで JPEG・PNG・HEIC・PDF", async () => {
    mockApi({});
    renderCapture();
    const form = await openForm();

    const camera = within(form).getByLabelText("写真を撮る");
    expect(camera).toHaveAttribute("type", "file");
    expect(camera).toHaveAttribute("accept", "image/*");
    expect(camera).toHaveAttribute("capture", "environment");

    const picker = within(form).getByLabelText("ファイルを選ぶ");
    expect(picker).toHaveAttribute("type", "file");
    expect(picker).not.toHaveAttribute("capture");
    const accept = picker.getAttribute("accept") ?? "";
    for (const type of ["image/jpeg", "image/png", "image/heic", "image/heif", "application/pdf"]) {
      expect(accept.split(",")).toContain(type);
    }
  });

  it("撮影でもファイルの選択でも、選んだファイルを送る。options は区分と、入れた値だけ", async () => {
    const calls = mockApi({ [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201) });
    renderCapture();
    const form = await openForm();
    const user = userEvent.setup();

    await user.upload(within(form).getByLabelText("写真を撮る"), jpeg("撮影.jpg", 2000));
    expect(within(form).getByText(/撮影\.jpg/)).toBeInTheDocument();
    await user.click(within(form).getByRole("radio", { name: "電子取引" }));
    await user.type(within(form).getByLabelText("取引年月日"), "2026-10-20");
    await user.type(within(form).getByLabelText("金額"), "1,100");
    await user.type(within(form).getByLabelText("取引先"), "合成の店");
    await user.click(within(form).getByRole("button", { name: "送信" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const fields = formFields(calls.find((c) => c.method === "POST")?.form);
    expect(fields?.file).toMatchObject({ name: "撮影.jpg", size: 2000 });
    expect(JSON.parse(String(fields?.options))).toEqual({
      category: "electronic",
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
    });
  });

  it("あとから選んだファイルに置き換わる", async () => {
    const calls = mockApi({ [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201) });
    renderCapture();
    const form = await openForm();
    const user = userEvent.setup();

    await user.upload(within(form).getByLabelText("写真を撮る"), jpeg("first.jpg"));
    await user.upload(within(form).getByLabelText("ファイルを選ぶ"), jpeg("second.jpg"));
    await user.click(within(form).getByRole("radio", { name: "電子取引" }));
    await user.click(within(form).getByRole("button", { name: "送信" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(formFields(calls.find((c) => c.method === "POST")?.form)?.file).toMatchObject({
      name: "second.jpg",
    });
  });
});

describe("区分と注記", () => {
  it("「紙を撮影」を選ぶと「紙の原本は捨てずに保存する」の注記を示す", async () => {
    mockApi({});
    renderCapture();
    const form = await openForm();
    expect(within(form).queryByText(new RegExp(NOTE))).not.toBeInTheDocument();

    await userEvent.click(within(form).getByRole("radio", { name: "紙を撮影（原本は保存）" }));
    expect(within(form).getByText(new RegExp(NOTE))).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("radio", { name: "電子取引" }));
    expect(within(form).queryByText(new RegExp(NOTE))).not.toBeInTheDocument();
  });

  it("ファイルか区分がなければ送らずに知らせる。20 MB を超えるファイル・正でない金額も止める", async () => {
    const calls = mockApi({});
    renderCapture();
    const form = await openForm();
    const user = userEvent.setup();

    await user.click(within(form).getByRole("button", { name: "送信" }));
    expect(await within(form).findByText("ファイルを選んでください")).toBeInTheDocument();
    expect(within(form).getByText("区分を選んでください")).toBeInTheDocument();

    await user.upload(
      within(form).getByLabelText("ファイルを選ぶ"),
      jpeg("big.jpg", RECEIPT_MAX_BYTES + 1),
    );
    await user.click(within(form).getByRole("radio", { name: "電子取引" }));
    await user.click(within(form).getByRole("button", { name: "送信" }));
    expect(
      await within(form).findByText("ファイルが大きすぎます（20 MB まで）。"),
    ).toBeInTheDocument();

    await user.upload(within(form).getByLabelText("ファイルを選ぶ"), jpeg());
    await user.type(within(form).getByLabelText("金額"), "0");
    await user.click(within(form).getByRole("button", { name: "送信" }));
    expect(await within(form).findByText("1 円以上の整数で入力してください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

async function fillAndSend(category: "電子取引" | "紙を撮影（原本は保存）" = "電子取引") {
  const form = await openForm();
  await userEvent.upload(within(form).getByLabelText("写真を撮る"), jpeg());
  await userEvent.click(within(form).getByRole("radio", { name: category }));
  await userEvent.click(within(form).getByRole("button", { name: "送信" }));
  return form;
}

describe("送信の結果", () => {
  it("201 を受けるまでは保存したと表示しない。受けると保存の結果・警告（注記つき）・詳細へのリンクを出す", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi({
      [`POST ${LIST}`]: async () => {
        await gate;
        return ok(
          {
            receipt: receiptDetail({
              category: "paper_scan",
              warnings: [
                { code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-06-30" } },
                { code: "NOT_FULL_COLOR" },
              ],
            }),
          },
          201,
        );
      },
    });
    renderCapture();
    const form = await fillAndSend("紙を撮影（原本は保存）");

    expect(await within(form).findByRole("button", { name: "送信中…" })).toBeDisabled();
    expect(screen.queryByText(/保存しました/)).not.toBeInTheDocument();

    release?.();
    const status = await screen.findByRole("status");
    expect(within(status).getByText(/保存しました/)).toBeInTheDocument();
    const warnings = within(status).getAllByRole("listitem");
    expect(warnings).toHaveLength(2);
    for (const item of warnings) expect(item).toHaveTextContent(NOTE);
    expect(within(status).getByRole("link", { name: "証憑を開く" })).toHaveAttribute(
      "href",
      `/e/e1/receipts/${RECEIPT_ID}`,
    );
  });

  it("通信が切れたときは、保存されていないことをはっきり示し、入力は残す", async () => {
    mockApi({});
    const stubbed = vi.fn(async () => {
      throw new TypeError("Load failed");
    });
    vi.stubGlobal("fetch", stubbed);
    renderCapture();
    const form = await fillAndSend();

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("通信できませんでした");
    expect(alert).toHaveTextContent("保存されていません");
    expect(screen.queryByText(/保存しました/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(within(form).getByText(/領収書\.jpg/)).toBeInTheDocument();
    expect(within(form).getByRole("radio", { name: "電子取引" })).toBeChecked();
    expect(within(form).getByRole("button", { name: "送信" })).toBeEnabled();
  });

  it("Mac が施錠中（401 LOCKED）は、保存されていないことと解錠が要ることを示す", async () => {
    mockApi({
      [`POST ${LIST}`]: () => apiError(401, "LOCKED", "帳簿は施錠されています"),
    });
    renderCapture();
    const form = await fillAndSend();

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("施錠");
    expect(alert).toHaveTextContent("保存されていません");
    expect(screen.queryByText(/保存しました/)).not.toBeInTheDocument();
  });

  it("5xx は、保存されていないことを示す", async () => {
    mockApi({
      [`POST ${LIST}`]: () => ({ status: 503, body: { message: "unavailable" } }),
    });
    renderCapture();
    const form = await fillAndSend();

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("サーバー");
    expect(alert).toHaveTextContent("保存されていません");
    expect(screen.queryByText(/保存しました/)).not.toBeInTheDocument();
  });

  it("409 RECEIPT_DUPLICATE は保存していないことを示し、既存の証憑へ案内する", async () => {
    mockApi({
      [`POST ${LIST}`]: () =>
        apiError(409, "RECEIPT_DUPLICATE", "同じ内容の証憑がすでにあります", {
          receiptId: RECEIPT_ID,
          deleted: false,
        }),
    });
    renderCapture();
    const form = await fillAndSend();

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("同じファイルがすでにあります。");
    expect(alert).toHaveTextContent("保存されていません");
    expect(within(form).getByRole("link", { name: "同じ内容の証憑を開く" })).toHaveAttribute(
      "href",
      `/e/e1/receipts/${RECEIPT_ID}`,
    );
  });
});

describe("事業体の一覧の入口", () => {
  beforeEach(() => {
    localStorage.clear();
    // 最初の表示の「前回の事業体を開く」を済ませた状態にする
    sessionStorage.setItem("trebuchet:lastEntityRestored", "1");
  });

  it("各事業体に「証憑を撮る」があり、撮影の画面へ進む", async () => {
    mockApi({
      "GET /api/entities": () =>
        ok({
          entities: [
            {
              id: "e1",
              name: "個人事業A",
              kind: "individual",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "e2",
              name: "株式会社B",
              kind: "corporation",
              createdAt: "2026-02-01T00:00:00.000Z",
            },
          ],
        }),
    });
    renderRoute(HomeRoute, { path: "/", url: "/" });

    const links = await screen.findAllByRole("link", { name: "証憑を撮る" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/e/e1/receipts/capture",
      "/e/e2/receipts/capture",
    ]);
  });
});
