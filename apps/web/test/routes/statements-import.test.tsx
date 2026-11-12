import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as ImportRoute } from "@/routes/e/$entityId/statements/import";
import { assetAccount, ENTITY as BASE, uuid } from "../fixtures";
import { type ApiCall, apiError, formFields, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US1・007 US1: 明細の取込の画面（入力 → 列の対応 → 確認 → 確定。H:§2.1〜§2.3）

const SHA = "a".repeat(64);
const TEXT = "日付\t内容\t金額（円）\t保有金融機関\n05/10(日)\tショップ001\t-1,200\tサンプル銀行";

const BANK = assetAccount(1020, "普通預金");
const CASH = assetAccount(1010, "現金");

/** 日付・内容・金額（円）・保有金融機関のタブ区切り（見出しは先頭の行）の判定 */
const LAYOUT = {
  encoding: "utf-8",
  delimiter: "\t",
  headerRow: 0,
  header: ["日付", "内容", "金額（円）", "保有金融機関"],
  columnCount: 4,
  rowCount: 2,
  sampleRows: [
    ["05/10(日)", "ショップ001", "-1,200", "サンプル銀行"],
    ["05/11(月)", "売上入金", "3,000", "サンプル銀行"],
  ],
  needsYear: true,
  suggestedColumns: { date: 0, content: 1, amount: 2, accountName: 3 },
  match: { kind: "none" },
};

/** 取引日・摘要・出金額・入金額のカンマ区切り。口座名の列がなく、年は日付に含まれる */
const BANK_LAYOUT = {
  encoding: "shift_jis",
  delimiter: ",",
  headerRow: 2,
  header: ["取引日", "摘要", "出金額", "入金額"],
  columnCount: 4,
  rowCount: 2,
  sampleRows: [
    ["2026-05-10", "ショップ001", "1,200", ""],
    ["2026-05-11", "売上入金", "", "3,000"],
  ],
  needsYear: false,
  suggestedColumns: { date: 0, content: 1, outflow: 2, inflow: 3 },
  match: { kind: "none" },
};

const row = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  date: "2026-05-10",
  amount: -1200,
  content: "ショップ001",
  accountName: "サンプル銀行",
  status: "new",
  warnings: [],
  ...over,
});

const PREVIEW = {
  inputSha256: SHA,
  period: { from: "2026-05-10", to: "2026-05-11" },
  totals: { inflow: 3000, outflow: 2400 },
  rows: [
    row("k0"),
    row("k1", { date: "2026-05-10" }),
    row("k2", { date: "2026-05-11", amount: 3000, content: "売上入金" }),
  ],
  unreadable: [{ line: 5, reason: "列が足りません" }],
  unmappedAccounts: [] as { name: string; suggestion: Record<string, unknown> | null }[],
  countNew: 3,
};

const ACCOUNT_VIEW = (name: string, over: Record<string, unknown> = {}) => ({
  id: uuid(7000),
  name,
  usage: "business",
  kind: "bank",
  accountId: BANK.id,
  subAccountId: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  ...over,
});

const LAYOUT_PATH = `${BASE}/statements/imports/layout`;
const PREVIEW_PATH = `${BASE}/statements/imports/preview`;
const COMMIT_PATH = `${BASE}/statements/imports`;

const baseRoutes = {
  [`GET ${BASE}/accounts`]: () => ok({ accounts: [BANK, CASH] }),
  [`POST ${LAYOUT_PATH}`]: () => ok(LAYOUT),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+09:00"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderImport = () =>
  renderRoute(ImportRoute, {
    path: "/e/$entityId/statements/import",
    url: "/e/e1/statements/import",
  });

type User = ReturnType<typeof userEvent.setup>;

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === `${BASE}${path}`);

/** multipart の `options`（JSON 文字列）を読む */
const optionsOf = (call: ApiCall | undefined) =>
  JSON.parse(String(call?.form?.get("options") ?? "null")) as Record<string, unknown>;

/** multipart の `file` の中身 */
const fileTextOf = (call: ApiCall | undefined) =>
  new Promise<string>((resolve, reject) => {
    const file = call?.form?.get("file");
    if (!(file instanceof Blob)) return reject(new Error("file がありません"));
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

const mappingRegion = () => screen.findByRole("region", { name: "列の対応" });

/** 貼り付けて「読み取る」。列の対応の欄が出るまで待つ */
const readPaste = async (u: User, text = TEXT) => {
  fireEvent.change(await screen.findByLabelText("貼り付けのテキスト"), { target: { value: text } });
  await u.click(screen.getByRole("button", { name: "読み取る" }));
  return mappingRegion();
};

const chooseSign = (u: User, label = "正の値は入金") =>
  u.click(screen.getByRole("radio", { name: label }));

const confirmButton = () => screen.getByRole("button", { name: "確認へ" });

/** 貼り付け → 列の対応（案のまま。符号は入金が正）→ 確認へ → 確認の画面 */
const toPreview = async (u: User) => {
  await readPaste(u);
  await chooseSign(u);
  await u.click(confirmButton());
};

describe("入力と読み取り（US1-1。FR-001・002）", () => {
  it("貼り付けは UTF-8 のファイルにして、origin: paste で layout に送り、見出しと見本の表を示す", async () => {
    const all = mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);

    const layoutCall = calls(all, "POST", "/statements/imports/layout")[0];
    expect(formFields(layoutCall?.form)).toMatchObject({
      file: { type: "text/plain;charset=utf-8" },
    });
    expect(await fileTextOf(layoutCall)).toBe(TEXT);
    expect(optionsOf(layoutCall)).toEqual({ origin: "paste" });

    const table = within(region).getByRole("table", { name: "見本の表" });
    expect(within(table).getByRole("columnheader", { name: "保有金融機関" })).toBeInTheDocument();
    expect(within(table).getByText("ショップ001")).toBeInTheDocument();
    expect(within(table).getByText("売上入金")).toBeInTheDocument();
    // 案（suggestedColumns）が列の役割の初期値
    expect(within(region).getByLabelText("「日付」の役割")).toHaveValue("date");
    expect(within(region).getByLabelText("「内容」の役割")).toHaveValue("content");
    expect(within(region).getByLabelText("「金額（円）」の役割")).toHaveValue("amount");
    expect(within(region).getByLabelText("「保有金融機関」の役割")).toHaveValue("accountName");
  });

  it("ファイルを選ぶと、origin: file でそのファイルを layout に送る", async () => {
    const all = mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    await u.click(await screen.findByRole("radio", { name: "ファイル" }));
    expect(screen.queryByLabelText("貼り付けのテキスト")).not.toBeInTheDocument();
    const file = new File([TEXT], "bank.csv", { type: "text/csv" });
    await u.upload(screen.getByLabelText("明細のファイル"), file);
    await u.click(screen.getByRole("button", { name: "読み取る" }));
    await mappingRegion();

    const layoutCall = calls(all, "POST", "/statements/imports/layout")[0];
    expect(formFields(layoutCall?.form)).toMatchObject({
      file: { name: "bank.csv", type: "text/csv" },
    });
    expect(optionsOf(layoutCall)).toEqual({ origin: "file" });
  });

  it("テキストが空・ファイルが未選択なら送らずに知らせる", async () => {
    const all = mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    await u.click(await screen.findByRole("button", { name: "読み取る" }));
    expect(await screen.findByText("貼り付けのテキストを入力してください")).toBeInTheDocument();
    await u.click(screen.getByRole("radio", { name: "ファイル" }));
    await u.click(screen.getByRole("button", { name: "読み取る" }));
    expect(await screen.findByText("ファイルを選んでください")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/imports/layout")).toHaveLength(0);
  });

  it("読めない表（422）は、理由を示し、列の対応の欄を出さない", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () =>
        apiError(422, "STATEMENT_TABLE_UNREADABLE", "表を読めません", {
          missingColumns: [],
          unreadable: [],
        }),
    });
    const u = userEvent.setup();
    renderImport();
    fireEvent.change(await screen.findByLabelText("貼り付けのテキスト"), {
      target: { value: "x" },
    });
    await u.click(screen.getByRole("button", { name: "読み取る" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("表を読み取れませんでした");
    expect(screen.queryByRole("region", { name: "列の対応" })).not.toBeInTheDocument();
  });

  it("MF ME の文言を出さない", async () => {
    mockApi(baseRoutes);
    renderImport();
    await screen.findByLabelText("貼り付けのテキスト");
    expect(document.body.textContent).not.toMatch(/MF ?ME/i);
    expect(
      screen.getByText(/銀行・カードの明細の表を貼り付けるか、CSV のファイルを選びます/),
    ).toBeInTheDocument();
  });
});

describe("読み取りの選び直し（US1-1。区切り・見出しの行・文字コード）", () => {
  it("区切り・見出しの行（1 起点の表示 → 0 起点で送る）・文字コードを選び直すと、layout をやり直す", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: (call) =>
        ok(optionsOf(call).delimiter === undefined ? LAYOUT : BANK_LAYOUT),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);

    expect(within(region).getByLabelText("区切り文字")).toHaveValue("\t");
    expect(within(region).getByLabelText("見出しの行")).toHaveValue(1);
    expect(within(region).getByLabelText("文字コード")).toHaveValue("");

    await u.selectOptions(within(region).getByLabelText("区切り文字"), "カンマ");
    fireEvent.change(within(region).getByLabelText("見出しの行"), { target: { value: "3" } });
    await u.selectOptions(within(region).getByLabelText("文字コード"), "CP932（shift_jis）");
    await u.click(within(region).getByRole("button", { name: "読み直す" }));

    await waitFor(() => expect(calls(all, "POST", "/statements/imports/layout")).toHaveLength(2));
    expect(optionsOf(calls(all, "POST", "/statements/imports/layout")[1])).toEqual({
      origin: "paste",
      encoding: "shift_jis",
      delimiter: ",",
      headerRow: 2,
    });
    // 新しい判定の列に置き換わり、案から役割が入る
    expect(await screen.findByLabelText("「摘要」の役割")).toHaveValue("content");
    // 文字コードは選び直した値のまま
    expect(screen.getByLabelText("文字コード")).toHaveValue("shift_jis");
  });

  it("見出しの行を空にすると「見出しなし」で読み直し、列は「列 1」「列 2」…と呼ぶ", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: (call) =>
        ok(
          optionsOf(call).headerRow === null
            ? {
                ...LAYOUT,
                headerRow: null,
                header: null,
                columnCount: 3,
                sampleRows: [["2026-05-10", "ショップ001", "-1,200"]],
                suggestedColumns: {},
              }
            : LAYOUT,
        ),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    fireEvent.change(within(region).getByLabelText("見出しの行"), { target: { value: "" } });
    await u.click(within(region).getByRole("button", { name: "読み直す" }));

    expect(await screen.findByLabelText("「列 1」の役割")).toHaveValue("");
    expect(screen.getByLabelText("「列 2」の役割")).toBeInTheDocument();
    expect(screen.getByLabelText("「列 3」の役割")).toBeInTheDocument();
    expect(screen.getByLabelText("見出しの行")).toHaveValue(null);
    expect(optionsOf(calls(all, "POST", "/statements/imports/layout")[1])).toMatchObject({
      headerRow: null,
    });
  });
});

