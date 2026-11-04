import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route as StatementsRoute } from "@/routes/e/$entityId/statements/index";
import { Route as RulesRoute } from "@/routes/e/$entityId/statements/rules";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US3: 推定のルールの一覧・編集・停止・再開・履歴・初期作成（H:§5）

const BASE = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

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
const expense = { category: "expense", normalSide: "debit", reportSection: "PL_EXPENSE" } as const;
const SUPPLIES = account(6010, "消耗品費", expense);
const RENT = account(6020, "地代家賃", expense);
const PAYABLE = account(2020, "未払金", {
  category: "liability",
  normalSide: "credit",
  reportSection: "BS_LIABILITY",
});
const ACCOUNTS = [SUPPLIES, RENT, PAYABLE];
const PARTNER = { id: uuid(500), name: "取引先A", honorific: null, memo: null, isActive: true };
const STATEMENT_ACCOUNT = {
  id: uuid(7000),
  name: "サンプル銀行",
  usage: "business",
  kind: "bank",
  accountId: uuid(1020),
  subAccountId: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

const rule = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  normalizedContent: "ショップ#",
  statementAccountId: null,
  counterAccountId: SUPPLIES.id,
  counterSubAccountId: null,
  partnerId: null,
  taxCategory: "OUT_OF_SCOPE",
  purpose: "business",
  descriptionTemplate: null,
  hits: 3,
  overrides: 1,
  confidence: 60,
  status: "active",
  origin: "approval",
  managedBy: "auto",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  ...over,
});

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === `${BASE}${path}`);

/** 画面が読む API。`rules` は呼ばれるたびに現在の配列を返す */
function openApi(
  initial: ReturnType<typeof rule>[],
  extra: Record<string, Parameters<typeof mockApi>[0][string]> = {},
) {
  const state = { rules: initial };
  const all = mockApi({
    [`GET ${BASE}/accounts`]: () => ok({ accounts: ACCOUNTS }),
    [`GET ${BASE}/partners`]: () => ok({ partners: [PARTNER] }),
    [`GET ${BASE}/tax-categories`]: () =>
      ok({
        taxCategories: [
          { code: "OUT_OF_SCOPE", name: "対象外", kind: null },
          { code: "PURCHASE_10", name: "課税仕入 10%", kind: "purchase" },
        ],
        taxRates: [],
      }),
    [`GET ${BASE}/statement-accounts`]: () => ok({ accounts: [STATEMENT_ACCOUNT] }),
    [`GET ${BASE}/inference-rules`]: (call) =>
      ok({
        rules: state.rules.filter(
          (r) => call.query.status === undefined || r.status === call.query.status,
        ),
      }),
    ...extra,
  });
  return { all, state };
}

const renderRules = () =>
  renderRoute(RulesRoute, { path: "/e/$entityId/statements/rules", url: "/e/e1/statements/rules" });

