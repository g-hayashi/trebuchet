import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as LayoutRoute } from "@/routes/e/$entityId/route";
import { Route as StatementsRoute } from "@/routes/e/$entityId/statements/index";
import { account, ENTITY as BASE, uuid } from "../fixtures";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US2: 明細の一覧・候補の確認と承認・まとめて承認・除外・結びつき（H:§4.1〜§4.9）

const asset = { category: "asset", normalSide: "debit", reportSection: "BS_ASSET" } as const;
const BANK = account(1020, "普通預金", asset);
const CASH = account(1010, "現金", asset);
const SUPPLIES = account(6010, "消耗品費", {
  category: "expense",
  normalSide: "debit",
  reportSection: "PL_EXPENSE",
});
const ACCOUNTS = [CASH, BANK, SUPPLIES];

const STATEMENT_ACCOUNT = {
  id: uuid(7000),
  name: "サンプル銀行",
  usage: "business",
  kind: "bank",
  accountId: BANK.id,
  subAccountId: null,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const CARD_ACCOUNT = { ...STATEMENT_ACCOUNT, id: uuid(7001), name: "テストカードA", kind: "card" };

const SETTINGS = {
  bulkThreshold: 80,
  externalThreshold: 60,
  updatedAt: "2026-10-26T00:00:00.000Z",
};

type StatementOver = Record<string, unknown>;
const statement = (n: number, over: StatementOver = {}) => ({
  id: uuid(n),
  date: "2026-05-10",
  amount: -1200,
  content: "文房具",
  accountName: "サンプル銀行",
  usage: "business",
  status: "unprocessed",
  changed: null,
  candidate: null,
  links: [],
  ...over,
});

const transferDraft = {
  date: "2026-05-10",
  memo: "口座間の移動",
  lines: [
    { side: "debit", accountId: CASH.id, amount: 5000, taxCategory: "OUT_OF_SCOPE" },
    { side: "credit", accountId: BANK.id, amount: 5000, taxCategory: "OUT_OF_SCOPE" },
  ],
};
const transferCandidate = {
  method: "transfer",
  purpose: "business",
  confidence: 95,
  reason: "振替の対（テストカードA 2026-05-10）",
  draft: transferDraft,
};
const noneCandidate = {
  method: "none",
  purpose: null,
  confidence: null,
  reason: "既存の仕訳・振替の対に一致しません",
  draft: null,
};

const journalLine = (id: number, side: "debit" | "credit", accountId: string, amount: number) => ({
  id: uuid(id),
  lineNo: 1,
  side,
  accountId,
  subAccountId: null,
  amount,
  taxCategory: "OUT_OF_SCOPE",
  taxAmount: 0,
  partnerId: null,
  description: null,
  tagIds: [],
});
const EXISTING = {
  id: uuid(9001),
  journalNo: 3,
  date: "2026-05-11",
  fiscalPeriodId: "p2026",
  memo: "家賃",
  status: "active",
  correctsJournalId: null,
  source: "manual",
  version: 1,
  createdAt: "2026-10-31T09:00:00.000Z",
  updatedAt: "2026-10-31T09:00:00.000Z",
  lines: [
    journalLine(9101, "debit", SUPPLIES.id, 80_000),
    journalLine(9102, "credit", BANK.id, 80_000),
  ],
};
const matchCandidate = {
  method: "match",
  purpose: "business",
  confidence: 92,
  reason: "既存の仕訳 No.3（日付の差 1 日）と一致",
  draft: null,
  match: { journalId: EXISTING.id, lineId: uuid(9102) },
};

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === `${BASE}${path}`);

