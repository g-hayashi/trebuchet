import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReceiptDetail, ReceiptReadingView } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route as NewJournalRoute } from "@/routes/e/$entityId/journals/new";
import { Route as ReceiptRoute } from "@/routes/e/$entityId/receipts/$receiptId";
import { Route as ReceiptsRoute } from "@/routes/e/$entityId/receipts/index";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, receiptDetail, receiptReading } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T035: 外部の AI の読み取り（FR-014〜017、R13・R15）。候補は入力欄の初期値にとどめ、保存は利用者の操作

const ENTITY = "/api/entities/e1";
const DETAIL = `${ENTITY}/receipts/${RECEIPT_ID}`;
const READINGS = `${DETAIL}/readings`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const AI_SETTINGS = {
  localEnabled: true,
  localAvailable: true,
  externalEnabled: true,
  externalBaseUrl: "https://api.example.com/v1",
  externalModel: "model-a",
  apiKeySet: true,
  receiptImagesEnabled: true,
};
const aiOn = { "GET /api/settings/ai": () => ok(AI_SETTINGS) };
const aiOff = {
  "GET /api/settings/ai": () => ok({ ...AI_SETTINGS, receiptImagesEnabled: false }),
};

const EMPTY: Partial<ReceiptDetail> = {
  transactionDate: null,
  amount: null,
  partnerName: null,
  memo: null,
  warnings: [{ code: "FIELDS_MISSING" }],
};

const CANDIDATES: ReceiptReadingView["candidates"] = {
  transactionDate: "2026-10-21",
  amount: 3300,
  partnerName: "AI の店",
  accountCode: "6010",
  taxCategory: "PURCHASE_10",
};

const account = (
  n: number,
  name: string,
  rest: Pick<Account, "category" | "normalSide" | "reportSection">,
): Account => ({
  id: uuid(n),
  code: String(n),
  name,
  reportLine: null,
  sortOrder: n,
  isSystem: false,
  isActive: true,
  ...rest,
});
const supplies = account(6010, "消耗品費", {
  category: "expense",
  normalSide: "debit",
  reportSection: "PL_EXPENSE",
});
const sales = account(4010, "売上高", {
  category: "revenue",
  normalSide: "credit",
  reportSection: "PL_SALES",
});
const bank = account(1020, "普通預金", {
  category: "asset",
  normalSide: "debit",
  reportSection: "BS_ASSET",
});
const ACCOUNTS = { [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [supplies, sales, bank] }) };

const posts = (calls: ApiCall[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.path === path);
const patches = (calls: ApiCall[]) => calls.filter((c) => c.method === "PATCH");

const renderDetail = () =>
  renderRoute(ReceiptRoute, {
    path: "/e/$entityId/receipts/$receiptId",
    url: `/e/e1/receipts/${RECEIPT_ID}`,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("読み取りの操作は設定が有効なときだけ", () => {
  it("無効なら操作を出さず、手入力で続けることを示す", async () => {
    mockApi({ ...aiOff, [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail(EMPTY) }) });
    renderDetail();
    await screen.findByRole("form", { name: "証憑の値" });
    expect(screen.queryByRole("button", { name: "AI で読み取る" })).not.toBeInTheDocument();
    const note = screen.getByRole("region", { name: "AI の読み取り" });
    expect(note).toHaveTextContent("無効");
    expect(within(note).getByRole("link", { name: "AI の設定" })).toHaveAttribute(
      "href",
      "/settings/ai",
    );
  });

  it("有効なら操作を出す。削除済みの証憑には出さない", async () => {
    mockApi({ ...aiOn, [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail(EMPTY) }) });
    const first = renderDetail();
    expect(await screen.findByRole("button", { name: "AI で読み取る" })).toBeEnabled();
    first.unmount();

    mockApi({
      ...aiOn,
      [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail({ deleted: true }) }),
    });
    renderDetail();
    await screen.findByText(/削除済みです/);
    expect(screen.queryByRole("button", { name: "AI で読み取る" })).not.toBeInTheDocument();
  });
});

