import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RECEIPT_MAX_BYTES } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/receipts/index";
import { apiError, formFields, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, receiptDetail } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T017・T018: 証憑の追加（H: §2 の POST。FR-001〜006、FR-022、E1）。追加の入口は一覧の上の 1 つのフォームだけ。
// 端末のカメラは jsdom にないので、input の属性とファイルの選択で確かめる

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

const camera = (form: HTMLElement) => within(form).getByLabelText("写真を撮る");
const picker = (form: HTMLElement) => within(form).getByLabelText("ファイルを選ぶ");
const save = (form: HTMLElement) => within(form).getByRole("button", { name: "保存" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("入力の欄", () => {
  it("入力は ファイル と 区分 だけ。取引年月日・金額・取引先・メモの欄はない", async () => {
    mockApi(emptyList());
    renderList();
    const form = await openForm();

    for (const label of ["取引年月日", "金額", "取引先", "メモ"]) {
      expect(within(form).queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(within(form).getAllByRole("radio")).toHaveLength(2);
    expect(within(form).getByText(/詳細の画面で入力できます/)).toBeInTheDocument();
  });

  it("撮影は capture=environment の画像、選択は capture なしで JPEG・PNG・HEIC・PDF。追加の入口は 1 つ", async () => {
    mockApi(emptyList());
    renderList();
    const form = await openForm();

    expect(camera(form)).toHaveAttribute("type", "file");
    expect(camera(form)).toHaveAttribute("accept", "image/*");
    expect(camera(form)).toHaveAttribute("capture", "environment");

    expect(picker(form)).toHaveAttribute("type", "file");
    expect(picker(form)).not.toHaveAttribute("capture");
    const accept = picker(form).getAttribute("accept") ?? "";
    for (const type of ["image/jpeg", "image/png", "image/heic", "image/heif", "application/pdf"]) {
      expect(accept.split(",")).toContain(type);
    }
    expect(screen.getAllByRole("form", { name: /証憑を(追加|撮る)/ })).toHaveLength(1);
  });

  it("区分は表示名で選ぶ。それぞれを選ぶ理由を、選ぶ前から示す", async () => {
    mockApi(emptyList());
    renderList();
    const form = await openForm();

    const paper = within(form).getByRole("radio", { name: "紙を撮影（原本は保存）" });
    const electronic = within(form).getByRole("radio", { name: "電子取引" });
    expect(paper).toHaveAccessibleDescription(new RegExp(NOTE));
    expect(paper).toHaveAccessibleDescription(/解像度/);
    expect(paper).toHaveAccessibleDescription(/入力期限/);
    expect(electronic).toHaveAccessibleDescription(/メールやサイト/);
    expect(electronic).toHaveAccessibleDescription(/電子のまま保存すれば足ります/);
  });
});

describe("送る内容", () => {
  it("撮影でもファイルの選択でも、選んだファイルを送る。options は区分だけ（経路は送らない）", async () => {
    const calls = mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201),
    });
    renderList();
    const form = await openForm();
    const user = userEvent.setup();

    await user.upload(camera(form), jpeg("撮影.jpg", 2000));
    expect(within(form).getByText(/撮影\.jpg/)).toBeInTheDocument();
    await user.click(within(form).getByRole("radio", { name: "電子取引" }));
    await user.click(save(form));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const fields = formFields(calls.find((c) => c.method === "POST")?.form);
    expect(fields?.file).toMatchObject({ name: "撮影.jpg", size: 2000 });
    expect(JSON.parse(String(fields?.options))).toEqual({ category: "electronic" });
  });

  it("あとから選んだファイルに置き換わる", async () => {
    const calls = mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201),
    });
    renderList();
    const form = await openForm();
    const user = userEvent.setup();

    await user.upload(camera(form), jpeg("first.jpg"));
    await user.upload(picker(form), jpeg("second.jpg"));
    await user.click(within(form).getByRole("radio", { name: "電子取引" }));
    await user.click(save(form));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(formFields(calls.find((c) => c.method === "POST")?.form)?.file).toMatchObject({
      name: "second.jpg",
    });
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

    await user.upload(picker(form), jpeg("big.jpg", RECEIPT_MAX_BYTES + 1));
    await user.click(save(form));
    expect(
      await within(form).findByText("ファイルが大きすぎます（20 MB まで）。"),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await user.upload(picker(form), jpeg("ok.jpg", RECEIPT_MAX_BYTES));
    await user.click(save(form));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
  });

  it("ファイルか区分がなければ送らずに知らせる", async () => {
    const calls = mockApi(emptyList());
    renderList();
    const form = await openForm();

    await userEvent.click(save(form));
    expect(await within(form).findByText("ファイルを選んでください")).toBeInTheDocument();
    expect(within(form).getByText("区分を選んでください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

async function fillAndSave(category: "電子取引" | "紙を撮影（原本は保存）" = "電子取引") {
  const form = await openForm();
  await userEvent.upload(camera(form), jpeg());
  await userEvent.click(within(form).getByRole("radio", { name: category }));
  await userEvent.click(save(form));
  return form;
}

describe("保存の結果", () => {
  it("201 を受けるまでは保存したと表示しない。受けると結果・警告（注記つき）・詳細へのリンクを出し、一覧を読み直す", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listed = 0;
    mockApi({
      [`GET ${LIST}`]: () => {
        listed += 1;
        return ok({ receipts: [], nextCursor: null });
      },
      [`POST ${LIST}`]: async () => {
        await gate;
        return ok(
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
                { code: "FIELDS_MISSING" },
              ],
            }),
          },
          201,
        );
      },
    });
    renderList();
    const form = await fillAndSave("紙を撮影（原本は保存）");

    expect(await within(form).findByRole("button", { name: "保存中…" })).toBeDisabled();
    expect(screen.queryByText(/保存しました/)).not.toBeInTheDocument();

    release?.();
    const status = await screen.findByRole("status");
    expect(within(status).getByText(/保存しました/)).toBeInTheDocument();
    const warnings = within(status).getAllByRole("listitem");
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toHaveTextContent("2026-06-30");
    expect(warnings[1]).toHaveTextContent("800×600");
    for (const item of warnings.slice(0, 3)) expect(item).toHaveTextContent(NOTE);
    expect(within(status).getByText("未入力の項目があります")).toBeInTheDocument();
    expect(within(status).getByRole("link", { name: "証憑を開く" })).toHaveAttribute(
      "href",
      `/e/e1/receipts/${RECEIPT_ID}`,
    );
    await waitFor(() => expect(listed).toBeGreaterThan(1));
  });

  it("通信が切れたときは、保存されていないことをはっきり示し、入力は残す", async () => {
    mockApi(emptyList());
    const stubbed = vi.fn(async () => {
      throw new TypeError("Load failed");
    });
    vi.stubGlobal("fetch", stubbed);
    renderList();
    const form = await fillAndSave();

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("通信できませんでした");
    expect(alert).toHaveTextContent("保存されていません");
    expect(screen.queryByText(/保存しました/)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(within(form).getByText(/領収書\.jpg/)).toBeInTheDocument();
    expect(within(form).getByRole("radio", { name: "電子取引" })).toBeChecked();
    expect(save(form)).toBeEnabled();
  });

  it("Mac が施錠中（401 LOCKED）は、保存されていないことと解錠が要ることを示す", async () => {
    mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () => apiError(401, "LOCKED", "帳簿は施錠されています"),
    });
    renderList();
    const form = await fillAndSave();

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("施錠");
    expect(alert).toHaveTextContent("保存されていません");
    expect(screen.queryByText(/保存しました/)).not.toBeInTheDocument();
  });

  it("5xx は、保存されていないことを示す", async () => {
    mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () => ({ status: 503, body: { message: "unavailable" } }),
    });
    renderList();
    const form = await fillAndSave();

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("サーバー");
    expect(alert).toHaveTextContent("保存されていません");
    expect(screen.queryByText(/保存しました/)).not.toBeInTheDocument();
  });

  it("409 RECEIPT_DUPLICATE は保存していないことを示し、既存の証憑へ案内する。削除済みなら示す", async () => {
    mockApi({
      ...emptyList(),
      [`POST ${LIST}`]: () =>
        apiError(409, "RECEIPT_DUPLICATE", "同じ内容の証憑がすでにあります", {
          receiptId: RECEIPT_ID,
          deleted: true,
        }),
    });
    renderList();
    const form = await fillAndSave();

    const alert = await within(form).findByRole("alert");
    expect(alert).toHaveTextContent("同じファイルがすでにあります。");
    expect(alert).toHaveTextContent("削除済みの証憑です");
    expect(alert).toHaveTextContent("保存されていません");
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
    const form = await fillAndSave();
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "このファイルは扱えません。JPEG・PNG・HEIC・PDF のファイルを選んでください。",
    );
  });
});