/** 画面が読む API。`statements` は呼ばれるたびに現在の配列を返す（承認の後の読み直しを見るため） */
function openApi(
  initial: ReturnType<typeof statement>[],
  extra: Record<string, Parameters<typeof mockApi>[0][string]> = {},
) {
  const state = { statements: initial };
  const all = mockApi({
    [`GET ${BASE}/accounts`]: () => ok({ accounts: ACCOUNTS }),
    [`GET ${BASE}/partners`]: () => ok({ partners: [] }),
    [`GET ${BASE}/tags`]: () => ok({ tags: [] }),
    [`GET ${BASE}/tax-settings`]: () =>
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
    [`GET ${BASE}/tax-categories`]: () =>
      ok({ taxCategories: [{ code: "OUT_OF_SCOPE", name: "対象外", kind: null }], taxRates: [] }),
    [`GET ${BASE}/statement-accounts`]: () => ok({ accounts: [STATEMENT_ACCOUNT, CARD_ACCOUNT] }),
    [`GET ${BASE}/statement-settings`]: () => ok({ settings: SETTINGS }),
    [`GET ${BASE}/statements`]: () => ok({ statements: state.statements }),
    [`GET ${BASE}/journals`]: () => ok({ journals: [EXISTING], nextCursor: null }),
    ...extra,
  });
  return { all, state };
}

const renderStatements = (search = "") =>
  renderRoute(StatementsRoute, {
    path: "/e/$entityId/statements/",
    url: `/e/e1/statements${search}`,
  });

const user = () => userEvent.setup();
/** 未処理は確認の表（ReviewTable）、ほかの状態は一覧の表（StatementList） */
const table = async () => screen.findByRole("table", { name: /^(明細の一覧|未処理の明細)$/ });
const rowOf = async (text: RegExp | string) =>
  within(await table()).getByRole("row", { name: text });