describe("読み取りと候補", () => {
  const readingApi = (detail: Partial<ReceiptDetail>, reading: ReceiptReadingView) =>
    mockApi({
      ...aiOn,
      ...ACCOUNTS,
      [`GET ${ENTITY}/tax-categories`]: () =>
        ok({
          taxCategories: [{ code: "PURCHASE_10", name: "課税仕入 10%", kind: "purchase" }],
          taxRates: [],
        }),
      [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail(detail) }),
      [`POST ${READINGS}`]: () => ok({ reading }, 201),
    });

  it("読み取ると候補を AI の候補として示し、説明を添え、未入力の欄の初期値にする。保存はしない", async () => {
    const calls = readingApi(
      EMPTY,
      receiptReading({ id: uuid(1), candidates: CANDIDATES, reason: "コンビニの領収書に見える" }),
    );
    renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "AI で読み取る" }));

    const note = await screen.findByRole("region", { name: "AI の読み取り" });
    await within(note).findByText("AI の候補です。確かめてから保存してください。");
    expect(note).toHaveTextContent("コンビニの領収書に見える");
    expect(note).toHaveTextContent("2026-10-21");
    expect(note).toHaveTextContent("3,300");
    expect(note).toHaveTextContent("AI の店");
    expect(note).toHaveTextContent("消耗品費");
    expect(note).toHaveTextContent("課税仕入 10%");
    expect(note).toHaveTextContent(/確信度\s*80/);

    const form = screen.getByRole("form", { name: "証憑の値" });
    expect(within(form).getByLabelText("取引年月日")).toHaveValue("2026-10-21");
    expect(within(form).getByLabelText("金額")).toHaveValue("3,300");
    expect(within(form).getByLabelText("取引先")).toHaveValue("AI の店");
    expect(within(form).getAllByText("AI の候補（未保存）")).toHaveLength(3);
    expect(posts(calls, READINGS)).toHaveLength(1);
    expect(patches(calls)).toHaveLength(0);
  });

  it("候補の値を保存するのは利用者の操作。保存すると PATCH で送る（理由は求めない）", async () => {
    const calls = readingApi(EMPTY, receiptReading({ id: uuid(1), candidates: CANDIDATES }));
    renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "AI で読み取る" }));
    const form = await screen.findByRole("form", { name: "証憑の値" });
    await waitFor(() => expect(within(form).getByLabelText("金額")).toHaveValue("3,300"));

    // 直した欄は AI の候補の印が消える
    await user.clear(within(form).getByLabelText("取引先"));
    await user.type(within(form).getByLabelText("取引先"), "直した店");
    expect(within(form).getAllByText("AI の候補（未保存）")).toHaveLength(2);

    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.body).toEqual({
      version: 1,
      transactionDate: "2026-10-21",
      amount: 3300,
      partnerName: "直した店",
    });
  });

  it("入力済みの値は上書きしない（候補は参考として示すだけ）", async () => {
    readingApi(
      { partnerName: "合成の店", amount: 1100, transactionDate: null },
      receiptReading({ id: uuid(1), candidates: CANDIDATES }),
    );
    renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "AI で読み取る" }));
    const form = screen.getByRole("form", { name: "証憑の値" });
    await waitFor(() =>
      expect(within(form).getByLabelText("取引年月日")).toHaveValue("2026-10-21"),
    );
    expect(within(form).getByLabelText("金額")).toHaveValue("1,100");
    expect(within(form).getByLabelText("取引先")).toHaveValue("合成の店");
    expect(within(form).getAllByText("AI の候補（未保存）")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "AI の読み取り" })).toHaveTextContent("AI の店");
  });

  it("候補なしの項目は「候補なし」と示し、欄は空のまま", async () => {
    readingApi(
      EMPTY,
      receiptReading({
        id: uuid(1),
        candidates: { ...CANDIDATES, amount: null, partnerName: null },
      }),
    );
    renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "AI で読み取る" }));
    const note = await screen.findByRole("region", { name: "AI の読み取り" });
    await within(note).findByText("AI の候補です。確かめてから保存してください。");
    expect(within(note).getAllByText("候補なし").length).toBeGreaterThanOrEqual(2);
    const form = screen.getByRole("form", { name: "証憑の値" });
    expect(within(form).getByLabelText("金額")).toHaveValue("");
    expect(within(form).getByLabelText("取引先")).toHaveValue("");
  });

  it("追加のときに読んだ記録（現在のファイルより後）があれば、開いたときに候補を使う。古いファイルの記録は使わない", async () => {
    mockApi({
      ...aiOn,
      ...ACCOUNTS,
      [`GET ${DETAIL}`]: () =>
        ok({
          receipt: receiptDetail({
            ...EMPTY,
            readings: [
              receiptReading({
                id: uuid(1),
                readAt: "2026-10-19T09:00:00.000Z",
                candidates: { ...CANDIDATES, partnerName: "古いファイルの店" },
              }),
              receiptReading({ id: uuid(2), candidates: CANDIDATES }),
            ],
          }),
        }),
    });
    renderDetail();
    const form = await screen.findByRole("form", { name: "証憑の値" });
    await waitFor(() => expect(within(form).getByLabelText("取引先")).toHaveValue("AI の店"));
  });
});