const user = () => userEvent.setup();
const table = async () => screen.findByRole("table", { name: "ルールの一覧" });
const rowOf = async (text: RegExp | string) =>
  within(await table()).getByRole("row", { name: text });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ルールの一覧（H:§5.1）", () => {
  it("内容・口座・相手の科目・判定・取引先・確信度・適用と修正の回数・状態を出す", async () => {
    openApi([
      rule(1, { partnerId: PARTNER.id, statementAccountId: STATEMENT_ACCOUNT.id }),
      rule(2, { normalizedContent: "別の店", purpose: "private", status: "paused", confidence: 0 }),
    ]);
    renderRules();

    const first = await rowOf(/ショップ#/);
    expect(first).toHaveTextContent("サンプル銀行");
    expect(first).toHaveTextContent("消耗品費");
    expect(first).toHaveTextContent("事業");
    expect(first).toHaveTextContent("取引先A");
    expect(first).toHaveTextContent("60");
    expect(first).toHaveTextContent("3 回");
    expect(first).toHaveTextContent("修正 1 回");
    expect(first).toHaveTextContent("有効");
    const second = await rowOf(/別の店/);
    expect(second).toHaveTextContent("すべての口座");
    expect(second).toHaveTextContent("私用");
    expect(second).toHaveTextContent("停止中");
  });

  it("自動で作ったルールと利用者が直したルールを区別して出す（FR-023）", async () => {
    openApi([
      rule(1, { managedBy: "auto" }),
      rule(2, { normalizedContent: "別の店", managedBy: "user" }),
    ]);
    renderRules();

    const auto = await rowOf(/ショップ#/);
    expect(within(auto).getByText("自動")).toBeInTheDocument();
    expect(auto).not.toHaveTextContent("利用者が直した");
    const user = await rowOf(/別の店/);
    expect(within(user).getByText("利用者が直した")).toBeInTheDocument();
    expect(user).not.toHaveTextContent("自動");
    // 一覧の見出しにも「作り方」の列がある
    expect(within(await table()).getByRole("columnheader", { name: "管理" })).toBeInTheDocument();
  });

  it("ルールを直す・止めると利用者が直した印に変わる（サーバーが managedBy を user にする）", async () => {
    const { state } = openApi([rule(1)], {
      [`POST ${BASE}/inference-rules/${uuid(1)}/pause`]: () => {
        state.rules = [rule(1, { status: "paused", managedBy: "user" })];
        return ok({ rule: state.rules[0] });
      },
    });
    const u = userEvent.setup();
    renderRules();

    expect(within(await rowOf(/ショップ#/)).getByText("自動")).toBeInTheDocument();
    await u.click(within(await rowOf(/ショップ#/)).getByRole("button", { name: "停止" }));
    await waitFor(async () =>
      expect(within(await rowOf(/ショップ#/)).getByText("利用者が直した")).toBeInTheDocument(),
    );
  });

  it("ルールは承認のたびに自動で作る・更新すると案内し、利用者が直したルールは上書きしないと伝える", async () => {
    openApi([rule(1)]);
    renderRules();
    await table();
    expect(screen.getByText(/承認のたびに自動で作る・更新します/)).toBeInTheDocument();
    expect(screen.getByText(/直した・止めたルールは自動では変わりません/)).toBeInTheDocument();
  });

  it("状態で絞り込む（status を付けて読み直す）。ルールがなければその旨を出す", async () => {
    const { all } = openApi([rule(1)]);
    const u = user();
    renderRules();
    await table();
    expect(calls(all, "GET", "/inference-rules")[0]?.query).toEqual({});

    await u.selectOptions(screen.getByLabelText("状態"), "停止中");
    expect(await screen.findByText("該当するルールはありません。")).toBeInTheDocument();
    expect(calls(all, "GET", "/inference-rules").at(-1)?.query).toEqual({ status: "paused" });
  });

  it("API のエラーを表示する", async () => {
    openApi([], {
      [`GET ${BASE}/inference-rules`]: () => apiError(400, "VALIDATION", "読み込みに失敗しました"),
    });
    renderRules();
    expect(await screen.findByText("読み込みに失敗しました")).toBeInTheDocument();
  });
});

describe("停止・再開（H:§5.4）", () => {
  it("有効なルールは「停止」、停止中は「再開」。押すと POST して一覧を読み直す", async () => {
    const { all, state } = openApi([rule(1)], {
      [`POST ${BASE}/inference-rules/${uuid(1)}/pause`]: () => {
        state.rules = [rule(1, { status: "paused" })];
        return ok({ rule: state.rules[0] });
      },
      [`POST ${BASE}/inference-rules/${uuid(1)}/resume`]: () => {
        state.rules = [rule(1)];
        return ok({ rule: state.rules[0] });
      },
    });
    const u = user();
    renderRules();

    await u.click(within(await rowOf(/ショップ#/)).getByRole("button", { name: "停止" }));
    await waitFor(async () => expect(await rowOf(/ショップ#/)).toHaveTextContent("停止中"));
    expect(calls(all, "POST", `/inference-rules/${uuid(1)}/pause`)).toHaveLength(1);

    await u.click(within(await rowOf(/ショップ#/)).getByRole("button", { name: "再開" }));
    await waitFor(async () => expect(await rowOf(/ショップ#/)).toHaveTextContent("有効"));
    expect(calls(all, "POST", `/inference-rules/${uuid(1)}/resume`)).toHaveLength(1);
  });

  it("停止・再開の API のエラーを表示する", async () => {
    openApi([rule(1)], {
      [`POST ${BASE}/inference-rules/${uuid(1)}/pause`]: () =>
        apiError(404, "INFERENCE_RULE_NOT_FOUND", "ルールが見つかりません"),
    });
    const u = user();
    renderRules();
    await u.click(within(await rowOf(/ショップ#/)).getByRole("button", { name: "停止" }));
    expect(await screen.findByText("ルールが見つかりません")).toBeInTheDocument();
  });
});

describe("編集（H:§5.3）", () => {
  it("現在の内容で始まり、直した項目を PATCH で送って一覧を読み直す", async () => {
    const { all, state } = openApi([rule(1)], {
      [`PATCH ${BASE}/inference-rules/${uuid(1)}`]: () => {
        state.rules = [rule(1, { counterAccountId: RENT.id, purpose: "private" })];
        return ok({ rule: state.rules[0] });
      },
    });
    const u = user();
    renderRules();

    await u.click(within(await rowOf(/ショップ#/)).getByRole("button", { name: "編集" }));
    const panel = await screen.findByRole("region", { name: "ルールの編集" });
    expect(within(panel).getByLabelText("相手の科目")).toHaveValue(SUPPLIES.id);
    expect(within(panel).getByLabelText("判定")).toHaveValue("business");
    expect(within(panel).getByLabelText("取引先")).toHaveValue("");
    expect(within(panel).getByLabelText("摘要")).toHaveValue("");

    await u.selectOptions(within(panel).getByLabelText("相手の科目"), "地代家賃");
    await u.selectOptions(within(panel).getByLabelText("判定"), "私用");
    await u.selectOptions(within(panel).getByLabelText("取引先"), "取引先A");
    await u.type(within(panel).getByLabelText("摘要"), "家賃");
    await u.click(within(panel).getByRole("button", { name: "保存" }));

    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
    expect(calls(all, "PATCH", `/inference-rules/${uuid(1)}`)[0]?.body).toEqual({
      counterAccountId: RENT.id,
      taxCategory: "OUT_OF_SCOPE",
      purpose: "private",
      partnerId: PARTNER.id,
      descriptionTemplate: "家賃",
    });
    await waitFor(async () => expect(await rowOf(/ショップ#/)).toHaveTextContent("地代家賃"));
    expect(screen.queryByRole("region", { name: "ルールの編集" })).not.toBeInTheDocument();
  });

  it("取引先を「なし」、摘要を空にすると null で送る。API のエラーは編集の中に出す", async () => {
    const { all } = openApi([rule(1, { partnerId: PARTNER.id, descriptionTemplate: "旧" })], {
      [`PATCH ${BASE}/inference-rules/${uuid(1)}`]: () =>
        apiError(422, "ACCOUNT_INACTIVE", "使用停止の科目は選べません"),
    });
    const u = user();
    renderRules();

    await u.click(within(await rowOf(/ショップ#/)).getByRole("button", { name: "編集" }));
    const panel = await screen.findByRole("region", { name: "ルールの編集" });
    await u.selectOptions(within(panel).getByLabelText("取引先"), "なし");
    await u.clear(within(panel).getByLabelText("摘要"));
    await u.click(within(panel).getByRole("button", { name: "保存" }));

    expect(await within(panel).findByText("使用停止の科目は選べません")).toBeInTheDocument();
    expect(calls(all, "PATCH", `/inference-rules/${uuid(1)}`)[0]?.body).toMatchObject({
      partnerId: null,
      descriptionTemplate: null,
    });
    expect(screen.queryByText("保存しました。")).not.toBeInTheDocument();
  });

  it("「閉じる」で編集を閉じる", async () => {
    openApi([rule(1)]);
    const u = user();
    renderRules();
    await u.click(within(await rowOf(/ショップ#/)).getByRole("button", { name: "編集" }));
    const panel = await screen.findByRole("region", { name: "ルールの編集" });
    await u.click(within(panel).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("region", { name: "ルールの編集" })).not.toBeInTheDocument();
  });
});

describe("履歴（H:§5.5）", () => {
  it("操作の種類・日時・内容の変わった項目を追記の順に出す", async () => {
    openApi([rule(1)], {
      [`GET ${BASE}/inference-rules/${uuid(1)}/history`]: () =>
        ok({
          history: [
            {
              id: uuid(81),
              ruleId: uuid(1),
              action: "create",
              before: null,
              after: rule(1, { counterAccountId: RENT.id, hits: 1, overrides: 0 }),
              statementId: uuid(5),
              at: "2026-10-20T01:00:00.000Z",
            },
            {
              id: uuid(82),
              ruleId: uuid(1),
              action: "update",
              before: rule(1, { counterAccountId: RENT.id, hits: 1, overrides: 0 }),
              after: rule(1, { counterAccountId: SUPPLIES.id, hits: 1, overrides: 1 }),
              statementId: uuid(6),
              at: "2026-10-25T01:00:00.000Z",
            },
            {
              id: uuid(83),
              ruleId: uuid(1),
              action: "pause",
              before: rule(1),
              after: rule(1, { status: "paused" }),
              statementId: null,
              at: "2026-10-26T01:00:00.000Z",
            },
          ],
        }),
    });
    const u = user();
    renderRules();

    await u.click(within(await rowOf(/ショップ#/)).getByRole("button", { name: "履歴" }));
    const panel = await screen.findByRole("region", { name: "ルールの履歴" });
    const items = await within(panel).findAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("作成");
    expect(items[0]).toHaveTextContent("2026-10-20");
    expect(items[1]).toHaveTextContent("承認で更新");
    expect(items[1]).toHaveTextContent("相手の科目: 地代家賃 → 消耗品費");
    expect(items[1]).toHaveTextContent("修正の回数: 0 → 1");
    expect(items[2]).toHaveTextContent("停止");
    expect(items[2]).toHaveTextContent("状態: 有効 → 停止中");
  });
});

describe("初期作成（H:§5.2）", () => {
  const proposal = (n: number, content: string, hits: number) =>
    rule(0, {
      id: "",
      normalizedContent: content,
      hits,
      overrides: 0,
      origin: "seed",
      confidence: 70 + n,
    });

  it("「過去の仕訳から作る」でまず案（dryRun）を出し、確かめてから作る", async () => {
    const { all, state } = openApi([], {
      [`POST ${BASE}/inference-rules/seed`]: (call) => {
        const dry = (call.body as { dryRun?: boolean }).dryRun === true;
        if (dry) {
          return ok({
            created: 2,
            skipped: 1,
            rules: [proposal(1, "ショップ#", 4), proposal(2, "テスト電力#", 12)],
          });
        }
        state.rules = [rule(1), rule(2, { normalizedContent: "テスト電力#" })];
        return ok({ created: 2, skipped: 1, rules: state.rules });
      },
    });
    const u = user();
    renderRules();
    await screen.findByText("該当するルールはありません。");

    await u.click(screen.getByRole("button", { name: "過去の仕訳から作る" }));
    const preview = await screen.findByRole("region", { name: "作成の案" });
    expect(calls(all, "POST", "/inference-rules/seed")[0]?.body).toEqual({ dryRun: true });
    expect(preview).toHaveTextContent("2 件のルールを作れます");
    expect(preview).toHaveTextContent("すでにあるルール 1 件は作りません");
    expect(preview).toHaveTextContent("ショップ#");
    expect(preview).toHaveTextContent("根拠の仕訳 4 件");
    expect(preview).toHaveTextContent("テスト電力#");
    // 案を出しただけでは作らない
    expect(calls(all, "POST", "/inference-rules/seed")).toHaveLength(1);

    await u.click(within(preview).getByRole("button", { name: "この案で作る" }));
    expect(await screen.findByText("ルールを 2 件作りました。")).toBeInTheDocument();
    expect(calls(all, "POST", "/inference-rules/seed")[1]?.body).toEqual({});
    await waitFor(async () => expect(await rowOf(/テスト電力#/)).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "作成の案" })).not.toBeInTheDocument();
  });

  it("作れるルールがなければその旨を出し、作成のボタンは出さない", async () => {
    openApi([], {
      [`POST ${BASE}/inference-rules/seed`]: () => ok({ created: 0, skipped: 0, rules: [] }),
    });
    const u = user();
    renderRules();
    await u.click(await screen.findByRole("button", { name: "過去の仕訳から作る" }));
    const preview = await screen.findByRole("region", { name: "作成の案" });
    expect(preview).toHaveTextContent("作れるルールはありません");
    expect(within(preview).queryByRole("button", { name: "この案で作る" })).not.toBeInTheDocument();
  });

  it("API のエラーを表示する", async () => {
    openApi([], {
      [`POST ${BASE}/inference-rules/seed`]: () =>
        apiError(400, "VALIDATION", "作成に失敗しました"),
    });
    const u = user();
    renderRules();
    await u.click(await screen.findByRole("button", { name: "過去の仕訳から作る" }));
    expect(await screen.findByText("作成に失敗しました")).toBeInTheDocument();
  });
});

describe("明細の一覧から", () => {
  it("明細の一覧にルールの画面へのリンクがある", async () => {
    mockApi({});
    renderRoute(StatementsRoute, { path: "/e/$entityId/statements/", url: "/e/e1/statements" });
    expect(await screen.findByRole("link", { name: "推定のルール" })).toHaveAttribute(
      "href",
      "/e/e1/statements/rules",
    );
  });
});