describe("列の対応（US1-2・3・4・5。FR-003〜007）", () => {
  it("日付・内容・金額がそろわない、金額の符号を選んでいない間は、理由を示して確認へ進めない", async () => {
    mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);

    // 案は入っているが、金額 1 列の符号は必ず選ぶ
    expect(confirmButton()).toBeDisabled();
    expect(within(region).getByRole("list", { name: "確認へ進めない理由" })).toHaveTextContent(
      "金額の符号（正の値が入金か出金か）を選んでください",
    );
    await chooseSign(u, "正の値は出金");
    expect(confirmButton()).toBeEnabled();
    expect(
      within(region).queryByRole("list", { name: "確認へ進めない理由" }),
    ).not.toBeInTheDocument();

    await u.selectOptions(within(region).getByLabelText("「内容」の役割"), "使わない");
    expect(confirmButton()).toBeDisabled();
    expect(within(region).getByRole("list", { name: "確認へ進めない理由" })).toHaveTextContent(
      "「内容」の列を選んでください",
    );
  });

  it("見出しから決まる符号の案（suggestedAmountSign。カードのご利用額）を、符号の初期値にする", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () =>
        ok({
          ...LAYOUT,
          header: ["日付", "内容", "ご利用額", "保有金融機関"],
          suggestedAmountSign: "outflow_positive",
        }),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);

    expect(within(region).getByRole("radio", { name: "正の値は出金" })).toBeChecked();
    expect(within(region).getByRole("radio", { name: "正の値は入金" })).not.toBeChecked();
    // 案は変えられる。選び直しても確認へ進める
    expect(confirmButton()).toBeEnabled();
    await chooseSign(u, "正の値は入金");
    expect(within(region).getByRole("radio", { name: "正の値は入金" })).toBeChecked();
  });

  it("符号の案がなければ、符号は選ばれていない（利用者が選ぶ）", async () => {
    mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    expect(within(region).getByRole("radio", { name: "正の値は出金" })).not.toBeChecked();
    expect(within(region).getByRole("radio", { name: "正の値は入金" })).not.toBeChecked();
  });

  it("同じ役割を 2 つの列に選ぶと、確認へ進めない", async () => {
    mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    await chooseSign(u);
    expect(confirmButton()).toBeEnabled();

    await u.selectOptions(within(region).getByLabelText("「内容」の役割"), "日付");
    expect(confirmButton()).toBeDisabled();
    expect(within(region).getByRole("list", { name: "確認へ進めない理由" })).toHaveTextContent(
      "「日付」が複数の列に選ばれています",
    );
  });

  it("金額が 1 列のときは、選んだ符号の向きを mapping に入れて preview に送る", async () => {
    const all = mockApi({ ...baseRoutes, [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW) });
    const u = userEvent.setup();
    renderImport();
    await readPaste(u);
    await chooseSign(u, "正の値は出金");
    await u.click(confirmButton());
    await screen.findByRole("region", { name: "プレビューの要約" });

    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0])).toEqual({
      origin: "paste",
      year: 2026,
      encoding: "utf-8",
      mapping: {
        delimiter: "\t",
        headerRow: 0,
        columns: { date: 0, content: 1, amount: 2, accountName: 3 },
        amountSign: "outflow_positive",
      },
    });
    // 同じ入力（貼り付けのファイル）を送る
    expect(await fileTextOf(calls(all, "POST", "/statements/imports/preview")[0])).toBe(TEXT);
  });

  it("出金・入金の 2 列は、符号を聞かず、出金・入金の列を mapping に入れる。年が要らなければ年の欄を出さない", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () => ok(BANK_LAYOUT),
      [`GET ${BASE}/statement-accounts`]: () => ok({ accounts: [ACCOUNT_VIEW("事業用の口座")] }),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);

    expect(within(region).getByRole("radio", { name: "出金・入金の 2 列" })).toBeChecked();
    expect(within(region).queryByRole("radio", { name: "正の値は入金" })).not.toBeInTheDocument();
    expect(within(region).queryByLabelText("対象の年")).not.toBeInTheDocument();
    expect(within(region).getByLabelText("「出金額」の役割")).toHaveValue("outflow");
    expect(within(region).getByLabelText("「入金額」の役割")).toHaveValue("inflow");

    await u.selectOptions(await within(region).findByLabelText("取込の口座"), "事業用の口座");
    await u.click(confirmButton());
    await screen.findByRole("region", { name: "プレビューの要約" });

    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0])).toEqual({
      origin: "paste",
      year: 2026,
      encoding: "shift_jis",
      fixedAccountName: "事業用の口座",
      mapping: {
        delimiter: ",",
        headerRow: 2,
        columns: { date: 0, content: 1, outflow: 2, inflow: 3 },
      },
    });
  });

  it("金額の列の数を切り替えると、使えない役割の選択を外す", async () => {
    mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    await u.click(within(region).getByRole("radio", { name: "出金・入金の 2 列" }));

    expect(within(region).getByLabelText("「金額（円）」の役割")).toHaveValue("");
    expect(confirmButton()).toBeDisabled();
    expect(within(region).getByRole("list", { name: "確認へ進めない理由" })).toHaveTextContent(
      "「出金」と「入金」の列を選んでください",
    );
    await u.selectOptions(within(region).getByLabelText("「金額（円）」の役割"), "出金");
    expect(within(region).getByRole("list", { name: "確認へ進めない理由" })).toHaveTextContent(
      "「入金」の列を選んでください",
    );
  });

  it("年のない日付（needsYear）のときだけ年を聞く。既定は今年で、変えるとその年を送る", async () => {
    const all = mockApi({ ...baseRoutes, [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW) });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    expect(within(region).getByLabelText("対象の年")).toHaveValue(2026);
    fireEvent.change(within(region).getByLabelText("対象の年"), { target: { value: "2025" } });
    await chooseSign(u);
    await u.click(confirmButton());
    await screen.findByRole("region", { name: "プレビューの要約" });
    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0])).toMatchObject({
      year: 2025,
    });
  });

  it("年が不正なら確認へ進めない", async () => {
    mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    await chooseSign(u);
    fireEvent.change(within(region).getByLabelText("対象の年"), { target: { value: "20" } });
    expect(confirmButton()).toBeDisabled();
    expect(within(region).getByRole("list", { name: "確認へ進めない理由" })).toHaveTextContent(
      "対象の年を 4 桁で入力してください",
    );
  });

  it("口座名の列がなければ、既存の口座を選ぶか新しい名前を入れる。どちらもなければ確認へ進めない", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () => ok(BANK_LAYOUT),
      [`GET ${BASE}/statement-accounts`]: () => ok({ accounts: [ACCOUNT_VIEW("事業用の口座")] }),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);

    expect(confirmButton()).toBeDisabled();
    expect(within(region).getByRole("list", { name: "確認へ進めない理由" })).toHaveTextContent(
      "取込の口座を選ぶか、新しい口座の名前を入れてください",
    );
    const select = await within(region).findByLabelText("取込の口座");
    await u.selectOptions(select, "新しい名前を入れる");
    expect(confirmButton()).toBeDisabled();
    await u.type(within(region).getByLabelText("口座の名前"), "  新しいカード ");
    expect(confirmButton()).toBeEnabled();
    await u.click(confirmButton());
    await screen.findByRole("region", { name: "プレビューの要約" });
    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0])).toMatchObject({
      fixedAccountName: "新しいカード",
    });
  });

  it("口座名の列を選ぶと、口座の選択を出さず、fixedAccountName を送らない", async () => {
    const all = mockApi({ ...baseRoutes, [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW) });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    expect(within(region).queryByLabelText("取込の口座")).not.toBeInTheDocument();
    await chooseSign(u);
    await u.click(confirmButton());
    await screen.findByRole("region", { name: "プレビューの要約" });
    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0])).not.toHaveProperty(
      "fixedAccountName",
    );
  });
});