describe("読み取りの失敗（FR-017）", () => {
  it.each([
    ["timeout", "AI_TIMEOUT", "時間切れ"],
    ["failed", "AI_HTTP_ERROR", "AI に接続できませんでした"],
    ["invalid", "AI_INVALID_OUTPUT", "AI の応答を読み取れませんでした"],
    ["failed", "RECEIPT_READ_UNSUPPORTED", "この形式のファイルは AI で読み取れません"],
    ["failed", "RECEIPT_CONVERSION_FAILED", "画像を読み取り用に変換できませんでした"],
  ] as const)("%s（%s）は示して、手入力で続けられる", async (status, errorCode, text) => {
    const calls = mockApi({
      ...aiOn,
      [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail(EMPTY) }),
      [`POST ${READINGS}`]: () =>
        ok({ reading: receiptReading({ id: uuid(3), status, errorCode, confidence: null }) }, 201),
    });
    renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "AI で読み取る" }));
    const note = await screen.findByRole("region", { name: "AI の読み取り" });
    await within(note).findByText(new RegExp(text));
    expect(note).toHaveTextContent("手入力で続けられます");
    expect(note).toHaveTextContent("証憑は保存されています");

    // 欄は空のまま、手入力して保存できる。読み直しもできる
    const form = screen.getByRole("form", { name: "証憑の値" });
    expect(within(form).queryByText("AI の候補（未保存）")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("取引先"), "手入力の店");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(screen.getByRole("button", { name: "AI で読み取る" })).toBeEnabled();
  });

  it("設定が無効になっていた（422 AI_NOT_CONFIGURED）ときはエラーを示す", async () => {
    mockApi({
      ...aiOn,
      [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail(EMPTY) }),
      [`POST ${READINGS}`]: () =>
        apiError(422, "AI_NOT_CONFIGURED", "証憑の画像を外部の AI に送る設定が無効です"),
    });
    renderDetail();
    await userEvent.click(await screen.findByRole("button", { name: "AI で読み取る" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "証憑の画像を外部の AI に送る設定が無効です",
    );
  });
});

describe("追加の直後の自動の読み取り", () => {
  const LIST = `${ENTITY}/receipts`;
  const upload = async () => {
    renderRoute(ReceiptsRoute, { path: "/e/$entityId/receipts/", url: "/e/e1/receipts" });
    const form = await screen.findByRole("form", { name: "証憑を追加" });
    const user = userEvent.setup();
    await user.upload(
      within(form).getByLabelText("証憑のファイル"),
      new File([new Uint8Array(1000)], "領収書.jpg", { type: "image/jpeg" }),
    );
    await user.click(within(form).getByRole("radio", { name: "電子取引" }));
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await screen.findByText("保存しました。");
  };

  it("設定が有効なら、保存の後に readings を呼ぶ（保存の表示は待たない）", async () => {
    const calls = mockApi({
      ...aiOn,
      [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }),
      [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201),
      [`POST ${READINGS}`]: () => ok({ reading: receiptReading() }, 201),
    });
    await upload();
    await waitFor(() => expect(posts(calls, READINGS)).toHaveLength(1));
  });

  it("読み取りが失敗しても保存の表示はそのまま（エラーを出さない）", async () => {
    const calls = mockApi({
      ...aiOn,
      [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }),
      [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201),
      [`POST ${READINGS}`]: () => apiError(422, "AI_NOT_CONFIGURED", "無効です"),
    });
    await upload();
    await waitFor(() => expect(posts(calls, READINGS)).toHaveLength(1));
    expect(screen.getByText("保存しました。")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("設定が無効なら呼ばない", async () => {
    const calls = mockApi({
      ...aiOff,
      [`GET ${LIST}`]: () => ok({ receipts: [], nextCursor: null }),
      [`POST ${LIST}`]: () => ok({ receipt: receiptDetail() }, 201),
      [`POST ${READINGS}`]: () => ok({ reading: receiptReading() }, 201),
    });
    await upload();
    // 呼ぶなら保存の直後。非同期の呼び出しを待つ分だけ置く
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posts(calls, READINGS)).toHaveLength(0);
  });
});

