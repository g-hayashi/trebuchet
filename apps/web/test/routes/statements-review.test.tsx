import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route as ReviewRoute } from "@/routes/e/$entityId/statements/review";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 011 US3（FR-021・024）: 明細の確認。未処理の明細を 1 件ずつ、明細と候補の仕訳を並べて、
// 「承認して次へ」（主な操作）・「飛ばす」・「除外」。まとめて承認は確認の上に置く

const BASE = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (n: number, name: string): Account => ({
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
});
const CASH = account(1010, "現金");
const BANK = account(1020, "普通預金");

const statement = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  date: "2026-05-10",
  amount: -5000,
  content: `明細${n}`,
  accountName: "サンプル銀行",
  usage: "business",
  status: "unprocessed",
  changed: null,
  candidate: null,
  links: [],
  ...over,
});
const transfer = (confidence = 95) => ({
  method: "transfer",
  purpose: "business",
  confidence,
  reason: "振替の対（テストカードA 2026-05-10）",
  draft: {
    date: "2026-05-10",
    memo: "口座間の移動",
    lines: [
      { side: "debit", accountId: CASH.id, amount: 5000, taxCategory: "OUT_OF_SCOPE" },
      { side: "credit", accountId: BANK.id, amount: 5000, taxCategory: "OUT_OF_SCOPE" },
    ],
  },
});
const matched = {
  method: "match",
  purpose: "business",
  confidence: 92,
  reason: "既存の仕訳 No.3（日付の差 1 日）と一致",
  draft: null,
  match: { journalId: uuid(9001), lineId: uuid(9102) },
};
const none = {
  method: "none",
  purpose: null,
  confidence: null,
  reason: "既存の仕訳・振替の対に一致しません",
  draft: null,
};

const approved = (journalNo = 7) =>
  ok(
    {
      journal: { id: uuid(9500), journalNo },
      link: { id: uuid(1) },
      pairLink: null,
      warnings: [],
    },
    201,
  );

const calls = (all: ApiCall[], method: string, path: string) =>
  all.filter((c) => c.method === method && c.path === `${BASE}${path}`);

type Statement = ReturnType<typeof statement>;

/** `statements` は呼ばれるたびに現在の配列を返す。承認・除外の応答で `state.statements` を減らす */
function openApi(
  initial: Statement[],
  extra: (state: {
    statements: Statement[];
  }) => Record<string, Parameters<typeof mockApi>[0][string]> = () => ({}),
) {
  const state = { statements: initial };
  const removing = (n: number, reply: () => ReturnType<typeof ok>) => () => {
    state.statements = state.statements.filter((s) => s.id !== uuid(n));
    return reply();
  };
  const all = mockApi({
    [`GET ${BASE}/accounts`]: () => ok({ accounts: [CASH, BANK] }),
    [`GET ${BASE}/statements`]: () => ok({ statements: state.statements }),
    ...Object.fromEntries(
      initial.flatMap((s, i) => [
        [`POST ${BASE}/statements/${s.id}/approve`, removing(i + 1, () => approved(i + 7))],
        [`POST ${BASE}/statements/${s.id}/exclude`, removing(i + 1, () => ok({ statement: s }))],
      ]),
    ),
    ...extra(state),
  });
  return { all, state };
}

const renderReview = () =>
  renderRoute(ReviewRoute, {
    path: "/e/$entityId/statements/review",
    url: "/e/e1/statements/review",
  });

