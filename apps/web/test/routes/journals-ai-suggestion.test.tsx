import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route } from "@/routes/e/$entityId/journals/new";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 011 T044（R19、FR-060）: かんたん入力の AI の候補。外部の AI が有効なときだけボタンを出し、
// 候補は「入れる」まで欄に入れない（登録はいつも利用者の操作）

const ENTITY = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (
  n: number,
  name: string,
  rest: Pick<Account, "category" | "normalSide" | "reportSection"> & Partial<Account>,
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
const bank = account(1020, "普通預金", {
  category: "asset",
  normalSide: "debit",
  reportSection: "BS_ASSET",
});
const sales = account(4010, "売上高", {
  category: "revenue",
  normalSide: "credit",
  reportSection: "PL_SALES",
});
const supplies = account(6010, "消耗品費", {
  category: "expense",
  normalSide: "debit",
  reportSection: "PL_EXPENSE",
});
const accounts = [sales, bank, supplies];

const TAX_CATEGORIES = [
  { code: "OUT_OF_SCOPE", name: "対象外", kind: null },
  { code: "SALES_10", name: "課税売上 10%", kind: "sales" },
  { code: "PURCHASE_10", name: "課税仕入 10%", kind: "purchase" },
];

const EXTERNAL_ON = {
  localEnabled: true,
  localAvailable: true,
  externalEnabled: true,
  externalBaseUrl: "https://api.example.com",
  externalModel: "model-a",
  receiptImagesEnabled: false,
  apiKeySet: true,
};

const suggestion = (over: Record<string, unknown> = {}) => ({
  accountCode: "6010",
  taxCategory: "PURCHASE_10",
  purpose: "business",
  confidence: 88,
  reason: "文房具の購入",
  ...over,
});

type Options = {
  settings?: typeof EXTERNAL_ON | undefined;
  reply?: Parameters<typeof mockApi>[0][string];
};

function setup({ settings, reply }: Options = {}): ApiCall[] {
  return mockApi({
    ...(settings && { "GET /api/settings/ai": () => ok(settings) }),
    ...(reply && { [`POST ${ENTITY}/journals/ai-suggestion`]: reply }),
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
    [`GET ${ENTITY}/partners`]: () => ok({ partners: [] }),
    [`GET ${ENTITY}/tags`]: () => ok({ tags: [] }),
    [`GET ${ENTITY}/tax-settings`]: () => ok({ taxSettings: [] }),
    [`GET ${ENTITY}/tax-categories`]: () => ok({ taxCategories: TAX_CATEGORIES, taxRates: [] }),
  });
}

const open = () =>
  renderRoute(Route, { path: "/e/$entityId/journals/new", url: "/e/e1/journals/new" });
const aiButton = () => screen.queryByRole("button", { name: "AI で候補を出す" });
const user = () => userEvent.setup();
const posts = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/journals/ai-suggestion"));

afterEach(() => vi.restoreAllMocks());

describe("かんたん入力の AI の候補（011 T044）", () => {
  it("既定（外部の AI が無効）ではボタンを出さず、AI の API を呼ばない", async () => {
    const calls = setup();
    open();
    await screen.findByLabelText("摘要", { exact: true });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/settings/ai")).toBe(true));
    expect(aiButton()).not.toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
  });

  it("端末内だけが有効（外部は無効）でもボタンを出さない", async () => {
    setup({ settings: { ...EXTERNAL_ON, externalEnabled: false } });
    open();
    await screen.findByLabelText("摘要", { exact: true });
    expect(aiButton()).not.toBeInTheDocument();
  });

  it("外部の AI が有効ならボタンを出し、摘要と金額がそろうまで押せない", async () => {
    setup({ settings: EXTERNAL_ON });
    const u = user();
    open();
    const button = await screen.findByRole("button", { name: "AI で候補を出す" });
    expect(button).toBeDisabled();
    await u.type(screen.getByLabelText("摘要", { exact: true }), "文房具");
    expect(button).toBeDisabled();
    await u.type(screen.getByLabelText("金額", { exact: true }), "1100");
    expect(button).toBeEnabled();
  });

  it("候補と根拠・確信度を出し、「入れる」まで欄は変わらない。入れると経費は借方の科目と税区分に入る", async () => {
    const calls = setup({
      settings: EXTERNAL_ON,
      reply: () => ok({ suggestion: suggestion() }),
    });
    const u = user();
    open();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "文房具");
    await u.type(screen.getByLabelText("金額", { exact: true }), "1100");
    await u.click(screen.getByRole("button", { name: "AI で候補を出す" }));

    const panel = await screen.findByRole("region", { name: "AI の候補" });
    expect(within(panel).getByText(/消耗品費/)).toBeInTheDocument();
    expect(within(panel).getByText(/課税仕入 10%/)).toBeInTheDocument();
    expect(within(panel).getByText(/88/)).toBeInTheDocument();
    expect(within(panel).getByText(/文房具の購入/)).toBeInTheDocument();
    // 送るのは日付・金額・摘要だけ
    expect(posts(calls)[0]?.body).toEqual({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      amount: 1100,
      memo: "文房具",
    });
    // まだ欄は変わらない
    expect(screen.getByRole("combobox", { name: "借方科目" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "貸方科目" })).toHaveValue("");

    await u.click(within(panel).getByRole("button", { name: "入れる" }));
    expect(screen.getByRole("combobox", { name: "借方科目" })).toHaveValue("6010 消耗品費");
    expect(screen.getByRole("combobox", { name: "貸方科目" })).toHaveValue("");
    expect(screen.getByLabelText("借方税区分")).toHaveValue("PURCHASE_10");
    // 摘要・金額はそのまま
    expect(screen.getByLabelText("摘要", { exact: true })).toHaveValue("文房具");
    expect(screen.getByLabelText("金額", { exact: true })).toHaveValue("1100");
    // 登録はしていない
    expect(calls.some((c) => c.method === "POST" && c.path === `${ENTITY}/journals`)).toBe(false);
  });

  it("売上の科目は貸方に入る", async () => {
    setup({
      settings: EXTERNAL_ON,
      reply: () => ok({ suggestion: suggestion({ accountCode: "4010", taxCategory: "SALES_10" }) }),
    });
    const u = user();
    open();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "開発業務の入金");
    await u.type(screen.getByLabelText("金額", { exact: true }), "55000");
    await u.click(screen.getByRole("button", { name: "AI で候補を出す" }));
    await u.click(await screen.findByRole("button", { name: "入れる" }));
    expect(screen.getByRole("combobox", { name: "貸方科目" })).toHaveValue("4010 売上高");
    expect(screen.getByRole("combobox", { name: "借方科目" })).toHaveValue("");
    expect(screen.getByLabelText("貸方税区分")).toHaveValue("SALES_10");
  });

  it("区分から決められない科目（資産）は借方に入る", async () => {
    setup({
      settings: EXTERNAL_ON,
      reply: () =>
        ok({ suggestion: suggestion({ accountCode: "1020", taxCategory: "OUT_OF_SCOPE" }) }),
    });
    const u = user();
    open();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "預け入れ");
    await u.type(screen.getByLabelText("金額", { exact: true }), "1000");
    await u.click(screen.getByRole("button", { name: "AI で候補を出す" }));
    await u.click(await screen.findByRole("button", { name: "入れる" }));
    expect(screen.getByRole("combobox", { name: "借方科目" })).toHaveValue("1020 普通預金");
    expect(screen.getByRole("combobox", { name: "貸方科目" })).toHaveValue("");
  });

  it("候補なし（suggestion: null）は「候補はありません」と出し、入れるボタンを出さない", async () => {
    setup({
      settings: EXTERNAL_ON,
      reply: () => ok({ suggestion: null, reason: "AI の出力が決められた形ではありません" }),
    });
    const u = user();
    open();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "不明");
    await u.type(screen.getByLabelText("金額", { exact: true }), "300");
    await u.click(screen.getByRole("button", { name: "AI で候補を出す" }));
    expect(await screen.findByText("候補はありませんでした")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "入れる" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "借方科目" })).toHaveValue("");
  });

  it("この事業体にない科目の候補は入れられない（候補なしと同じ扱い）", async () => {
    setup({
      settings: EXTERNAL_ON,
      reply: () => ok({ suggestion: suggestion({ accountCode: "9999" }) }),
    });
    const u = user();
    open();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "不明");
    await u.type(screen.getByLabelText("金額", { exact: true }), "300");
    await u.click(screen.getByRole("button", { name: "AI で候補を出す" }));
    expect(await screen.findByText("候補はありませんでした")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "入れる" })).not.toBeInTheDocument();
  });

  it("422 AI_NOT_CONFIGURED はエラーを出し、欄は変わらない", async () => {
    setup({
      settings: EXTERNAL_ON,
      reply: () => apiError(422, "AI_NOT_CONFIGURED", "外部の AI が有効ではありません"),
    });
    const u = user();
    open();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "文房具");
    await u.type(screen.getByLabelText("金額", { exact: true }), "1100");
    await u.click(screen.getByRole("button", { name: "AI で候補を出す" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("外部の AI が有効ではありません");
    expect(screen.queryByRole("button", { name: "入れる" })).not.toBeInTheDocument();
  });

  it("候補を出した後に摘要や金額を変えると、古い候補は消える", async () => {
    setup({ settings: EXTERNAL_ON, reply: () => ok({ suggestion: suggestion() }) });
    const u = user();
    open();
    await u.type(await screen.findByLabelText("摘要", { exact: true }), "文房具");
    await u.type(screen.getByLabelText("金額", { exact: true }), "1100");
    await u.click(screen.getByRole("button", { name: "AI で候補を出す" }));
    await screen.findByRole("button", { name: "入れる" });
    await u.type(screen.getByLabelText("摘要", { exact: true }), "代");
    expect(screen.queryByRole("button", { name: "入れる" })).not.toBeInTheDocument();
  });
});