const editor = async () => screen.findByRole("region", { name: "候補の確認" });
/** 画面の主な操作（variant="default"）のボタンの名前 */
const primaryButtons = () =>
  screen
    .queryAllByRole("button")
    .filter((b) => b.className.split(" ").includes("bg-primary"))
    .map((b) => b.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+09:00"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("明細の一覧（H:§4.1）", () => {
  it("既定は未処理で、確認の表（行を選んで承認・除外）を出す。一覧の表（状態・判定・根拠）は出さない", async () => {
    const { all } = openApi([
      statement(1, { candidate: transferCandidate, amount: -5000, content: "口座間の移動" }),
    ]);
    renderStatements();

    expect(await screen.findByRole("table", { name: "未処理の明細" })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "明細の一覧" })).not.toBeInTheDocument();
    expect(calls(all, "GET", "/statements")[0]?.query).toEqual({ status: "unprocessed" });
  });

  it("未処理の確認の表にも、重複の疑いと変更ありの印を出す", async () => {
    openApi([
      statement(1, { content: "筆記具", duplicateOf: [uuid(2)] }),
      statement(2, {
        content: "書類",
        changed: { before: { amount: -1200 }, after: { amount: -1300 } },
      }),
    ]);
    renderStatements();
    expect(await rowOf(/筆記具/)).toHaveTextContent("重複の疑い");
    expect(await rowOf(/書類/)).toHaveTextContent("変更あり");
  });

  it("状態が未処理以外のとき（「すべて」）は一覧の表で、日付・口座・内容・金額・状態・判定・確信度・根拠を出す", async () => {
    const { all } = openApi([
      statement(1, { candidate: transferCandidate, amount: -5000, content: "口座間の移動" }),
      statement(2, { candidate: noneCandidate }),
    ]);
    const u = user();
    renderStatements();
    await u.selectOptions(await screen.findByLabelText("状態"), "すべて");
    await screen.findByRole("table", { name: "明細の一覧" });

    const transfer = await rowOf(/口座間の移動/);
    expect(transfer).toHaveTextContent("2026-05-10");
    expect(transfer).toHaveTextContent("サンプル銀行");
    expect(transfer).toHaveTextContent("-5,000");
    expect(transfer).toHaveTextContent("未処理");
    expect(transfer).toHaveTextContent("振替の対");
    expect(transfer).toHaveTextContent("95");
    expect(transfer).toHaveTextContent("振替の対（テストカードA 2026-05-10）");
    expect(await rowOf(/文房具/)).toHaveTextContent("候補なし");
    expect(calls(all, "GET", "/statements")[0]?.query).toEqual({ status: "unprocessed" });
  });

  it("URL の status（ホームの押し先。011 T009）で絞り込んで開く。省略は未処理", async () => {
    const { all } = openApi([statement(1)]);
    renderStatements("?status=changed");
    await table();
    expect(calls(all, "GET", "/statements")[0]?.query).toEqual({ status: "changed" });
    expect(screen.getByLabelText("状態")).toHaveValue("changed");
  });

  it("状態と口座で絞り込む（status・accountId を付けて読み直す）", async () => {
    const { all } = openApi([statement(1)]);
    const u = user();
    renderStatements();
    await table();

    await u.selectOptions(screen.getByLabelText("状態"), "登録済み");
    await waitFor(() =>
      expect(calls(all, "GET", "/statements").at(-1)?.query).toEqual({ status: "registered" }),
    );
    await u.selectOptions(screen.getByLabelText("口座"), "テストカードA");
    await waitFor(() =>
      expect(calls(all, "GET", "/statements").at(-1)?.query).toEqual({
        status: "registered",
        accountId: CARD_ACCOUNT.id,
      }),
    );
    await u.selectOptions(screen.getByLabelText("状態"), "すべて");
    await waitFor(() =>
      expect(calls(all, "GET", "/statements").at(-1)?.query).toEqual({
        accountId: CARD_ACCOUNT.id,
      }),
    );
  });

  it("仕訳の詳細から statementId つきで開くと、状態は「すべて」で、その明細に印を付ける", async () => {
    const { all } = openApi([
      statement(1, { status: "registered", links: [{ journalId: EXISTING.id, kind: "created" }] }),
      statement(2, { content: "別の明細" }),
    ]);
    renderStatements(`?statementId=${uuid(1)}`);

    const marked = await rowOf(/文房具/);
    expect(marked).toHaveAttribute("aria-current", "true");
    expect(await rowOf(/別の明細/)).not.toHaveAttribute("aria-current");
    expect(calls(all, "GET", "/statements")[0]?.query).toEqual({});
  });

  it("重複の疑いと変更ありを示す。変更ありは変更前後を出し、「確認した」で確認の印を書く", async () => {
    const changed = {
      before: { content: "文房具", amount: -1200 },
      after: { content: "文房具（店名変更）", amount: -1300 },
    };
    const { all, state } = openApi(
      [
        statement(1, { content: "筆記具", duplicateOf: [uuid(2)] }),
        statement(2, { content: "書類", changed }),
      ],
      {
        [`POST ${BASE}/statements/${uuid(2)}/acknowledge-change`]: () => {
          state.statements = [
            statement(1, { content: "筆記具", duplicateOf: [uuid(2)] }),
            statement(2, { content: "書類" }),
          ];
          return ok({ statement: statement(2, { content: "書類" }) });
        },
      },
    );
    const u = user();
    // 「確認した」は一覧の表（変更ありの絞り込み）にある
    renderStatements("?status=changed");

    expect(await rowOf(/筆記具/)).toHaveTextContent("重複の疑い");
    const row = await rowOf(/書類/);
    expect(row).toHaveTextContent("変更あり");
    expect(row).toHaveTextContent("内容: 文房具 → 文房具（店名変更）");
    expect(row).toHaveTextContent("金額: -1,200 → -1,300");

    await u.click(within(row).getByRole("button", { name: "確認した" }));
    await waitFor(() =>
      expect(calls(all, "POST", `/statements/${uuid(2)}/acknowledge-change`)).toHaveLength(1),
    );
    await waitFor(() =>
      expect(within(screen.getByRole("table")).queryByText(/変更あり/)).toBeNull(),
    );
  });

  it("明細がなければその旨を出す", async () => {
    openApi([]);
    renderStatements();
    expect(await screen.findByText("該当する明細はありません。")).toBeInTheDocument();
  });
});

describe("候補の作り直し（H:§4.2。007/R17: 一覧を開いたとき自動で 1 回。ボタンはない）", () => {
  it("未処理があれば一覧を開いたときに POST して一覧を読み直す。「候補を作る」のボタンはない", async () => {
    const { all } = openApi([statement(1)], {
      [`POST ${BASE}/statements/candidates`]: () => ok({ built: 2, needsAi: [uuid(1)] }),
    });
    renderStatements();
    await table();

    await waitFor(() => expect(calls(all, "POST", "/statements/candidates")).toHaveLength(1));
    expect(calls(all, "POST", "/statements/candidates")[0]?.body).toEqual({});
    await waitFor(() => expect(calls(all, "GET", "/statements").length).toBeGreaterThan(1));
    expect(screen.queryByRole("button", { name: "候補を作る" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "候補をもう一度作る" })).not.toBeInTheDocument();
  });
});