describe("証憑から仕訳を作るときの候補（readingId）", () => {
  const NEW_URL = `/e/e1/journals/new?receiptId=${RECEIPT_ID}`;
  const JOURNAL = `${DETAIL}/journal`;

  function journalApi(
    detail: Partial<ReceiptDetail>,
    accounts: Account[] = [supplies, bank, sales],
  ) {
    return mockApi({
      ...aiOn,
      [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail(detail) }),
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
      [`GET ${ENTITY}/partners`]: () => ok({ partners: [] }),
      [`GET ${ENTITY}/tags`]: () => ok({ tags: [] }),
      [`GET ${ENTITY}/tax-settings`]: () =>
        ok({
          taxSettings: [
            {
              id: "t1",
              effectiveFrom: "2026-01-01",
              taxpayerStatus: "exempt",
              accountingMethod: "tax_included",
            },
          ],
        }),
      [`GET ${ENTITY}/tax-categories`]: () =>
        ok({
          taxCategories: [
            { code: "OUT_OF_SCOPE", name: "対象外", kind: null },
            { code: "PURCHASE_10", name: "課税仕入 10%", kind: "purchase" },
            { code: "SALES_10", name: "課税売上 10%", kind: "sales" },
          ],
          taxRates: [],
        }),
      [`GET ${ENTITY}/accounts/${supplies.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
      [`GET ${ENTITY}/accounts/${bank.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
      [`GET ${ENTITY}/accounts/${sales.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
      [`POST ${JOURNAL}`]: () => apiError(409, "RECEIPT_ALREADY_LINKED", "結びついています"),
    });
  }

  const renderNew = () =>
    renderRoute(NewJournalRoute, { path: "/e/$entityId/journals/new", url: NEW_URL });

  it("候補の科目（その科目の通常の側の行）と税区分を初期値にして、AI の候補と示す。登録には readingId を付ける", async () => {
    const calls = journalApi({
      readings: [
        receiptReading({
          id: uuid(11),
          candidates: CANDIDATES,
          reason: "文具の購入",
        }),
      ],
    });
    renderNew();
    const user = userEvent.setup();
    expect(await screen.findByLabelText("1行目の勘定科目")).toHaveValue(supplies.id);
    expect(screen.getByLabelText("1行目の税区分")).toHaveValue("PURCHASE_10");
    expect(screen.getByLabelText("2行目の勘定科目")).toHaveValue("");
    const note = screen.getByRole("note", { name: "AI の候補" });
    expect(note).toHaveTextContent("消耗品費");
    expect(note).toHaveTextContent("課税仕入 10%");
    expect(note).toHaveTextContent("文具の購入");

    await user.selectOptions(screen.getByLabelText("2行目の勘定科目"), "普通預金");
    await user.click(screen.getByRole("button", { name: "登録する" }));
    await waitFor(() => expect(posts(calls, JOURNAL)).toHaveLength(1));
    const body = posts(calls, JOURNAL)[0]?.body as { readingId?: string; journal: unknown };
    expect(body.readingId).toBe(uuid(11));
  });

  it("貸方が通常の側の科目（売上など）の候補は貸方の行に入れる", async () => {
    journalApi({
      readings: [
        receiptReading({
          id: uuid(12),
          candidates: { ...CANDIDATES, accountCode: "4010", taxCategory: "SALES_10" },
        }),
      ],
    });
    renderNew();
    expect(await screen.findByLabelText("2行目の勘定科目")).toHaveValue(sales.id);
    expect(screen.getByLabelText("2行目の税区分")).toHaveValue("SALES_10");
    expect(screen.getByLabelText("1行目の勘定科目")).toHaveValue("");
  });

  it("読み取りがなければ（または失敗していれば）候補を入れず、readingId も送らない", async () => {
    const calls = journalApi({
      readings: [receiptReading({ id: uuid(13), status: "timeout", errorCode: "AI_TIMEOUT" })],
    });
    renderNew();
    const user = userEvent.setup();
    expect(await screen.findByLabelText("1行目の勘定科目")).toHaveValue("");
    expect(screen.queryByRole("note", { name: "AI の候補" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("1行目の勘定科目"), "消耗品費");
    await user.selectOptions(screen.getByLabelText("2行目の勘定科目"), "普通預金");
    await user.click(screen.getByRole("button", { name: "登録する" }));
    await waitFor(() => expect(posts(calls, JOURNAL)).toHaveLength(1));
    expect(posts(calls, JOURNAL)[0]?.body).not.toHaveProperty("readingId");
  });

  it("設定が無効なら、記録が残っていても候補を使わない", async () => {
    mockApi({
      ...aiOff,
      [`GET ${DETAIL}`]: () =>
        ok({ receipt: receiptDetail({ readings: [receiptReading({ candidates: CANDIDATES })] }) }),
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [supplies, bank] }),
      [`GET ${ENTITY}/partners`]: () => ok({ partners: [] }),
      [`GET ${ENTITY}/tags`]: () => ok({ tags: [] }),
      [`GET ${ENTITY}/tax-settings`]: () => ok({ taxSettings: [] }),
      [`GET ${ENTITY}/tax-categories`]: () => ok({ taxCategories: [], taxRates: [] }),
      [`GET ${ENTITY}/accounts/${supplies.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
      [`GET ${ENTITY}/accounts/${bank.id}/sub-accounts`]: () => ok({ subAccounts: [] }),
    });
    renderNew();
    expect(await screen.findByLabelText("1行目の勘定科目")).toHaveValue("");
    expect(screen.queryByRole("note", { name: "AI の候補" })).not.toBeInTheDocument();
  });
});