describe("プレビュー（FR-004〜006）", () => {
  it("件数・期間・合計・読めない行・明細の一覧を示す", async () => {
    mockApi({ ...baseRoutes, [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW) });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);

    const summary = await screen.findByRole("region", { name: "プレビューの要約" });
    expect(within(summary).getByText("2026-05-10 〜 2026-05-11")).toBeInTheDocument();
    expect(within(summary).getByText("新規").nextSibling).toHaveTextContent("3件");
    expect(within(summary).getByText("入金の合計").nextSibling).toHaveTextContent("3,000円");
    expect(within(summary).getByText("出金の合計").nextSibling).toHaveTextContent("2,400円");

    const unreadable = screen.getByRole("list", { name: "読めない行の一覧" });
    expect(within(unreadable).getByText("5 行目: 列が足りません")).toBeInTheDocument();

    const table = screen.getByRole("table", { name: "取り込む明細の一覧" });
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 3);
    expect(within(table).getByText("売上入金")).toBeInTheDocument();
  });

  it("読めない表（422）は、理由を示し、列の対応の欄は残る", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () =>
        apiError(422, "STATEMENT_TABLE_UNREADABLE", "必須の列が足りません", {
          missingColumns: ["金額（円）"],
          unreadable: [],
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("表を読み取れませんでした");
    expect(alert).toHaveTextContent("見つからない列: 金額（円）");
    expect(screen.queryByRole("region", { name: "プレビューの要約" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "列の対応" })).toBeInTheDocument();
  });

  it("重複の疑いと、変更ありの行（変更前後）を別に示す", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () =>
        ok({
          ...PREVIEW,
          rows: [
            row("k0", { warnings: ["POSSIBLE_DUPLICATE"], content: "ショップ002" }),
            row("k1", {
              status: "changed",
              content: "サンプル商店",
              changed: {
                before: { amount: -1200, memo: "最初のメモ", content: "サンプル商店" },
                after: { amount: -1500, memo: "直したメモ", content: "サンプル商店" },
              },
            }),
            row("k2", { status: "existing" }),
          ],
          countNew: 1,
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);

    const dup = await screen.findByRole("list", { name: "重複の疑いの一覧" });
    expect(within(dup).getAllByRole("listitem")).toHaveLength(1);
    expect(dup).toHaveTextContent("ショップ002");

    const changed = screen.getByRole("list", { name: "変更ありの行の一覧" });
    expect(changed).toHaveTextContent("サンプル商店");
    expect(changed).toHaveTextContent("金額: -1,200 → -1,500");
    expect(changed).toHaveTextContent("メモ: 最初のメモ → 直したメモ");
    expect(changed).not.toHaveTextContent("内容:"); // 変わっていない項目は出さない

    const summary = screen.getByRole("region", { name: "プレビューの要約" });
    expect(within(summary).getByText("取込済み").nextSibling).toHaveTextContent("1件");
    expect(within(summary).getByText("変更あり").nextSibling).toHaveTextContent("1件");
  });
});

describe("口座の対応（FR-003）", () => {
  const withUnmapped = {
    ...PREVIEW,
    unmappedAccounts: [{ name: "サンプル銀行", suggestion: null }],
  };

  const COMMITTED_BODY = {
    batch: {
      id: uuid(1),
      origin: "paste",
      sourceName: null,
      inputSha256: SHA,
      periodFrom: "2026-05-10",
      periodTo: "2026-05-11",
      countNew: 3,
      countExisting: 0,
      countUnreadable: 1,
      createdAt: "2026-10-26T01:00:00.000Z",
    },
    added: 3,
    changed: 0,
  };
  const suggestion = (over: Record<string, unknown> = {}) => ({
    kind: "bank",
    accountId: BANK.id,
    subAccountId: null,
    usage: null,
    cues: ["銀行"],
    ...over,
  });
  const withSuggestion = (name: string, over: Record<string, unknown> = {}) => ({
    ...PREVIEW,
    unmappedAccounts: [{ name, suggestion: suggestion(over) }],
  });
  const importButton = () => screen.getByRole("button", { name: "取り込む" });

  it("案のない口座はすべて未選択で始まり、取り込めない（理由を示す）。選ぶと取り込め、確定の accounts で送る（PUT も preview のやり直しもしない）", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(withUnmapped),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMITTED_BODY, 201),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);

    const group = await screen.findByRole("group", { name: "サンプル銀行の対応" });
    expect(within(group).getByLabelText("サンプル銀行の用途")).toHaveValue("");
    expect(within(group).getByLabelText("サンプル銀行の種類")).toHaveValue("");
    expect(within(group).getByLabelText("サンプル銀行の科目")).toHaveValue("");
    expect(within(group).queryByText(/推定/)).not.toBeInTheDocument();
    expect(importButton()).toBeDisabled();
    expect(
      screen.getByText("用途・種類・科目を選んでいない口座があります: サンプル銀行"),
    ).toBeInTheDocument();

    await u.selectOptions(within(group).getByLabelText("サンプル銀行の用途"), "事業用");
    await u.selectOptions(within(group).getByLabelText("サンプル銀行の種類"), "銀行");
    expect(importButton()).toBeDisabled();
    await u.selectOptions(within(group).getByLabelText("サンプル銀行の科目"), "普通預金");
    expect(importButton()).toBeEnabled();
    await u.click(importButton());

    expect(await screen.findByText("3 件を取り込みました。")).toBeInTheDocument();
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0]).accounts).toEqual([
      { name: "サンプル銀行", input: { usage: "business", kind: "bank", accountId: BANK.id } },
    ]);
    expect(all.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(1);
  });

  it("案のある口座は、種類・科目を初期値に入れ、推定であることと手がかりを示す。用途は未選択で、選ぶまで取り込めない", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () =>
        ok(withSuggestion("サンプルカード", { kind: "card", cues: ["カード"] })),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMITTED_BODY, 201),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);

    const group = await screen.findByRole("group", { name: "サンプルカードの対応" });
    expect(within(group).getByText("推定: カード（手がかり: カード）")).toBeInTheDocument();
    expect(within(group).getByLabelText("サンプルカードの用途")).toHaveValue("");
    await waitFor(() =>
      expect(within(group).getByLabelText("サンプルカードの種類")).toHaveValue("card"),
    );
    expect(within(group).getByLabelText("サンプルカードの科目")).toHaveValue(BANK.id);
    expect(importButton()).toBeDisabled();

    await u.selectOptions(within(group).getByLabelText("サンプルカードの用途"), "事業用");
    expect(importButton()).toBeEnabled();
    await u.click(importButton());
    await screen.findByText("3 件を取り込みました。");
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0]).accounts).toEqual([
      { name: "サンプルカード", input: { usage: "business", kind: "card", accountId: BANK.id } },
    ]);
  });

  it("大項目の手がかりと補助科目の案を、そのまま初期値と手がかりにする", async () => {
    const SUB = { id: uuid(9001), accountId: BANK.id, name: "メイン口座", isActive: true };
    const all = mockApi({
      ...baseRoutes,
      [`GET ${BASE}/accounts/${BANK.id}/sub-accounts`]: () => ok({ subAccounts: [SUB] }),
      [`POST ${PREVIEW_PATH}`]: () =>
        ok(
          withSuggestion("サンプル銀行", {
            subAccountId: SUB.id,
            usage: "business",
            cues: ["銀行", "大項目: 預金"],
          }),
        ),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMITTED_BODY, 201),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);

    const group = await screen.findByRole("group", { name: "サンプル銀行の対応" });
    expect(
      within(group).getByText("推定: 銀行（手がかり: 銀行、大項目: 預金）"),
    ).toBeInTheDocument();
    // 用途の案があれば、用途も初期値に入る。補助科目は選択肢が読めたら選ばれる
    expect(within(group).getByLabelText("サンプル銀行の用途")).toHaveValue("business");
    await waitFor(() =>
      expect(within(group).getByLabelText("サンプル銀行の補助科目")).toHaveValue(SUB.id),
    );
    await u.click(importButton());
    await screen.findByText("3 件を取り込みました。");
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0]).accounts).toEqual([
      {
        name: "サンプル銀行",
        input: { usage: "business", kind: "bank", accountId: BANK.id, subAccountId: SUB.id },
      },
    ]);
  });

  it("private は科目を出さず、案に科目があっても外して（科目・補助科目なしで）送る", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () =>
        ok(withSuggestion("サンプル銀行", { kind: "cash", accountId: CASH.id, usage: "private" })),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMITTED_BODY, 201),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    const group = await screen.findByRole("group", { name: "サンプル銀行の対応" });
    expect(within(group).queryByLabelText("サンプル銀行の科目")).not.toBeInTheDocument();
    expect(within(group).queryByLabelText("サンプル銀行の補助科目")).not.toBeInTheDocument();
    expect(importButton()).toBeEnabled();
    await u.click(importButton());
    await screen.findByText("3 件を取り込みました。");
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0]).accounts).toEqual([
      { name: "サンプル銀行", input: { usage: "private", kind: "cash" } },
    ]);
  });

  it("事業用で科目が未選択の口座が 1 つでもあれば、取り込めない（ほかの口座がそろっていても）", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () =>
        ok({
          ...PREVIEW,
          unmappedAccounts: [
            { name: "口座A", suggestion: suggestion({ usage: "business" }) },
            { name: "口座B", suggestion: null },
          ],
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    const a = await screen.findByRole("group", { name: "口座Aの対応" });
    const b = await screen.findByRole("group", { name: "口座Bの対応" });
    expect(importButton()).toBeDisabled();
    expect(screen.getByText(/口座B/, { selector: "p" })).toBeInTheDocument();

    await u.selectOptions(within(b).getByLabelText("口座Bの用途"), "事業用");
    await u.selectOptions(within(b).getByLabelText("口座Bの種類"), "現金");
    expect(importButton()).toBeDisabled();
    await u.selectOptions(within(b).getByLabelText("口座Bの科目"), "現金");
    expect(importButton()).toBeEnabled();

    // 科目を外すと、また取り込めない
    await u.selectOptions(within(a).getByLabelText("口座Aの科目"), "選んでください");
    expect(importButton()).toBeDisabled();
  });

  it("口座の対応を変えても preview はやり直さない。確定の違反（422 / 400）は既存のエラー表示で出す", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(withSuggestion("サンプル銀行", { usage: "business" })),
      [`POST ${COMMIT_PATH}`]: () =>
        apiError(400, "VALIDATION", "対応づいていない口座だけを指定してください", {
          names: ["サンプル銀行"],
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    const group = await screen.findByRole("group", { name: "サンプル銀行の対応" });
    await u.selectOptions(within(group).getByLabelText("サンプル銀行の種類"), "現金");
    expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(1);
    await u.click(importButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "対応づいていない口座だけを指定してください",
    );
    // 入力は残る（直して確定し直せる）
    expect(screen.getByRole("group", { name: "サンプル銀行の対応" })).toBeInTheDocument();
  });
});

