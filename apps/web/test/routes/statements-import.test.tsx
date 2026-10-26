import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route as ImportRoute } from "@/routes/e/$entityId/statements/import";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US1: 明細の取込の画面（貼り付け → プレビュー → 口座の対応 → 確定。H:§2・§3.1〜§3.3）

const BASE = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SHA = "a".repeat(64);
const TEXT = "日付\t内容\t金額（円）\t保有金融機関\n05/10(日)\tショップ001\t-1,200\tサンプル銀行";

const account = (n: number, name: string, over: Partial<Account> = {}): Account => ({
  id: uuid(n),
  code: String(n),
  name,
  category: "asset",
  normalSide: "debit",
  reportSection: "BS_ASSET",
  reportLine: null,
  sortOrder: n,
  isSystem: false,
  isActive: true,
  ...over,
});
const BANK = account(1020, "普通預金");
const CASH = account(1010, "現金");

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
  unmappedAccounts: [] as string[],
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

const baseRoutes = {
  [`GET ${BASE}/accounts`]: () => ok({ accounts: [BANK, CASH] }),
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

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === `${BASE}${path}`);

const paste = async (text = TEXT) => {
  fireEvent.change(await screen.findByLabelText("貼り付けのテキスト"), { target: { value: text } });
};

describe("貼り付けとプレビュー（FR-001〜004）", () => {
  it("テキストと対象の年（既定は今年）を送り、件数・期間・合計・読めない行・明細の一覧を示す", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    expect(await screen.findByLabelText("対象の年")).toHaveValue(2026);
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));

    const summary = await screen.findByRole("region", { name: "プレビューの要約" });
    expect(calls(all, "POST", "/statements/imports/preview")[0]?.body).toEqual({
      source: { kind: "paste", text: TEXT, year: 2026 },
    });
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

  it("対象の年を変えると、その年を送る", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () => ok(PREVIEW),
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    fireEvent.change(screen.getByLabelText("対象の年"), { target: { value: "2025" } });
    await u.click(screen.getByRole("button", { name: "プレビュー" }));
    await screen.findByRole("region", { name: "プレビューの要約" });
    expect(calls(all, "POST", "/statements/imports/preview")[0]?.body).toMatchObject({
      source: { year: 2025 },
    });
  });

  it("テキストが空なら送らずに知らせる", async () => {
    const all = mockApi(baseRoutes);
    const u = userEvent.setup();
    renderImport();
    await u.click(await screen.findByRole("button", { name: "プレビュー" }));
    expect(await screen.findByText("貼り付けのテキストを入力してください")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(0);
  });

  it("読めない貼り付け（422）は、理由を示す", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () =>
        apiError(422, "STATEMENT_PASTE_UNREADABLE", "必須の列が足りません", {
          missingColumns: ["金額（円）"],
          unreadable: [],
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("貼り付けのテキストを読み取れませんでした");
    expect(alert).toHaveTextContent("見つからない列: 金額（円）");
    expect(screen.queryByRole("region", { name: "プレビューの要約" })).not.toBeInTheDocument();
  });

  it("重複の疑いと、変更ありの行（変更前後）を別に示す", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () =>
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
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));

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
  const withUnmapped = { ...PREVIEW, unmappedAccounts: ["サンプル銀行"] };

  it("未対応の口座があると対応の入力を出し、取り込めない。保存後にプレビューを作り直す", async () => {
    let mapped = false;
    const all = mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () => ok(mapped ? PREVIEW : withUnmapped),
      [`PUT ${BASE}/statement-accounts/${encodeURIComponent("サンプル銀行")}`]: () => {
        mapped = true;
        return ok({ account: ACCOUNT_VIEW("サンプル銀行"), rebuilt: 0 });
      },
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));

    const group = await screen.findByRole("group", { name: "サンプル銀行の対応" });
    expect(screen.getByRole("button", { name: "取り込む" })).toBeDisabled();
    await u.selectOptions(within(group).getByLabelText("サンプル銀行の用途"), "事業用");
    await u.selectOptions(within(group).getByLabelText("サンプル銀行の種類"), "銀行");
    await u.selectOptions(await within(group).findByLabelText("サンプル銀行の科目"), "普通預金");
    await u.click(within(group).getByRole("button", { name: "サンプル銀行の対応を保存" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "取り込む" })).toBeEnabled());
    expect(
      calls(all, "PUT", `/statement-accounts/${encodeURIComponent("サンプル銀行")}`)[0]?.body,
    ).toEqual({ usage: "business", kind: "bank", accountId: BANK.id });
    expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(2);
    expect(screen.queryByRole("group", { name: "サンプル銀行の対応" })).not.toBeInTheDocument();
  });

  it("private は科目を出さず、科目なしで送る", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () => ok(withUnmapped),
      [`PUT ${BASE}/statement-accounts/${encodeURIComponent("サンプル銀行")}`]: () =>
        ok({
          account: ACCOUNT_VIEW("サンプル銀行", { usage: "private", accountId: null }),
          rebuilt: 0,
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));
    const group = await screen.findByRole("group", { name: "サンプル銀行の対応" });
    expect(within(group).getByLabelText("サンプル銀行の科目")).toBeInTheDocument();

    await u.selectOptions(within(group).getByLabelText("サンプル銀行の用途"), "私用（帳簿の外）");
    expect(within(group).queryByLabelText("サンプル銀行の科目")).not.toBeInTheDocument();
    expect(within(group).queryByLabelText("サンプル銀行の補助科目")).not.toBeInTheDocument();
    await u.selectOptions(within(group).getByLabelText("サンプル銀行の種類"), "現金");
    await u.click(within(group).getByRole("button", { name: "サンプル銀行の対応を保存" }));
    await waitFor(() =>
      expect(
        calls(all, "PUT", `/statement-accounts/${encodeURIComponent("サンプル銀行")}`),
      ).toHaveLength(1),
    );
    expect(
      calls(all, "PUT", `/statement-accounts/${encodeURIComponent("サンプル銀行")}`)[0]?.body,
    ).toEqual({ usage: "private", kind: "cash" });
  });

  it("事業用で科目を選ばずに保存しようとすると、送らずに知らせる", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () => ok(withUnmapped),
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));
    const group = await screen.findByRole("group", { name: "サンプル銀行の対応" });
    await u.click(within(group).getByRole("button", { name: "サンプル銀行の対応を保存" }));
    expect(await within(group).findByText("科目を選んでください")).toBeInTheDocument();
    expect(all.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
});