describe("承認（H:§4.4）", () => {
  it("候補（振替の対）の案をそのまま承認する。案の内容を出し、承認の後に一覧と仕訳を読み直す", async () => {
    const { all, state } = openApi(
      [statement(1, { candidate: transferCandidate, amount: -5000, content: "口座間の移動" })],
      {
        [`POST ${BASE}/statements/${uuid(1)}/approve`]: () => {
          state.statements = [];
          return ok(
            {
              journal: { ...EXISTING, id: uuid(9500), journalNo: 7 },
              link: { id: uuid(1) },
              pairLink: null,
              warnings: [],
            },
            201,
          );
        },
      },
    );
    const u = user();
    const { queryClient } = renderStatements();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await u.click(within(await rowOf(/口座間の移動/)).getByRole("button", { name: "詳細" }));
    const panel = await editor();
    expect(within(panel).getByLabelText("1行目の勘定科目")).toHaveValue(CASH.id);
    expect(within(panel).getByLabelText("2行目の勘定科目")).toHaveValue(BANK.id);
    expect(within(panel).getByLabelText("1行目の金額")).toHaveValue("5000");
    expect(within(panel).getByLabelText("日付")).toHaveValue("2026-05-10");

    await u.click(within(panel).getByRole("button", { name: "承認して登録" }));
    expect(await screen.findByText("承認しました（仕訳 No.7）。")).toBeInTheDocument();
    const body = calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body;
    expect(body).toMatchObject({
      draft: {
        date: "2026-05-10",
        lines: [
          { side: "debit", accountId: CASH.id, amount: 5000 },
          { side: "credit", accountId: BANK.id, amount: 5000 },
        ],
      },
    });
    expect(body).not.toHaveProperty("match");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "journals"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "reports"] });
    await waitFor(() => expect(screen.queryByRole("region", { name: "候補の確認" })).toBeNull());
    expect(await screen.findByText("該当する明細はありません。")).toBeInTheDocument();
  });

  it("候補なしの明細は、明細の口座の行を入れた案で始め、科目を選んで承認できる", async () => {
    const { all } = openApi([statement(1, { candidate: noneCandidate })], {
      [`POST ${BASE}/statements/${uuid(1)}/approve`]: () =>
        ok({ journal: { ...EXISTING, journalNo: 8 }, link: {}, pairLink: null, warnings: [] }, 201),
    });
    const u = user();
    renderStatements();

    await u.click(within(await rowOf(/文房具/)).getByRole("button", { name: "詳細" }));
    const panel = await editor();
    // 出金 1,200 円: 貸方に明細の口座、借方に相手（科目は未選択）
    expect(within(panel).getByLabelText("1行目の貸借")).toHaveValue("debit");
    expect(within(panel).getByLabelText("1行目の勘定科目")).toHaveValue("");
    expect(within(panel).getByLabelText("2行目の勘定科目")).toHaveValue(BANK.id);
    expect(within(panel).getByLabelText("2行目の金額")).toHaveValue("1200");

    await u.selectOptions(within(panel).getByLabelText("1行目の勘定科目"), "消耗品費");
    await u.click(within(panel).getByRole("button", { name: "承認して登録" }));
    expect(await screen.findByText("承認しました（仕訳 No.8）。")).toBeInTheDocument();
    expect(calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body).toMatchObject({
      draft: {
        date: "2026-05-10",
        lines: [
          { side: "debit", accountId: SUPPLIES.id, amount: 1200 },
          { side: "credit", accountId: BANK.id, amount: 1200 },
        ],
      },
    });
  });

  it("明細の口座の行の合計が明細の金額と違えば、送らずに知らせる。行を分割して合計が合えば送れる", async () => {
    const { all } = openApi([statement(1, { candidate: noneCandidate })], {
      [`POST ${BASE}/statements/${uuid(1)}/approve`]: () =>
        ok({ journal: { ...EXISTING, journalNo: 9 }, link: {}, pairLink: null, warnings: [] }, 201),
    });
    const u = user();
    renderStatements();

    await u.click(within(await rowOf(/文房具/)).getByRole("button", { name: "詳細" }));
    const panel = await editor();
    await u.selectOptions(within(panel).getByLabelText("1行目の勘定科目"), "消耗品費");
    // 両方を 1,100 円にすると貸借は合うが、明細の口座の行が 1,200 円と違う
    for (const n of [1, 2]) {
      await u.clear(within(panel).getByLabelText(`${n}行目の金額`));
      await u.type(within(panel).getByLabelText(`${n}行目の金額`), "1100");
    }
    await u.click(within(panel).getByRole("button", { name: "承認して登録" }));
    expect(
      await within(panel).findByText(/明細の口座の行の合計が明細の金額と一致しません/),
    ).toBeInTheDocument();
    expect(calls(all, "POST", `/statements/${uuid(1)}/approve`)).toHaveLength(0);

    // 明細の口座の行を 2 行（700 + 500）に分け、相手の行を 1,200 円に戻す
    await u.clear(within(panel).getByLabelText("1行目の金額"));
    await u.type(within(panel).getByLabelText("1行目の金額"), "1200");
    await u.clear(within(panel).getByLabelText("2行目の金額"));
    await u.type(within(panel).getByLabelText("2行目の金額"), "700");
    await u.click(within(panel).getByRole("button", { name: "行を追加" }));
    await u.selectOptions(within(panel).getByLabelText("3行目の貸借"), "貸方");
    await u.selectOptions(within(panel).getByLabelText("3行目の勘定科目"), "普通預金");
    await u.type(within(panel).getByLabelText("3行目の金額"), "500");
    await u.click(within(panel).getByRole("button", { name: "承認して登録" }));

    expect(await screen.findByText("承認しました（仕訳 No.9）。")).toBeInTheDocument();
    expect(calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body).toMatchObject({
      draft: {
        lines: [
          { side: "debit", accountId: SUPPLIES.id, amount: 1200 },
          { side: "credit", accountId: BANK.id, amount: 700 },
          { side: "credit", accountId: BANK.id, amount: 500 },
        ],
      },
    });
  });

  describe("推定ルールの学習の指定（US3。H:§4.4 の learn・purpose・partnerId）", () => {
    const PARTNER = {
      id: uuid(500),
      name: "取引先A",
      honorific: null,
      memo: null,
      isActive: true,
    };
    const approveReply = (extra: Record<string, unknown> = {}) =>
      ok(
        {
          journal: { ...EXISTING, journalNo: 7 },
          link: {},
          pairLink: null,
          warnings: [],
          ...extra,
        },
        201,
      );
    const openForApproval = (extra: Record<string, unknown> = {}) =>
      openApi([statement(1, { candidate: transferCandidate, amount: -5000 })], {
        [`GET ${BASE}/partners`]: () => ok({ partners: [PARTNER] }),
        [`POST ${BASE}/statements/${uuid(1)}/approve`]: () => approveReply(extra),
      });
    const openPanel = async (u: ReturnType<typeof user>) => {
      await u.click(within(await rowOf(/文房具/)).getByRole("button", { name: "詳細" }));
      return editor();
    };

    it("承認のたびに学ぶ。チェックはなく、何も指定しなければ learn・purpose・partnerId を送らない", async () => {
      const { all } = openForApproval();
      const u = user();
      renderStatements();
      const panel = await openPanel(u);

      expect(
        within(panel).queryByRole("checkbox", { name: "この承認からルールを学ぶ" }),
      ).not.toBeInTheDocument();
      expect(within(panel).getByLabelText("判定（ルールに記憶）")).toHaveValue("");
      expect(within(panel).getByLabelText("取引先（ルールに記憶）")).toHaveValue("");
      await u.click(within(panel).getByRole("button", { name: "承認して登録" }));
      await screen.findByText("承認しました（仕訳 No.7）。");
      const body = calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body;
      expect(body).not.toHaveProperty("learn");
      expect(body).not.toHaveProperty("purpose");
      expect(body).not.toHaveProperty("partnerId");
    });

    it("判定（事業／私用）と取引先を選ぶと、purpose・partnerId を送る", async () => {
      const { all } = openForApproval();
      const u = user();
      renderStatements();
      const panel = await openPanel(u);

      await u.selectOptions(within(panel).getByLabelText("判定（ルールに記憶）"), "私用");
      await u.selectOptions(within(panel).getByLabelText("取引先（ルールに記憶）"), "取引先A");
      await u.click(within(panel).getByRole("button", { name: "承認して登録" }));
      await screen.findByText("承認しました（仕訳 No.7）。");
      const body = calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body;
      expect(body).toMatchObject({ purpose: "private", partnerId: PARTNER.id });
      expect(body).not.toHaveProperty("learn");
    });

    it("ルールを学んだときは、承認の知らせに確信度を添える", async () => {
      openForApproval({
        rule: { id: uuid(600), hits: 2, overrides: 0, confidence: 70, status: "active" },
      });
      const u = user();
      renderStatements();
      const panel = await openPanel(u);

      await u.click(within(panel).getByRole("button", { name: "承認して登録" }));
      expect(
        await screen.findByText(/承認しました（仕訳 No\.7）。.*ルールを学びました（確信度 70）。/),
      ).toBeInTheDocument();
    });

    it("既存の仕訳と結びつけるときは、ルールの指定を出さず、learn も送らない", async () => {
      const { all } = openApi(
        [statement(1, { amount: -80_000, content: "家賃", candidate: matchCandidate })],
        {
          [`POST ${BASE}/statements/${uuid(1)}/approve`]: () =>
            ok({ journal: null, link: {}, pairLink: null, warnings: [] }, 201),
        },
      );
      const u = user();
      renderStatements();
      await u.click(within(await rowOf(/家賃/)).getByRole("button", { name: "詳細" }));
      const panel = await editor();

      expect(
        within(panel).queryByRole("checkbox", { name: "この承認からルールを学ぶ" }),
      ).not.toBeInTheDocument();
      await u.click(within(panel).getByRole("button", { name: "結びつけて承認" }));
      await screen.findByText("既存の仕訳に結びつけました。");
      expect(calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body).not.toHaveProperty(
        "learn",
      );
    });
  });

  it("API のエラー（締め済みの年度）は案の画面に出し、承認の記録は出さない", async () => {
    openApi([statement(1, { candidate: transferCandidate, amount: -5000 })], {
      [`POST ${BASE}/statements/${uuid(1)}/approve`]: () =>
        apiError(409, "PERIOD_CLOSED", "2026 年度は締め済みです", { fiscalYear: 2026 }),
    });
    const u = user();
    renderStatements();

    await u.click(within(await rowOf(/文房具/)).getByRole("button", { name: "詳細" }));
    const panel = await editor();
    await u.click(within(panel).getByRole("button", { name: "承認して登録" }));
    expect(await within(panel).findByText("2026 年度は締め済みです")).toBeInTheDocument();
    expect(screen.queryByText(/承認しました/)).not.toBeInTheDocument();
  });

  it("match の候補は、結びつけ先の行を選んだ状態で始まり、既存の仕訳に結びつけて承認する", async () => {
    const { all } = openApi(
      [statement(1, { amount: -80_000, content: "家賃", candidate: matchCandidate })],
      {
        [`POST ${BASE}/statements/${uuid(1)}/approve`]: () =>
          ok({ journal: null, link: { kind: "matched" }, pairLink: null, warnings: [] }, 201),
      },
    );
    const u = user();
    renderStatements();

    await u.click(within(await rowOf(/家賃/)).getByRole("button", { name: "詳細" }));
    const panel = await editor();
    expect(within(panel).getByRole("radio", { name: "既存の仕訳と結びつける" })).toBeChecked();
    const target = within(panel).getByRole("radio", { name: /仕訳 No\.3.*普通預金.*80,000/ });
    expect(target).toBeChecked();
    // 同じ向き・同じ金額の行だけを選べる（借方の消耗品費の行は出ない）
    expect(within(panel).queryByRole("radio", { name: /消耗品費/ })).not.toBeInTheDocument();
    // 日付の前後 7 日の仕訳を探す
    expect(calls(all, "GET", "/journals")[0]?.query).toMatchObject({
      dateFrom: "2026-05-03",
      dateTo: "2026-05-17",
    });

    await u.click(within(panel).getByRole("button", { name: "結びつけて承認" }));
    expect(await screen.findByText("既存の仕訳に結びつけました。")).toBeInTheDocument();
    expect(calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body).toEqual({
      match: { journalId: EXISTING.id, lineId: uuid(9102) },
    });
  });

  it("候補なしの明細でも「既存の仕訳と結びつける」を選んで結びつけられる（行を選ぶまで押せない）", async () => {
    const { all } = openApi(
      [statement(1, { amount: -80_000, content: "家賃", candidate: noneCandidate })],
      {
        [`POST ${BASE}/statements/${uuid(1)}/approve`]: () =>
          ok({ journal: null, link: { kind: "matched" }, pairLink: null, warnings: [] }, 201),
      },
    );
    const u = user();
    renderStatements();

    await u.click(within(await rowOf(/家賃/)).getByRole("button", { name: "詳細" }));
    const panel = await editor();
    expect(within(panel).getByRole("radio", { name: "仕訳を登録する" })).toBeChecked();
    await u.click(within(panel).getByRole("radio", { name: "既存の仕訳と結びつける" }));
    const submit = within(panel).getByRole("button", { name: "結びつけて承認" });
    expect(submit).toBeDisabled();
    await u.click(await within(panel).findByRole("radio", { name: /仕訳 No\.3.*普通預金/ }));
    await u.click(submit);

    expect(await screen.findByText("既存の仕訳に結びつけました。")).toBeInTheDocument();
    expect(calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body).toEqual({
      match: { journalId: EXISTING.id, lineId: uuid(9102) },
    });
  });

  it("結びつけ先の行に別の明細があれば（JOURNAL_LINE_ALREADY_LINKED）そのメッセージを出す", async () => {
    openApi([statement(1, { amount: -80_000, content: "家賃", candidate: matchCandidate })], {
      [`POST ${BASE}/statements/${uuid(1)}/approve`]: () =>
        apiError(409, "JOURNAL_LINE_ALREADY_LINKED", "その仕訳の行には別の明細が結びついています"),
    });
    const u = user();
    renderStatements();

    await u.click(within(await rowOf(/家賃/)).getByRole("button", { name: "詳細" }));
    const panel = await editor();
    await u.click(within(panel).getByRole("button", { name: "結びつけて承認" }));
    expect(
      await within(panel).findByText("その仕訳の行には別の明細が結びついています"),
    ).toBeInTheDocument();
  });

  it("一覧の中の確認を開いたとき、画面の主な操作（variant=default）は「承認して登録」だけ", async () => {
    openApi([statement(1, { candidate: transferCandidate })]);
    const u = user();
    renderStatements();
    await u.click(within(await rowOf(/文房具/)).getByRole("button", { name: "詳細" }));
    await editor();
    await screen.findByRole("button", { name: "承認して登録" });
    expect(primaryButtons()).toEqual(["承認して登録"]);
  });

  it("閉じるで確認の画面を閉じる", async () => {
    openApi([statement(1, { candidate: noneCandidate })]);
    const u = user();
    renderStatements();
    await u.click(within(await rowOf(/文房具/)).getByRole("button", { name: "詳細" }));
    await u.click(within(await editor()).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("region", { name: "候補の確認" })).not.toBeInTheDocument();
  });
});