describe("取込の確定（FR-007）", () => {
  const COMMITTED = (added: number, changed = 0) => ({
    batch: {
      id: uuid(1),
      origin: "paste",
      sourceName: null,
      inputSha256: SHA,
      periodFrom: "2026-05-10",
      periodTo: "2026-05-11",
      countNew: 3,
      countExisting: 0,
      countUnreadable: 1,
      createdAt: "2026-10-26T01:00:00.000Z",
    },
    added,
    changed,
  });

  it("同じファイルと指定に、プレビューのハッシュと新規の件数を添えて確定し、件数を知らせて、プレビューを閉じる", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMITTED(3), 201),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    await u.click(await screen.findByRole("button", { name: "取り込む" }));

    expect(await screen.findByText("3 件を取り込みました。")).toBeInTheDocument();
    const commit = calls(all, "POST", "/statements/imports")[0];
    expect(optionsOf(commit)).toEqual({
      ...optionsOf(calls(all, "POST", "/statements/imports/preview")[0]),
      expected: { inputSha256: SHA, countNew: 3 },
      accounts: [],
      saveSource: null,
    });
    expect(await fileTextOf(commit)).toBe(TEXT);
    expect(screen.queryByRole("region", { name: "プレビューの要約" })).not.toBeInTheDocument();
    // 取り込んだ後は入力から始め直せる
    expect(screen.queryByRole("region", { name: "列の対応" })).not.toBeInTheDocument();
  });

  it("変更ありがあれば件数に添える", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMITTED(2, 1), 201),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    expect(await screen.findByText("2 件を取り込みました（変更あり 1 件）。")).toBeInTheDocument();
  });

  it("新規 0 件のときは取り込めない（取込済みのみ）", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () =>
        ok({ ...PREVIEW, countNew: 0, rows: [row("k0", { status: "existing" })] }),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    expect(await screen.findByRole("button", { name: "取り込む" })).toBeDisabled();
    expect(screen.getByText("新しく取り込む明細はありません。")).toBeInTheDocument();
  });

  it("409 STATEMENT_PLAN_CHANGED は知らせて、プレビューを作り直す", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () =>
        apiError(409, "STATEMENT_PLAN_CHANGED", "プレビューのときと内容が違います"),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    await u.click(await screen.findByRole("button", { name: "取り込む" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("プレビューを作り直しました");
    await waitFor(() => expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(2));
  });

  it("422 STATEMENT_ACCOUNT_UNMAPPED は口座の名前を示す", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () =>
        apiError(422, "STATEMENT_ACCOUNT_UNMAPPED", "対応づいていない口座があります", {
          names: ["サンプル銀行"],
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("サンプル銀行");
  });
});

describe("取込の手順と、取込の後の自動の連鎖（011 US3。FR-019・020）", () => {
  const COMMITTED = {
    batch: {
      id: uuid(1),
      origin: "paste",
      sourceName: null,
      inputSha256: SHA,
      periodFrom: "2026-05-10",
      periodTo: "2026-05-11",
      countNew: 3,
      countExisting: 0,
      countUnreadable: 1,
      createdAt: "2026-10-26T01:00:00.000Z",
    },
    added: 3,
    changed: 0,
  };
  const AI = {
    localEnabled: true,
    localAvailable: true,
    externalEnabled: false,
    externalBaseUrl: null,
    externalModel: null,
    receiptImagesEnabled: false,
    apiKeySet: false,
  };
  /** AI の設定が無効（端末内も外部も使わない） */
  const AI_OFF = { ...AI, localEnabled: false, localAvailable: false };
  const AI_EXTERNAL_ONLY = { ...AI, localEnabled: false, externalEnabled: true };

  const SEED_PATH = `${BASE}/inference-rules/seed`;
  const CANDIDATES_PATH = `${BASE}/statements/candidates`;
  const INFER_PATH = `${BASE}/statements/infer`;
  const ids = (count: number) => Array.from({ length: count }, (_, i) => uuid(100 + i));
  const inferred = (call: ApiCall) =>
    ok({
      results: (call.body as { statementIds: string[] }).statementIds.map((statementId) => ({
        statementId,
        method: "local_ai",
        confidence: 80,
      })),
      localAvailable: true,
      externalUsed: false,
    });

  const open = (extra: Record<string, Parameters<typeof mockApi>[0][string]> = {}) =>
    mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMITTED, 201),
      ...extra,
    });

  /** 貼り付け → 列の対応 → 確認 → 「取り込む」 */
  const commit = async (u: User) => {
    await toPreview(u);
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
  };

  /** 確定の後に呼んだ連鎖の API（呼んだ順） */
  const chain = (all: ApiCall[]) =>
    all
      .filter((c) => c.method === "POST")
      .map((c) => c.path.replace(BASE, ""))
      .filter((p) =>
        ["/inference-rules/seed", "/statements/candidates", "/statements/infer"].includes(p),
      );

  const currentStep = () =>
    within(screen.getByRole("list", { name: "取込の手順" }))
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("aria-current") === "step");

  const reviewRegion = () => screen.findByRole("region", { name: "明細の確認" });

  it("手順は ①入力 → ②列と口座 → ③取込 → ④確認・承認。今の手順に印を付け、取り込んだら ④ に進む", async () => {
    open();
    const u = userEvent.setup();
    renderImport();

    const list = await screen.findByRole("list", { name: "取込の手順" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["① 入力", "② 列と口座", "③ 取込", "④ 確認・承認"]);
    expect(currentStep()).toHaveTextContent("入力");

    await readPaste(u);
    expect(currentStep()).toHaveTextContent("列と口座");
    await chooseSign(u);
    await u.click(confirmButton());
    await screen.findByRole("button", { name: "取り込む" });
    expect(currentStep()).toHaveTextContent("取込");

    await u.click(screen.getByRole("button", { name: "取り込む" }));
    await reviewRegion();
    expect(currentStep()).toHaveTextContent("確認・承認");
    expect(await screen.findByText("3 件を取り込みました。")).toBeInTheDocument();
  });

  it("取込の確定の後、ルールの作成 → 候補の作成 → AI の推定の順に呼び、AI に回す明細の ID を送る（AI の設定が有効）", async () => {
    const needsAi = ids(2);
    const all = open({
      [`POST ${CANDIDATES_PATH}`]: () => ok({ built: 3, needsAi }),
      [`POST ${INFER_PATH}`]: inferred,
    });
    const u = userEvent.setup();
    renderImport();
    await commit(u);
    await reviewRegion();

    // 確定が先、そのあとに連鎖
    const posts = all.filter((c) => c.method === "POST").map((c) => c.path.replace(BASE, ""));
    expect(posts.slice(posts.indexOf("/statements/imports") + 1)).toEqual([
      "/inference-rules/seed",
      "/statements/candidates",
      "/statements/infer",
    ]);
    expect(calls(all, "POST", "/inference-rules/seed")[0]?.body).toEqual({});
    expect(calls(all, "POST", "/statements/candidates")[0]?.body).toEqual({});
    expect(calls(all, "POST", "/statements/infer")[0]?.body).toEqual({ statementIds: needsAi });
    // 取込のたびに進みを出す
    const progress = screen.getByRole("status", { name: "候補の作成の進み" });
    expect(progress).toHaveTextContent("候補を 3 件作りました");
    expect(progress).toHaveTextContent("AI で推定 2 / 2 件");
  });

  it("推定で外部の AI へ送ったとき、④ の進みの近くに表示を出し、終わった後も残す", async () => {
    const needsAi = ids(2);
    open({
      [`POST ${CANDIDATES_PATH}`]: () => ok({ built: 3, needsAi }),
      [`POST ${INFER_PATH}`]: (call) =>
        ok({
          results: (call.body as { statementIds: string[] }).statementIds.map((statementId) => ({
            statementId,
            method: "external_ai",
            confidence: 80,
          })),
          localAvailable: false,
          externalUsed: true,
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await commit(u);
    await reviewRegion();

    const progress = await screen.findByRole("status", { name: "候補の作成の進み" });
    expect(progress).toHaveTextContent("AI で推定 2 / 2 件");
    expect(
      within(progress).getByText(
        "外部の AI へ内容を送りました（確信度がしきい値に届かなかった明細だけ）。",
        { exact: true },
      ),
    ).toBeInTheDocument();
    expect(
      within(progress).getByText("端末内の AI が使えません。設定を確かめてください。", {
        exact: true,
      }),
    ).toBeInTheDocument();
  });

  it("端末内の AI がなく、外部の AI だけが有効でも推定を呼ぶ", async () => {
    const all = open({
      "GET /api/settings/ai": () => ok(AI_EXTERNAL_ONLY),
      [`POST ${CANDIDATES_PATH}`]: () => ok({ built: 1, needsAi: ids(1) }),
      [`POST ${INFER_PATH}`]: inferred,
    });
    const u = userEvent.setup();
    renderImport();
    await commit(u);
    await reviewRegion();
    expect(chain(all)).toEqual([
      "/inference-rules/seed",
      "/statements/candidates",
      "/statements/infer",
    ]);
  });

  it("AI の設定が無効なら、推定を飛ばす（AI に回す明細があっても呼ばない）。進みにもそう出す", async () => {
    const all = open({
      "GET /api/settings/ai": () => ok(AI_OFF),
      [`POST ${CANDIDATES_PATH}`]: () => ok({ built: 1, needsAi: ids(2) }),
    });
    const u = userEvent.setup();
    renderImport();
    await commit(u);
    await reviewRegion();

    expect(chain(all)).toEqual(["/inference-rules/seed", "/statements/candidates"]);
    expect(screen.getByRole("status", { name: "候補の作成の進み" })).toHaveTextContent(
      "AI の設定が無効なので、推定は飛ばしました",
    );
    expect(currentStep()).toHaveTextContent("確認・承認");
  });

  it("AI に回す明細がなければ（既定の応答）、AI の設定が有効でも推定を呼ばない", async () => {
    const all = open();
    const u = userEvent.setup();
    renderImport();
    await commit(u);
    await reviewRegion();
    expect(chain(all)).toEqual(["/inference-rules/seed", "/statements/candidates"]);
  });

  it("AI に回す明細は 10 件ずつ送る", async () => {
    const needsAi = ids(25);
    const all = open({
      [`POST ${CANDIDATES_PATH}`]: () => ok({ built: 25, needsAi }),
      [`POST ${INFER_PATH}`]: inferred,
    });
    const u = userEvent.setup();
    renderImport();
    await commit(u);
    await reviewRegion();
    expect(
      calls(all, "POST", "/statements/infer").map(
        (c) => (c.body as { statementIds: string[] }).statementIds,
      ),
    ).toEqual([needsAi.slice(0, 10), needsAi.slice(10, 20), needsAi.slice(20)]);
    expect(screen.getByRole("status", { name: "候補の作成の進み" })).toHaveTextContent(
      "AI で推定 25 / 25 件",
    );
  });

  it("AI の失敗は知らせて、確認へ進む（済んだ分は残る）", async () => {
    const needsAi = ids(15);
    let n = 0;
    const all = open({
      [`POST ${CANDIDATES_PATH}`]: () => ok({ built: 15, needsAi }),
      [`POST ${INFER_PATH}`]: (call) => {
        n += 1;
        return n === 1 ? inferred(call) : apiError(422, "AI_NOT_CONFIGURED", "AI に接続できません");
      },
    });
    const u = userEvent.setup();
    renderImport();
    await commit(u);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("AI の推定に失敗しました");
    expect(alert).toHaveTextContent("AI に接続できません");
    await reviewRegion();
    expect(currentStep()).toHaveTextContent("確認・承認");
    expect(calls(all, "POST", "/statements/infer")).toHaveLength(2);
    expect(screen.getByRole("status", { name: "候補の作成の進み" })).toHaveTextContent(
      "AI で推定 10 / 15 件で止まりました",
    );
  });

  it("ルールの作成が失敗しても、知らせて候補の作成へ進む", async () => {
    const all = open({
      [`POST ${SEED_PATH}`]: () => apiError(422, "AI_NOT_CONFIGURED", "ルールを作れません"),
    });
    const u = userEvent.setup();
    renderImport();
    await commit(u);

    expect(await screen.findByRole("alert")).toHaveTextContent("ルールを作れません");
    await reviewRegion();
    expect(chain(all)).toEqual(["/inference-rules/seed", "/statements/candidates"]);
  });

  it("取込の確定が失敗したときは、連鎖を始めない", async () => {
    const all = open({
      [`POST ${COMMIT_PATH}`]: () =>
        apiError(409, "STATEMENT_PLAN_CHANGED", "プレビューのときと内容が違います"),
    });
    const u = userEvent.setup();
    renderImport();
    await commit(u);
    await screen.findByRole("alert");
    expect(chain(all)).toEqual([]);
    expect(screen.queryByRole("region", { name: "明細の確認" })).not.toBeInTheDocument();
    expect(currentStep()).toHaveTextContent("取込");
  });

  const OPEN_STATEMENT = {
    id: uuid(300),
    date: "2026-05-10",
    amount: -1200,
    content: "ショップ001",
    accountName: "サンプル銀行",
    usage: "business",
    status: "unprocessed",
    changed: null,
    candidate: {
      method: "rule",
      purpose: "business",
      confidence: 90,
      reason: "ルール",
      draft: {
        date: "2026-05-10",
        lines: [
          { side: "debit", accountId: uuid(6010), amount: 1200, taxCategory: "PURCHASE_10" },
          { side: "credit", accountId: uuid(1020), amount: 1200, taxCategory: "OUT_OF_SCOPE" },
        ],
      },
    },
    links: [],
  };

  it("確認（④）では、未処理の明細を一覧で出し、行を選んで承認・除外する（ReviewTable）。主な操作は ③ までは「取り込む」、④ では「選択した N 件を承認」", async () => {
    open({
      [`GET ${BASE}/statements`]: () => ok({ statements: [OPEN_STATEMENT] }),
    });
    const u = userEvent.setup();
    renderImport();
    await commit(u);
    const region = await reviewRegion();
    const table = await within(region).findByRole("table", { name: "未処理の明細" });
    expect(within(table).getByRole("row", { name: /ショップ001/ })).toBeInTheDocument();
    // 最初は何も選ばない
    expect(within(table).getByRole("checkbox", { name: "ショップ001 を選択" })).not.toBeChecked();
    expect(within(region).getByRole("button", { name: "選択した 0 件を承認" })).toBeDisabled();
    // 画面の中の主な操作（variant="default"）は 1 つ
    const primary = screen
      .getAllByRole("button")
      .filter((b) => b.className.split(" ").includes("bg-primary"));
    expect(primary.map((b) => b.textContent)).toEqual(["選択した 0 件を承認"]);
  });

  it("④ では入力の欄（貼り付け・ファイル）を隠し、「入力し直す」だけを出す。押すと最初（①）に戻る", async () => {
    open({
      [`GET ${BASE}/statements`]: () => ok({ statements: [OPEN_STATEMENT] }),
    });
    const u = userEvent.setup();
    renderImport();
    expect(await screen.findByLabelText("貼り付けのテキスト")).toBeInTheDocument();
    await commit(u);
    await reviewRegion();

    // 入力の欄はない。取り込んだ件数の知らせと「入力し直す」は残る
    expect(screen.queryByLabelText("貼り付けのテキスト")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "読み取る" })).not.toBeInTheDocument();
    expect(screen.getByText("3 件を取り込みました。")).toBeInTheDocument();
    expect(currentStep()).toHaveTextContent("確認・承認");

    await u.click(screen.getByRole("button", { name: "入力し直す" }));
    expect(await screen.findByLabelText("貼り付けのテキスト")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "明細の確認" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "候補の作成の進み" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "入力し直す" })).not.toBeInTheDocument();
    expect(currentStep()).toHaveTextContent("入力");
  });

  it("③ までは入力の欄を出す（取込の画面を開いた最初と、列の対応・プレビューの間）", async () => {
    open();
    const u = userEvent.setup();
    renderImport();
    expect(await screen.findByLabelText("貼り付けのテキスト")).toBeInTheDocument();
    await readPaste(u);
    await mappingRegion();
    expect(screen.getByLabelText("貼り付けのテキスト")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "入力し直す" })).not.toBeInTheDocument();
  });

  it("④ で確認する明細がなければ、その旨を出す", async () => {
    open();
    const u = userEvent.setup();
    renderImport();
    await commit(u);
    const region = await reviewRegion();
    expect(await within(region).findByText("未処理の明細はありません。")).toBeInTheDocument();
  });
});