describe("取込の確定（FR-007）", () => {
  it("プレビューのハッシュと新規の件数を添えて確定し、件数を知らせて、プレビューを閉じる", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () => ok(PREVIEW),
      [`POST ${BASE}/statements/imports`]: () =>
        ok(
          {
            batch: {
              id: uuid(1),
              origin: "paste",
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
          },
          201,
        ),
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));
    await u.click(await screen.findByRole("button", { name: "取り込む" }));

    expect(await screen.findByText("3 件を取り込みました。")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/imports")[0]?.body).toEqual({
      source: { kind: "paste", text: TEXT, year: 2026 },
      expected: { inputSha256: SHA, countNew: 3 },
    });
    expect(screen.queryByRole("region", { name: "プレビューの要約" })).not.toBeInTheDocument();
  });

  it("変更ありがあれば件数に添える", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () => ok(PREVIEW),
      [`POST ${BASE}/statements/imports`]: () => ok({ batch: {}, added: 2, changed: 1 }, 201),
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    expect(await screen.findByText("2 件を取り込みました（変更あり 1 件）。")).toBeInTheDocument();
  });

  it("新規 0 件のときは取り込めない（取込済みのみ）", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () =>
        ok({ ...PREVIEW, countNew: 0, rows: [row("k0", { status: "existing" })] }),
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));
    expect(await screen.findByRole("button", { name: "取り込む" })).toBeDisabled();
    expect(screen.getByText("新しく取り込む明細はありません。")).toBeInTheDocument();
  });

  it("409 STATEMENT_PLAN_CHANGED は知らせて、プレビューを作り直す", async () => {
    const all = mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () => ok(PREVIEW),
      [`POST ${BASE}/statements/imports`]: () =>
        apiError(409, "STATEMENT_PLAN_CHANGED", "プレビューのときと内容が違います"),
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));
    await u.click(await screen.findByRole("button", { name: "取り込む" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("プレビューを作り直しました");
    await waitFor(() => expect(calls(all, "POST", "/statements/imports/preview")).toHaveLength(2));
  });

  it("422 STATEMENT_ACCOUNT_UNMAPPED は口座の名前を示す", async () => {
    mockApi({
      ...baseRoutes,
      [`POST ${BASE}/statements/imports/preview`]: () => ok(PREVIEW),
      [`POST ${BASE}/statements/imports`]: () =>
        apiError(422, "STATEMENT_ACCOUNT_UNMAPPED", "対応づいていない保有金融機関があります", {
          names: ["サンプル銀行"],
        }),
    });
    const u = userEvent.setup();
    renderImport();
    await paste();
    await u.click(screen.getByRole("button", { name: "プレビュー" }));
    await u.click(await screen.findByRole("button", { name: "取り込む" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("サンプル銀行");
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

  it("履歴がなければその旨を示す", async () => {
    mockApi(baseRoutes);
    renderImport();
    expect(await screen.findByText("取り込んだ記録はまだありません。")).toBeInTheDocument();
  });
});

describe("メニュー", () => {
  it("取込の画面から明細の一覧へ戻れる（事業体のメニューの「明細」は一覧へ進む。statements.test.tsx）", async () => {
    mockApi(baseRoutes);
    renderImport();
    expect(await screen.findByRole("link", { name: "明細の一覧へ" })).toHaveAttribute(
      "href",
      "/e/e1/statements",
    );
  });
});
