import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FiscalPeriod } from "@/features/periods/api";
import { Route } from "@/routes/e/$entityId/periods/index";
import { type ApiCall, type ApiReply, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const PERIODS = `${ENTITY}/fiscal-periods`;

const period = (fiscalYear: number, closedAt: string | null = null): FiscalPeriod => ({
  id: `p${fiscalYear}`,
  fiscalYear,
  startDate: `${fiscalYear}-01-01`,
  endDate: `${fiscalYear}-12-31`,
  status: closedAt === null ? "open" : "closed",
  closedAt,
});

type HistoryItem = {
  occurredAt: string;
  fiscalYear: number;
  action: "close" | "reopen";
  reason: string | null;
};

/** 締め・解除で状態が変わる、会計期間の API のモック */
function mockPeriodsApi(
  initial: FiscalPeriod[],
  options: {
    history?: HistoryItem[];
    reopen?: (call: ApiCall) => ApiReply;
    /** 年度ごとの仕訳の件数（指定のない年度は 0 件） */
    journalCounts?: Record<number, number>;
    /** 期首残高を登録済みの年度（指定のない年度は未登録） */
    openingYears?: number[];
  } = {},
) {
  let periods = initial;
  const history = [...(options.history ?? [])];
  const update = (year: number, closedAt: string | null) => {
    periods = periods.map((p) => (p.fiscalYear === year ? period(year, closedAt) : p));
    return periods.find((p) => p.fiscalYear === year);
  };
  return mockApi({
    [`GET ${PERIODS}`]: () => ok({ fiscalPeriods: periods }),
    [`GET ${PERIODS}/history`]: () => ok({ history }),
    [`GET ${ENTITY}/journals`]: ({ query }) => {
      const year = Number(query.dateFrom?.slice(0, 4));
      return ok({
        journals: [],
        nextCursor: null,
        summary: { count: options.journalCounts?.[year] ?? 0, amount: 0 },
      });
    },
    ...Object.fromEntries(
      initial.map((p) => [
        `GET ${PERIODS}/${p.fiscalYear}/opening-balances`,
        () =>
          ok({
            fiscalPeriod: p,
            openingBalances: options.openingYears?.includes(p.fiscalYear)
              ? [
                  {
                    accountId: "a1",
                    subAccountId: null,
                    side: "debit",
                    amount: 100000,
                  },
                ]
              : [],
          }),
      ]),
    ),
    [`POST ${PERIODS}/2026/close`]: () => {
      history.push({
        occurredAt: "2027-03-15T01:00:00.000Z",
        fiscalYear: 2026,
        action: "close",
        reason: null,
      });
      return ok({ fiscalPeriod: update(2026, "2027-03-15T01:00:00.000Z") });
    },
    [`POST ${PERIODS}/2025/reopen`]: (call) => {
      if (options.reopen) return options.reopen(call);
      const { reason } = call.body as { reason: string };
      history.push({
        occurredAt: "2027-05-01T01:00:00.000Z",
        fiscalYear: 2025,
        action: "reopen",
        reason,
      });
      return ok({ fiscalPeriod: update(2025, null) });
    },
  });
}

const renderPeriods = () =>
  renderRoute(Route, { path: "/e/$entityId/periods/", url: "/e/e1/periods/" });

/** 年度のカード（FR-051） */
const rowOf = (year: number) => screen.findByRole("region", { name: `${year}年度` });

const historyItems = async () =>
  within(await screen.findByRole("table", { name: "締めと解除の履歴" }))
    .getAllByRole("row")
    .slice(1);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("会計期間の画面（US5）", () => {
  it("FR-051: 年度ごとのカードに「期首残高 → 記帳 → 決算整理 → 締め」の状態と入口を出す", async () => {
    mockPeriodsApi([period(2025, "2026-03-15T01:00:00.000Z"), period(2026)], {
      journalCounts: { 2025: 48, 2026: 0 },
      openingYears: [2025],
    });
    renderPeriods();

    const card2025 = await rowOf(2025);
    const stages2025 = within(card2025).getAllByRole("listitem");
    expect(stages2025.map((s) => s.getAttribute("aria-label"))).toEqual([
      "期首残高",
      "記帳",
      "決算整理",
      "締め",
    ]);
    await waitFor(() => expect(stages2025[0]).toHaveTextContent("登録済み"));
    await waitFor(() => expect(stages2025[1]).toHaveTextContent("仕訳 48 件"));
    expect(within(stages2025[0] as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/e/e1/periods/2025/opening-balances",
    );
    expect(within(stages2025[1] as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      expect.stringContaining("dateFrom=2025-01-01"),
    );
    // 決算整理は状態を持たず、決算書へのリンクだけ
    expect(within(stages2025[2] as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/e/e1/blue-return/2025",
    );
    expect(stages2025[3]).toHaveTextContent("締め済み");

    const card2026 = await rowOf(2026);
    const stages2026 = within(card2026).getAllByRole("listitem");
    await waitFor(() => expect(stages2026[0]).toHaveTextContent("未登録"));
    await waitFor(() => expect(stages2026[1]).toHaveTextContent("仕訳 0 件"));
    expect(stages2026[3]).toHaveTextContent("未締め");
  });

  it("FR-051: freee の取込への入口がある", async () => {
    mockPeriodsApi([period(2026)]);
    renderPeriods();

    expect(await screen.findByRole("link", { name: /freee の取込/ })).toHaveAttribute(
      "href",
      "/e/e1/imports",
    );
  });

  it("年度ごとに状態を表示し、未締めの年度には締めるボタン、締め済みの年度には解除のボタンを出す", async () => {
    mockPeriodsApi([period(2025, "2026-03-15T01:00:00.000Z"), period(2026)]);
    renderPeriods();

    const row2025 = await rowOf(2025);
    expect(row2025).toHaveTextContent("締め済み");
    expect(within(row2025).getByRole("button", { name: "2025年度の締めを解除" })).toBeEnabled();
    expect(within(row2025).queryByRole("button", { name: /締める/ })).not.toBeInTheDocument();
    const row2026 = await rowOf(2026);
    expect(row2026).toHaveTextContent("未締め");
    expect(within(row2026).getByRole("button", { name: "2026年度を締める" })).toBeEnabled();
  });

  it("FR-024: 締めは確認のダイアログで確定すると POST し、状態と履歴が更新される", async () => {
    const calls = mockPeriodsApi([period(2025), period(2026)]);
    const u = userEvent.setup();
    renderPeriods();

    await u.click(await screen.findByRole("button", { name: "2026年度を締める" }));
    const dialog = await screen.findByRole("dialog", { name: "2026年度を締める" });
    expect(dialog).toHaveTextContent("登録・訂正・取消");
    await u.click(within(dialog).getByRole("button", { name: "締める" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      `${PERIODS}/2026/close`,
    ]);
    await waitFor(async () => expect(await rowOf(2026)).toHaveTextContent("締め済み"));
    const items = await historyItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("2026年度");
    expect(items[0]).toHaveTextContent("締め");
    expect(items[0]?.querySelector("time")).toHaveAttribute("datetime", "2027-03-15T01:00:00.000Z");
  });

  it("締めの確認のダイアログで戻ると送らない", async () => {
    const calls = mockPeriodsApi([period(2026)]);
    const u = userEvent.setup();
    renderPeriods();

    await u.click(await screen.findByRole("button", { name: "2026年度を締める" }));
    const dialog = await screen.findByRole("dialog", { name: "2026年度を締める" });
    await u.click(within(dialog).getByRole("button", { name: "戻る" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(await rowOf(2026)).toHaveTextContent("未締め");
  });

  it("FR-024, FR-025: 解除は理由の入力を求め、理由を付けて POST する。履歴に理由が残る", async () => {
    const calls = mockPeriodsApi([period(2025, "2026-03-15T01:00:00.000Z"), period(2026)], {
      history: [
        {
          occurredAt: "2026-03-15T01:00:00.000Z",
          fiscalYear: 2025,
          action: "close",
          reason: null,
        },
      ],
    });
    const u = userEvent.setup();
    renderPeriods();

    await u.click(await screen.findByRole("button", { name: "2025年度の締めを解除" }));
    const dialog = await screen.findByRole("dialog", { name: "2025年度の締めの解除" });
    const confirm = within(dialog).getByRole("button", { name: "解除を確定" });
    expect(confirm).toBeDisabled();
    await u.type(within(dialog).getByLabelText("理由"), "   ");
    expect(confirm).toBeDisabled();
    await u.type(within(dialog).getByLabelText("理由"), "修正申告のため");
    await u.click(confirm);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual([`${PERIODS}/2025/reopen`]);
    expect(posts[0]?.body).toEqual({ reason: "   修正申告のため" });
    await waitFor(async () => expect(await rowOf(2025)).toHaveTextContent("未締め"));
    const items = await historyItems();
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent("解除");
    expect(items[1]).toHaveTextContent("修正申告のため");
  });

  it("解除の API が REASON_REQUIRED を返したら、ダイアログの理由の欄に表示する", async () => {
    mockPeriodsApi([period(2025, "2026-03-15T01:00:00.000Z")], {
      reopen: () =>
        apiError(422, "REASON_REQUIRED", "理由を入力してください（500文字以内）", {
          field: "reason",
        }),
    });
    const u = userEvent.setup();
    renderPeriods();

    await u.click(await screen.findByRole("button", { name: "2025年度の締めを解除" }));
    const dialog = await screen.findByRole("dialog", { name: "2025年度の締めの解除" });
    await u.type(within(dialog).getByLabelText("理由"), "x");
    await u.click(within(dialog).getByRole("button", { name: "解除を確定" }));

    expect(await within(dialog).findByText("理由を入力してください（500文字以内）")).toBeVisible();
    expect(within(dialog).getByLabelText("理由")).toHaveAttribute("aria-invalid", "true");
    await u.click(within(dialog).getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await rowOf(2025)).toHaveTextContent("締め済み");
  });

  it("締めも解除もしていなければ、履歴が空であることを表示する", async () => {
    mockPeriodsApi([period(2026)]);
    renderPeriods();

    expect(await screen.findByText("締めた年度はまだありません。")).toBeInTheDocument();
  });
});