const review = () => screen.findByRole("region", { name: "明細の確認" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+09:00"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("明細の確認（FR-021）", () => {
  it("未処理を 1 件ずつ、明細と候補の仕訳を並べて出す。残りの件数も出す", async () => {
    openApi([
      statement(1, { content: "口座間の移動", candidate: transfer() }),
      statement(2),
      statement(3),
    ]);
    renderReview();

    const region = await review();
    expect(await within(region).findByText(/口座間の移動/)).toBeInTheDocument();
    expect(within(region).getByRole("heading", { name: /口座間の移動/ })).toHaveTextContent(
      "2026-05-10",
    );
    expect(within(region).getByText("残り 3 件")).toBeInTheDocument();
    expect(within(region).getByText(/振替の対（テストカードA 2026-05-10）/)).toBeInTheDocument();
    // 候補の仕訳（科目の名前と金額）
    const lines = await within(region).findByRole("table", { name: "候補の仕訳" });
    expect(within(lines).getByRole("row", { name: /借方.*現金.*5,000/ })).toBeInTheDocument();
    expect(within(lines).getByRole("row", { name: /貸方.*普通預金.*5,000/ })).toBeInTheDocument();
    // 2 件目以降はまだ出さない
    expect(within(region).queryByText("明細2")).not.toBeInTheDocument();
  });

  it("「承認して次へ」は候補のまま承認し（learn も送らない）、仕訳が変わるので読み直し、次の明細を出す", async () => {
    const { all } = openApi([
      statement(1, { content: "口座間の移動", candidate: transfer() }),
      statement(2, { content: "次の明細", candidate: transfer() }),
    ]);
    const u = userEvent.setup();
    const { queryClient } = renderReview();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const region = await review();
    await within(region).findByText(/口座間の移動/);
    await u.click(within(region).getByRole("button", { name: "承認して次へ" }));

    expect(await within(region).findByText(/次の明細/)).toBeInTheDocument();
    expect(within(region).getByText("残り 1 件")).toBeInTheDocument();
    // 知らせは toast（screen で探す）
    expect(await screen.findByText(/承認しました（仕訳 No\.7）/)).toBeInTheDocument();
    const body = calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body;
    expect(body).toEqual({});
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "journals"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "reports"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["entities", "e1", "home"] });
    expect(screen.queryByRole("checkbox", { name: /ルールを学ぶ/ })).not.toBeInTheDocument();
  });

  it("既存の仕訳に結びつく候補（match）も、そのまま承認する", async () => {
    const { all } = openApi([statement(1, { candidate: matched })]);
    const u = userEvent.setup();
    renderReview();

    const region = await review();
    expect(await within(region).findByText(/既存の仕訳に結びつけます/)).toBeInTheDocument();
    await u.click(within(region).getByRole("button", { name: "承認して次へ" }));
    await waitFor(() =>
      expect(calls(all, "POST", `/statements/${uuid(1)}/approve`)[0]?.body).toEqual({}),
    );
  });

  it("候補がない明細は承認して次へ進めない。一覧で直す入口を出す。除外・飛ばすはできる", async () => {
    openApi([statement(1, { content: "候補なしの明細", candidate: none }), statement(2)]);
    renderReview();

    const region = await review();
    await within(region).findByText(/候補なしの明細/);
    expect(within(region).getByRole("button", { name: "承認して次へ" })).toBeDisabled();
    expect(within(region).getByText(/仕訳の案がありません/)).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "一覧で仕訳を直す" })).toHaveAttribute(
      "href",
      `/e/e1/statements?statementId=${uuid(1)}`,
    );
    expect(within(region).getByRole("button", { name: "飛ばす" })).toBeEnabled();
    expect(within(region).getByRole("button", { name: "除外" })).toBeEnabled();
  });

  it("候補が未作成（null）の明細も同じ。承認の API は呼ばない", async () => {
    const { all } = openApi([statement(1)]);
    renderReview();
    const region = await review();
    expect(await within(region).findByText(/仕訳の案がありません/)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "承認して次へ" })).toBeDisabled();
    expect(calls(all, "POST", `/statements/${uuid(1)}/approve`)).toHaveLength(0);
  });

  it("「飛ばす」は何も送らずに次の明細へ進む。最後まで進むと、飛ばした件数と一覧を知らせる", async () => {
    const { all } = openApi([
      statement(1, { content: "一つ目", candidate: transfer() }),
      statement(2, { content: "二つ目", candidate: transfer() }),
    ]);
    const u = userEvent.setup();
    renderReview();

    const region = await review();
    await within(region).findByText(/一つ目/);
    await u.click(within(region).getByRole("button", { name: "飛ばす" }));
    expect(await within(region).findByText(/二つ目/)).toBeInTheDocument();
    expect(within(region).getByText("残り 1 件")).toBeInTheDocument();
    await u.click(within(region).getByRole("button", { name: "飛ばす" }));

    expect(
      await within(region).findByText("未処理の明細の確認が終わりました。"),
    ).toBeInTheDocument();
    expect(within(region).getByText(/飛ばした明細が 2 件あります/)).toBeInTheDocument();
    expect(all.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("「除外」は理由なしで送り、次の明細へ進む", async () => {
    const { all } = openApi([
      statement(1, { content: "除外する明細", candidate: transfer() }),
      statement(2, { content: "次の明細", candidate: transfer() }),
    ]);
    const u = userEvent.setup();
    renderReview();

    const region = await review();
    await within(region).findByText(/除外する明細/);
    await u.click(within(region).getByRole("button", { name: "除外" }));
    expect(await within(region).findByText(/次の明細/)).toBeInTheDocument();
    expect(calls(all, "POST", `/statements/${uuid(1)}/exclude`)[0]?.body).toEqual({});
    expect(calls(all, "POST", `/statements/${uuid(1)}/approve`)).toHaveLength(0);
  });

  it("全部済ませたら、完了の知らせと、ホーム・一覧へのリンクを出す", async () => {
    openApi([statement(1, { candidate: transfer() })]);
    const u = userEvent.setup();
    renderReview();

    const region = await review();
    await u.click(await within(region).findByRole("button", { name: "承認して次へ" }));
    expect(
      await within(region).findByText("未処理の明細の確認が終わりました。"),
    ).toBeInTheDocument();
    expect(within(region).queryByText(/飛ばした明細/)).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "承認して次へ" })).not.toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "ホームへ" })).toHaveAttribute("href", "/e/e1");
    expect(within(region).getByRole("link", { name: "明細の一覧へ" })).toHaveAttribute(
      "href",
      "/e/e1/statements",
    );
  });

  it("最初から未処理がなくても、完了の知らせとリンクを出す", async () => {
    openApi([]);
    renderReview();
    const region = await review();
    expect(
      await within(region).findByText("未処理の明細の確認が終わりました。"),
    ).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "ホームへ" })).toBeInTheDocument();
  });

  it("承認の失敗（締め済みの年度など）は知らせて、同じ明細に留まる", async () => {
    openApi([statement(1, { content: "締め済みの明細", candidate: transfer() })], () => ({
      [`POST ${BASE}/statements/${uuid(1)}/approve`]: () =>
        apiError(422, "PERIOD_CLOSED", "2026 年度は締め済みです"),
    }));
    const u = userEvent.setup();
    renderReview();

    const region = await review();
    await u.click(await within(region).findByRole("button", { name: "承認して次へ" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("2026 年度は締め済みです");
    expect(within(region).getByText(/締め済みの明細/)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "承認して次へ" })).toBeEnabled();
  });
});