describe("しきい値の表示（011 FR-024。007/R17: 補助の「確信度の高い行を選択」だけ）", () => {
  it("一覧の画面に、しきい値の数字・設定への案内は出さない（明細の設定にだけ置く）", async () => {
    openApi([statement(1, { content: "口座間の移動", candidate: transferCandidate })]);
    renderStatements();
    await screen.findByRole("button", { name: "確信度の高い行を選択" });
    expect(screen.queryByText(/しきい値/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /しきい値/ })).not.toBeInTheDocument();
  });
});

describe("除外・除外の取消・結びつきを外す（H:§4.6・§4.7・§4.9）", () => {
  it("除外は理由なしで exclude-bulk に送り、除外した明細は一覧から消える", async () => {
    const { all, state } = openApi([statement(1)], {
      [`POST ${BASE}/statements/exclude-bulk`]: () => {
        state.statements = [];
        return ok({ excluded: [uuid(1)], failed: [] });
      },
    });
    const u = user();
    renderStatements();

    await u.click(within(await rowOf(/文房具/)).getByRole("button", { name: "除外" }));
    expect(await screen.findByText("該当する明細はありません。")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/exclude-bulk")[0]?.body).toEqual({
      statementIds: [uuid(1)],
    });
  });

  it("一覧の表（「すべて」）の未処理の行は、「確認する」で候補の確認を開ける", async () => {
    openApi([statement(1, { candidate: noneCandidate })]);
    const u = user();
    renderStatements();
    await u.selectOptions(await screen.findByLabelText("状態"), "すべて");
    await screen.findByRole("table", { name: "明細の一覧" });

    await u.click(within(await rowOf(/文房具/)).getByRole("button", { name: "確認する" }));
    expect(await editor()).toBeInTheDocument();
  });

  it("除外の取消は理由を求め、理由つきで送る", async () => {
    const { all } = openApi([statement(1, { status: "excluded" })], {
      [`POST ${BASE}/statements/${uuid(1)}/unexclude`]: () => ok({ statement: statement(1) }),
    });
    const u = user();
    renderStatements();
    await u.selectOptions(await screen.findByLabelText("状態"), "除外");

    await u.click(within(await rowOf(/文房具/)).getByRole("button", { name: "除外を取り消す" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "除外を取り消す" })).toBeDisabled();
    await u.type(within(dialog).getByLabelText("理由"), "必要な支出だった");
    await u.click(within(dialog).getByRole("button", { name: "除外を取り消す" }));

    await waitFor(() =>
      expect(calls(all, "POST", `/statements/${uuid(1)}/unexclude`)[0]?.body).toEqual({
        reason: "必要な支出だった",
      }),
    );
  });

  it("既存の仕訳との結びつき（matched）は理由つきで外せる。登録した仕訳（created）は外せず、仕訳へのリンクだけ", async () => {
    const { all } = openApi(
      [
        statement(1, {
          status: "registered",
          content: "家賃",
          links: [{ journalId: EXISTING.id, kind: "matched" }],
        }),
        statement(2, {
          status: "registered",
          content: "文房具",
          links: [{ journalId: uuid(9002), kind: "created" }],
        }),
      ],
      { [`POST ${BASE}/statements/${uuid(1)}/unlink`]: () => ok({ statement: statement(1) }) },
    );
    const u = user();
    renderStatements();
    await u.selectOptions(await screen.findByLabelText("状態"), "登録済み");

    const created = await rowOf(/文房具/);
    expect(within(created).queryByRole("button", { name: "結びつきを外す" })).toBeNull();
    expect(within(created).getByRole("link", { name: "仕訳を開く" })).toHaveAttribute(
      "href",
      `/e/e1/journals/${uuid(9002)}`,
    );

    const matched = await rowOf(/家賃/);
    await u.click(within(matched).getByRole("button", { name: "結びつきを外す" }));
    const dialog = await screen.findByRole("dialog");
    await u.type(within(dialog).getByLabelText("理由"), "別の取引だった");
    await u.click(within(dialog).getByRole("button", { name: "結びつきを外す" }));
    await waitFor(() =>
      expect(calls(all, "POST", `/statements/${uuid(1)}/unlink`)[0]?.body).toEqual({
        reason: "別の取引だった",
      }),
    );
  });
});

describe("メニュー", () => {
  it("事業体のメニューの「明細」は、明細の取込（最初の項目）へ進む", async () => {
    mockApi({ "GET /api/entities": () => ok({ entities: [] }) });
    renderRoute(LayoutRoute, { path: "/e/$entityId", url: "/e/e1" });
    const nav = await screen.findByRole("navigation", { name: "事業体のメニュー" });
    expect(within(nav).getByRole("link", { name: "明細" })).toHaveAttribute(
      "href",
      "/e/e1/statements/import",
    );
    // 2 段目の「一覧と確認」は明細の画面にいるときだけ出る（entity-nav.test.tsx）
    expect(within(nav).queryByRole("link", { name: "一覧と確認" })).toBeNull();
  });

  it("一覧に「明細を取り込む」「推定のルール」「1 件ずつ確認する」「しきい値の設定」への導線は置かない（左のメニューから開く）", async () => {
    openApi([]);
    renderStatements();
    await screen.findByText("該当する明細はありません。");
    expect(screen.queryByRole("link", { name: "明細を取り込む" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "1 件ずつ確認する" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "しきい値の設定" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "推定のルール" })).not.toBeInTheDocument();
  });
});