describe("取込の履歴（§3.3）", () => {
  it("新しい順の回を、件数つきで示す", async () => {
    mockApi({
      ...baseRoutes,
      [`GET ${BASE}/statements/imports`]: () =>
        ok({
          batches: [
            {
              id: uuid(2),
              origin: "paste",
              sourceName: null,
              inputSha256: SHA,
              periodFrom: "2026-05-10",
              periodTo: "2026-05-11",
              countNew: 3,
              countExisting: 1,
              countUnreadable: 1,
              createdAt: "2026-10-26T01:00:00.000Z",
            },
          ],
        }),
    });
    renderImport();
    const table = await screen.findByRole("table", { name: "取込の履歴" });
    const cells = within(table).getAllByRole("row")[1];
    expect(cells).toHaveTextContent("2026-05-10 〜 2026-05-11");
    expect(cells).toHaveTextContent("貼り付け");
    expect(cells).toHaveTextContent("3");
  });

  it("取込元の名前の列を示す。取込元を使わなかった回は「—」", async () => {
    const batch = (n: number, sourceName: string | null) => ({
      id: uuid(n),
      origin: "file",
      sourceName,
      inputSha256: SHA,
      periodFrom: "2026-05-10",
      periodTo: "2026-05-11",
      countNew: 1,
      countExisting: 0,
      countUnreadable: 0,
      createdAt: "2026-10-26T01:00:00.000Z",
    });
    mockApi({
      ...baseRoutes,
      [`GET ${BASE}/statements/imports`]: () =>
        ok({ batches: [batch(2, "MF ME"), batch(3, null)] }),
    });
    renderImport();
    const table = await screen.findByRole("table", { name: "取込の履歴" });
    expect(within(table).getByRole("columnheader", { name: "取込元" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("MF ME");
    expect(rows[2]).toHaveTextContent("—");
  });

  it("履歴がなければその旨を示す", async () => {
    mockApi(baseRoutes);
    renderImport();
    expect(await screen.findByText("取り込んだ記録はまだありません。")).toBeInTheDocument();
  });
});

/** 保存した取込元（日付・内容・金額（円）・保有金融機関のタブ区切り。口座名の列あり） */
const SOURCE = (over: Record<string, unknown> = {}) => ({
  id: uuid(9001),
  name: "MF ME",
  fixedAccountName: null,
  mapping: {
    delimiter: "\t",
    headerRow: 0,
    columns: { date: 0, content: 1, amount: 2, accountName: 3 },
    amountSign: "inflow_positive",
  },
  header: ["日付", "内容", "金額", "保有金融機関"],
  lastUsedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const COMMIT_OK = (source: unknown = null) => ({
  batch: {
    id: uuid(1),
    origin: "paste",
    sourceName: null,
    inputSha256: SHA,
    periodFrom: "2026-05-10",
    periodTo: "2026-05-11",
    countNew: 3,
    countExisting: 0,
    countUnreadable: 0,
    createdAt: "2026-10-26T01:00:00.000Z",
  },
  added: 3,
  changed: 0,
  source,
});

const withMatch = (match: unknown) => ({ ...LAYOUT, match });

/** 貼り付けて「読み取る」だけ（列の対応の欄を待たない） */
const readOnly = async (u: User) => {
  fireEvent.change(await screen.findByLabelText("貼り付けのテキスト"), { target: { value: TEXT } });
  await u.click(screen.getByRole("button", { name: "読み取る" }));
};

describe("取込元の当てはめ（US2-1。FR-009・010）", () => {
  it("1 件が当てはまれば、列の画面を飛ばして、保存した対応・口座名・取込元の id で preview に進む", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () => ok(withMatch({ kind: "one", source: SOURCE() })),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMIT_OK(SOURCE()), 201),
    });
    const u = userEvent.setup();
    renderImport();
    await readOnly(u);

    await screen.findByRole("region", { name: "プレビュー" });
    expect(screen.queryByRole("region", { name: "列の対応" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "取込元" })).toHaveTextContent("取込元: MF ME");
    const previewCall = calls(all, "POST", "/statements/imports/preview")[0];
    expect(optionsOf(previewCall)).toEqual({
      origin: "paste",
      year: 2026,
      mapping: SOURCE().mapping,
      encoding: "utf-8",
      sourceId: uuid(9001),
    });

    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    expect(await screen.findByText("3 件を取り込みました。")).toBeInTheDocument();
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0])).toMatchObject({
      sourceId: uuid(9001),
      saveSource: { id: uuid(9001), name: "MF ME" },
    });
  });

  it("口座名の列のない取込元は、保存した口座の名前を fixedAccountName で送る", async () => {
    const source = SOURCE({
      fixedAccountName: "サンプル銀行",
      mapping: {
        delimiter: ",",
        headerRow: 2,
        columns: { date: 0, content: 1, outflow: 2, inflow: 3 },
      },
    });
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () => ok({ ...BANK_LAYOUT, match: { kind: "one", source } }),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    await readOnly(u);
    await screen.findByRole("region", { name: "プレビュー" });
    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0])).toMatchObject({
      fixedAccountName: "サンプル銀行",
      mapping: source.mapping,
    });
    // 年のある日付なので、年は聞かない
    expect(screen.queryByLabelText("対象の年")).not.toBeInTheDocument();
  });

  it("年のない日付は、取込元の欄で対象の年を直せる。直すと preview を作り直す", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () => ok(withMatch({ kind: "one", source: SOURCE() })),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    await readOnly(u);
    const region = await screen.findByRole("region", { name: "取込元" });
    const year = await within(region).findByLabelText("対象の年");
    expect(year).toHaveValue(2026);
    fireEvent.change(year, { target: { value: "2025" } });
    await waitFor(() => expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(2));
    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[1])).toMatchObject({
      year: 2025,
    });
  });

  it("「列の対応を直す」で列の画面に戻る。保存した対応が入っていて、直した対応で取込元を更新する（id つき）", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () => ok(withMatch({ kind: "one", source: SOURCE() })),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMIT_OK(SOURCE()), 201),
    });
    const u = userEvent.setup();
    renderImport();
    await readOnly(u);
    await screen.findByRole("region", { name: "プレビュー" });
    await u.click(screen.getByRole("button", { name: "列の対応を直す" }));

    const region = await mappingRegion();
    // 保存した対応が初期値（符号も保存したもの）
    expect(within(region).getByLabelText("「日付」の役割")).toHaveValue("date");
    expect(within(region).getByLabelText("「保有金融機関」の役割")).toHaveValue("accountName");
    expect(within(region).getByRole("radio", { name: "正の値は入金" })).toBeChecked();
    expect(within(region).getByLabelText("取込元の名前")).toHaveValue("MF ME");

    await u.click(confirmButton());
    await waitFor(() => expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(2));
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    await waitFor(() => expect(calls(all, "POST", "/statements/imports")).toHaveLength(1));
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0])).toMatchObject({
      saveSource: { id: uuid(9001), name: "MF ME" },
    });
  });

  it("2 件以上が当てはまれば、列は選ばせず、取込元を選ばせる。選ぶとその対応で preview に進む", async () => {
    const a = SOURCE({ id: uuid(9001), name: "カード A" });
    const b = SOURCE({
      id: uuid(9002),
      name: "カード B",
      mapping: { ...SOURCE().mapping, amountSign: "outflow_positive" },
    });
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () => ok(withMatch({ kind: "many", sources: [a, b] })),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    await readOnly(u);

    const region = await screen.findByRole("region", { name: "取込元" });
    expect(screen.queryByRole("region", { name: "列の対応" })).not.toBeInTheDocument();
    expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(0);
    await u.click(within(region).getByRole("button", { name: "「カード B」を使う" }));

    await screen.findByRole("region", { name: "プレビュー" });
    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0])).toMatchObject({
      sourceId: uuid(9002),
      mapping: b.mapping,
    });
    expect(screen.getByRole("region", { name: "取込元" })).toHaveTextContent("取込元: カード B");
  });

  it("2 件以上のときも「どれも使わず列を選ぶ」で列の画面に進める", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () =>
        ok(
          withMatch({
            kind: "many",
            sources: [SOURCE(), SOURCE({ id: uuid(9002), name: "カード B" })],
          }),
        ),
    });
    const u = userEvent.setup();
    renderImport();
    await readOnly(u);
    await u.click(await screen.findByRole("button", { name: "どれも使わず列を選ぶ" }));
    expect(await mappingRegion()).toBeInTheDocument();
  });
});