describe("まとめて承認と主な操作（FR-021・024）", () => {
  const settings = {
    bulkThreshold: 80,
    externalThreshold: 60,
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
  const three = () => [
    statement(1, { content: "高い確信", candidate: transfer(95) }),
    statement(2, { content: "もう一つ", candidate: { ...transfer(85) } }),
    statement(3, { content: "低い確信", candidate: transfer(50) }),
  ];

  it("まとめて承認は確認の上にあり、今のしきい値の規則で対象の件数を出す。しきい値の数字は出さない", async () => {
    const { all } = openApi(three(), () => ({
      [`GET ${BASE}/statement-settings`]: () => ok({ settings }),
      [`POST ${BASE}/statements/approve-bulk`]: () =>
        ok({ approved: [uuid(1), uuid(2)], failed: [] }),
    }));
    const u = userEvent.setup();
    renderReview();

    const bulk = await screen.findByRole("region", { name: "まとめて承認" });
    const queue = await review();
    // 並びは、まとめて承認 → 確認
    expect(bulk.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await within(bulk).findByText("確信度の高い候補: 2 件")).toBeInTheDocument();
    expect(screen.queryByText(/しきい値/)).not.toBeInTheDocument();
    expect(screen.queryByText(/確信度 80/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /しきい値/ })).not.toBeInTheDocument();

    await u.click(within(bulk).getByRole("button", { name: "まとめて承認" }));
    expect(await within(bulk).findByText("2 件を承認しました。")).toBeInTheDocument();
    expect(calls(all, "POST", "/statements/approve-bulk")[0]?.body).toEqual({
      items: [{ statementId: uuid(1) }, { statementId: uuid(2) }],
    });
  });

  it("画面の主な操作（variant=default）は「承認して次へ」だけ", async () => {
    openApi(three(), () => ({ [`GET ${BASE}/statement-settings`]: () => ok({ settings }) }));
    renderReview();
    const region = await review();
    await within(region).findByRole("button", { name: "承認して次へ" });
    const primary = screen
      .getAllByRole("button")
      .filter((b) => b.className.split(" ").includes("bg-primary"));
    expect(primary.map((b) => b.textContent)).toEqual(["承認して次へ"]);
  });
});