describe("取込元の保存（US2-3。FR-009）", () => {
  it("口座名の列がなければ、取込元の名前の既定は取込の口座の名前。そのまま取り込むと { name } で保存する", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${LAYOUT_PATH}`]: () => ok(BANK_LAYOUT),
      [`GET ${BASE}/statement-accounts`]: () => ok({ accounts: [ACCOUNT_VIEW("事業用の口座")] }),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMIT_OK({ ...SOURCE(), name: "新しいカード" }), 201),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    expect(within(region).getByLabelText("取込元の名前")).toHaveValue("");
    await u.selectOptions(await within(region).findByLabelText("取込の口座"), "新しい名前を入れる");
    await u.type(within(region).getByLabelText("口座の名前"), "新しいカード");
    expect(within(region).getByLabelText("取込元の名前")).toHaveValue("新しいカード");
    await u.click(confirmButton());
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    await waitFor(() => expect(calls(all, "POST", "/statements/imports")).toHaveLength(1));
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0]).saveSource).toEqual({
      name: "新しいカード",
    });
  });

  it("まとめ（口座名の列あり）は名前の既定が空で、空のままなら保存しない。名前を入れると { name }", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMIT_OK(), 201),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    expect(within(region).getByLabelText("取込元の名前")).toHaveValue("");
    await chooseSign(u);
    await u.type(within(region).getByLabelText("取込元の名前"), "  MF ME ");
    await u.click(confirmButton());
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    await waitFor(() => expect(calls(all, "POST", "/statements/imports")).toHaveLength(1));
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0]).saveSource).toEqual({
      name: "MF ME",
    });
  });

  it("名前を空にした取込は保存しない（saveSource: null）", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMIT_OK(), 201),
    });
    const u = userEvent.setup();
    renderImport();
    await toPreview(u);
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    await waitFor(() => expect(calls(all, "POST", "/statements/imports")).toHaveLength(1));
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0]).saveSource).toBeNull();
  });

  it("名前が重複（409）すれば、知らせる。列の画面は残り、名前を変えて取り込める", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () =>
        apiError(409, "STATEMENT_SOURCE_NAME_TAKEN", "同じ名前の取込元があります"),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    await chooseSign(u);
    await u.type(within(region).getByLabelText("取込元の名前"), "MF ME");
    await u.click(confirmButton());
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("同じ名前の取込元があります");
    expect(screen.getByRole("region", { name: "列の対応" })).toBeInTheDocument();
  });
});

describe("既存の取込元を選ぶ・見出しの違い（US2-2。FR-011）", () => {
  /** 先頭に「番号」の列が足され、「メモ」の列がなくなった表 */
  const DIFF_LAYOUT = {
    ...LAYOUT,
    header: ["番号", "日付", "内容", "金額（円）", "保有金融機関"],
    columnCount: 5,
    sampleRows: [["1", "05/10(日)", "ショップ001", "-1,200", "サンプル銀行"]],
    suggestedColumns: { date: 1, content: 2, amount: 3, accountName: 4 },
    match: { kind: "none" },
    headerDiff: { added: ["番号"], removed: ["メモ"] },
  };

  it("既存の取込元を選ぶと sourceId つきで判定をやり直し、足された列・なくなった列を示し、引き継いだ役割を入れる", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`GET ${BASE}/statement-sources`]: () => ok({ sources: [SOURCE()] }),
      [`POST ${LAYOUT_PATH}`]: (call) =>
        ok(optionsOf(call).sourceId === undefined ? LAYOUT : DIFF_LAYOUT),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
      [`POST ${COMMIT_PATH}`]: () => ok(COMMIT_OK(SOURCE()), 201),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    expect(within(region).queryByLabelText("見出しの違い")).not.toBeInTheDocument();
    await u.selectOptions(await within(region).findByLabelText("既存の取込元を選ぶ"), "MF ME");

    await waitFor(() => expect(calls(all, "POST", "/statements/imports/layout")).toHaveLength(2));
    expect(optionsOf(calls(all, "POST", "/statements/imports/layout")[1])).toMatchObject({
      origin: "paste",
      sourceId: uuid(9001),
    });
    const diff = await screen.findByLabelText("見出しの違い");
    expect(diff).toHaveTextContent("足された列: 番号");
    expect(diff).toHaveTextContent("なくなった列: メモ");
    // 引き継いだ役割（列の番号が 1 つずれる）と符号。選んだ取込元が選ばれたまま
    expect(screen.getByLabelText("「日付」の役割")).toHaveValue("date");
    expect(screen.getByLabelText("「番号」の役割")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "正の値は入金" })).toBeChecked();
    expect(screen.getByLabelText("既存の取込元を選ぶ")).toHaveValue(uuid(9001));
    expect(screen.getByLabelText("取込元の名前")).toHaveValue("MF ME");

    // 選び直した対応で保存し直す（id つき）
    await u.click(confirmButton());
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    await waitFor(() => expect(calls(all, "POST", "/statements/imports")).toHaveLength(1));
    expect(optionsOf(calls(all, "POST", "/statements/imports")[0]).saveSource).toEqual({
      id: uuid(9001),
      name: "MF ME",
    });
    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0]).mapping).toMatchObject({
      columns: { date: 1, content: 2, amount: 3, accountName: 4 },
    });
  });

  it("手で選んだ取込元がそのまま当てはまれば、列の画面を飛ばして preview に進む", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`GET ${BASE}/statement-sources`]: () => ok({ sources: [SOURCE()] }),
      [`POST ${LAYOUT_PATH}`]: (call) =>
        ok(
          optionsOf(call).sourceId === undefined
            ? LAYOUT
            : withMatch({ kind: "one", source: SOURCE() }),
        ),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    await u.selectOptions(await within(region).findByLabelText("既存の取込元を選ぶ"), "MF ME");
    await screen.findByRole("region", { name: "プレビュー" });
    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0])).toMatchObject({
      sourceId: uuid(9001),
    });
  });

  it("選んだ取込元がなくなっていれば（404）、知らせる", async () => {
    mockApi({
      ...baseRoutes,
      [`GET ${BASE}/statement-sources`]: () => ok({ sources: [SOURCE()] }),
      [`POST ${LAYOUT_PATH}`]: (call) =>
        optionsOf(call).sourceId === undefined
          ? ok(LAYOUT)
          : apiError(404, "STATEMENT_SOURCE_NOT_FOUND", "取込元が見つかりません"),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(u);
    await u.selectOptions(await within(region).findByLabelText("既存の取込元を選ぶ"), "MF ME");
    expect(await screen.findByRole("alert")).toHaveTextContent("取込元が見つかりません");
  });
});

describe("AI の案（US4。FR-016〜019）", () => {
  const SUGGEST_PATH = `${BASE}/statements/imports/column-suggestion`;
  /** 見出しが辞書に当たらない独自の名前（案は空） */
  const CUSTOM_LAYOUT = {
    ...LAYOUT,
    header: ["発生日", "取引の内容", "増減額", "整理番号"],
    needsYear: false,
    sampleRows: [["2026/10/01", "テスト商事", "100", "1"]],
    suggestedColumns: {},
  };
  const AI_SUGGESTION = {
    columns: { date: 0, content: 1, amount: 2, externalId: 3 },
    amountSign: "inflow_positive",
    confidence: 77,
  };
  const customRoutes = (suggest: () => ReturnType<typeof ok> | Promise<ReturnType<typeof ok>>) => ({
    ...baseRoutes,
    [`POST ${LAYOUT_PATH}`]: () => ok(CUSTOM_LAYOUT),
    [`POST ${SUGGEST_PATH}`]: suggest,
  });

  it("必須の役割がそろう表（辞書の案）では、案を要求しない", async () => {
    const all = mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    await readPaste(u);
    expect(calls(all, "POST", "/statements/imports/column-suggestion")).toHaveLength(0);
    expect(screen.queryByText(/AI の案/)).not.toBeInTheDocument();
  });

  it("必須がそろわないときだけ、読み取りと同じファイル・文字コード・区切り・見出しの行で要求する", async () => {
    const all = mockApi(customRoutes(() => ok({ suggestion: null })));
    const u = userEvent.setup();
    renderImport();
    await readPaste(u, "発生日\t取引の内容\t増減額\t整理番号\n2026/10/01\tテスト商事\t100\t1");
    await waitFor(() =>
      expect(calls(all, "POST", "/statements/imports/column-suggestion")).toHaveLength(1),
    );
    const call = calls(all, "POST", "/statements/imports/column-suggestion")[0];
    expect(optionsOf(call)).toEqual({
      origin: "paste",
      encoding: "utf-8",
      delimiter: "\t",
      headerRow: 0,
    });
    expect(await fileTextOf(call)).toContain("発生日");
  });

  it("待つ間も列を選べる。案が来たら、触っていない列にだけ入れ、「AI の案」と確信度を示す。自動では進まず、符号も選ばない", async () => {
    let resolve: (reply: ReturnType<typeof ok>) => void = () => {};
    const pending = new Promise<ReturnType<typeof ok>>((r) => {
      resolve = r;
    });
    const all = mockApi({
      ...customRoutes(() => pending),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(
      u,
      "発生日\t取引の内容\t増減額\t整理番号\n2026/10/01\tテスト商事\t100\t1",
    );

    expect(await within(region).findByText("AI の案を作っています…")).toBeInTheDocument();
    // 待っている間に、利用者が 1 列目を選ぶ（触った列は案で上書きしない）
    await u.selectOptions(within(region).getByLabelText("「発生日」の役割"), "メモ");
    expect(confirmButton()).toBeDisabled();

    resolve(ok({ suggestion: AI_SUGGESTION }));
    expect(await within(region).findByText(/AI の案（確信度 77）/)).toBeInTheDocument();
    expect(within(region).queryByText("AI の案を作っています…")).not.toBeInTheDocument();

    expect(within(region).getByLabelText("「発生日」の役割")).toHaveValue("memo");
    expect(within(region).getByLabelText("「取引の内容」の役割")).toHaveValue("content");
    expect(within(region).getByLabelText("「増減額」の役割")).toHaveValue("amount");
    expect(within(region).getByLabelText("「整理番号」の役割")).toHaveValue("externalId");
    // 日付の列は利用者が別の役割にしたので、日付がなく、確認へ進めない。符号も自動では選ばない
    const reasons = within(region).getByRole("list", { name: "確認へ進めない理由" });
    expect(reasons).toHaveTextContent("「日付」の列を選んでください");
    expect(reasons).toHaveTextContent("金額の符号（正の値が入金か出金か）を選んでください");
    expect(within(region).getByRole("radio", { name: "正の値は入金" })).not.toBeChecked();
    expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(0);
  });

  it("案で必須がそろっても、確認へ進めるのは符号を選んだあと（利用者が確かめてから）", async () => {
    const all = mockApi({
      ...customRoutes(() => ok({ suggestion: AI_SUGGESTION })),
      [`POST ${PREVIEW_PATH}`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(
      u,
      "発生日\t取引の内容\t増減額\t整理番号\n2026/10/01\tテスト商事\t100\t1",
    );
    await waitFor(() =>
      expect(within(region).getByLabelText("「発生日」の役割")).toHaveValue("date"),
    );
    // 口座名の列がないので、取込の口座も選ぶ
    expect(confirmButton()).toBeDisabled();
    expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(0);
    await chooseSign(u);
    await u.selectOptions(within(region).getByLabelText("取込の口座"), "新しい名前を入れる");
    await u.type(within(region).getByLabelText("口座の名前"), "サンプル銀行");
    await u.click(confirmButton());
    await screen.findByRole("region", { name: "プレビュー" });
    expect(optionsOf(calls(all, "POST", "/statements/imports/preview")[0])).toMatchObject({
      mapping: { columns: { date: 0, content: 1, amount: 2, externalId: 3 } },
    });
  });

  it("使えない理由を控えめに示す。案なしでも列を選べる", async () => {
    const cases: [string, string][] = [
      ["disabled", "端末内の AI は無効です"],
      ["unavailable", "端末内の AI を使えないため、案はありません"],
      ["timeout", "AI の応答が時間内に返らなかったため、案はありません"],
      ["invalid", "AI の案が正しい形ではなかったため、使いませんでした"],
    ];
    for (const [unavailable, message] of cases) {
      mockApi(customRoutes(() => ok({ suggestion: null, unavailable })));
      const u = userEvent.setup();
      const { unmount } = renderImport();
      const region = await readPaste(
        u,
        "発生日\t取引の内容\t増減額\t整理番号\n2026/10/01\tテスト商事\t100\t1",
      );
      expect(await within(region).findByText(message, { exact: false })).toBeInTheDocument();
      await u.selectOptions(within(region).getByLabelText("「発生日」の役割"), "日付");
      expect(within(region).getByLabelText("「発生日」の役割")).toHaveValue("date");
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it("AI を使えず、列の中身からの推定だけのときは「AI の案」と言わず、推定として示して列に入れる", async () => {
    mockApi(
      customRoutes(() =>
        ok({
          suggestion: {
            columns: { date: 0, content: 1, amount: 2 },
            amountSign: null,
            confidence: 0,
          },
          unavailable: "disabled",
        }),
      ),
    );
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(
      u,
      "発生日\t取引の内容\t増減額\t整理番号\n2026/10/01\tテスト商事\t100\t1",
    );
    expect(
      await within(region).findByText(/列の中身から推定した案/, { exact: false }),
    ).toBeInTheDocument();
    expect(within(region).getByText(/端末内の AI は無効です/)).toBeInTheDocument();
    expect(within(region).queryByText(/AI の案（確信度/)).not.toBeInTheDocument();
    expect(within(region).getByLabelText("「発生日」の役割")).toHaveValue("date");
    expect(within(region).getByLabelText("「増減額」の役割")).toHaveValue("amount");
    // 推定でも、符号は自動では選ばない
    expect(within(region).getByRole("radio", { name: "正の値は入金" })).not.toBeChecked();
  });

  it("要求が失敗（サーバーの 500）しても、案なしで列を選べる", async () => {
    mockApi(
      customRoutes(() =>
        ok({ error: { code: "INTERNAL", message: "サーバーでエラーが発生しました" } }, 500),
      ),
    );
    const u = userEvent.setup();
    renderImport();
    const region = await readPaste(
      u,
      "発生日\t取引の内容\t増減額\t整理番号\n2026/10/01\tテスト商事\t100\t1",
    );
    expect(await within(region).findByText("AI の案を作れませんでした")).toBeInTheDocument();
    await u.selectOptions(within(region).getByLabelText("「発生日」の役割"), "日付");
    expect(within(region).getByLabelText("「発生日」の役割")).toHaveValue("date");
  });

  it("保存した取込元が当てはまる表（2 件以上から「どれも使わず」）では要求しない", async () => {
    const all = mockApi({
      ...customRoutes(() => ok({ suggestion: AI_SUGGESTION })),
      [`POST ${LAYOUT_PATH}`]: () =>
        ok({
          ...CUSTOM_LAYOUT,
          match: {
            kind: "many",
            sources: [SOURCE(), SOURCE({ id: uuid(9002), name: "カード B" })],
          },
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await readOnly(u);
    await u.click(await screen.findByRole("button", { name: "どれも使わず列を選ぶ" }));
    expect(await mappingRegion()).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/imports/column-suggestion")).toHaveLength(0);
  });
});

describe("メニュー", () => {
  it("取込の画面から明細の一覧へ戻れる（事業体のサブメニューの「一覧と確認」でも戻れる。entity-nav.test.tsx）", async () => {
    mockApi(baseRoutes);
    renderImport();
    expect(await screen.findByRole("link", { name: "明細の一覧へ" })).toHaveAttribute(
      "href",
      "/e/e1/statements",
    );
  });
});
