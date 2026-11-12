import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HomeSummary } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/index";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 011 US1: ホーム（contracts/ui-shell.md §3、FR-006〜009）

const HOME = "/api/entities/e1/home";
const JOURNAL_ID = "00000000-0000-4000-8000-0000000000b1";

const tasks = (over: Partial<Extract<HomeSummary["tasks"], { status: "ok" }>["value"]> = {}) => ({
  unprocessedStatements: 0,
  unlinkedReceipts: 0,
  unpaidInvoices: 0,
  overdueInvoices: 0,
  blockedRecurring: 0,
  blueReturnWarnings: 0,
  ...over,
});

const figures = {
  fiscalYear: 2026,
  from: "2026-01-01",
  to: "2026-12-31",
  sales: 1_234_567,
  expenses: 400_000,
  netIncome: 834_567,
  cashAndDeposits: 2_000_000,
  outstanding: 330_000,
};

const summary = (over: Partial<HomeSummary> = {}): HomeSummary => ({
  tasks: { status: "ok", value: tasks() },
  figures: { status: "ok", value: figures },
  recentJournals: {
    status: "ok",
    value: [
      {
        id: JOURNAL_ID,
        number: 12,
        date: "2026-10-30",
        memo: "文房具",
        amount: 1_100,
        createdAt: "2026-10-30T09:00:00.000Z",
      },
    ],
  },
  lastStatementImportAt: { status: "ok", value: "2026-10-25T12:00:00.000Z" },
  ...over,
});

const renderHome = () => renderRoute(Route, { path: "/e/$entityId/", url: "/e/e1" });
const section = (name: string) => screen.findByRole("region", { name });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("今日やること", () => {
  it("0 件の項目は出さず、件数のある項目は検索の引数つきの画面へのリンクにする", async () => {
    mockApi({
      [`GET ${HOME}`]: () =>
        ok(
          summary({
            tasks: {
              status: "ok",
              value: tasks({
                unprocessedStatements: 3,
                unlinkedReceipts: 2,
                unpaidInvoices: 4,
                overdueInvoices: 1,
                blockedRecurring: 1,
                blueReturnWarnings: 5,
              }),
            },
          }),
        ),
    });
    renderHome();
    const todo = within(await section("今日やること"));

    expect(await todo.findByRole("link", { name: "未処理の明細 3 件" })).toHaveAttribute(
      "href",
      "/e/e1/statements?status=unprocessed",
    );
    expect(todo.getByRole("link", { name: "仕訳のない証憑 2 件" })).toHaveAttribute(
      "href",
      "/e/e1/receipts?link=none",
    );
    expect(todo.getByRole("link", { name: "未入金の請求書 4 件" })).toHaveAttribute(
      "href",
      "/e/e1/invoices?status=unpaid",
    );
    expect(todo.getByRole("link", { name: "うち期限切れ 1 件" })).toHaveAttribute(
      "href",
      "/e/e1/invoices?status=overdue",
    );
    expect(todo.getByRole("link", { name: "登録できなかった定期仕訳 1 件" })).toHaveAttribute(
      "href",
      "/e/e1/recurring",
    );
    expect(todo.getByRole("link", { name: "決算書の警告 5 件" })).toHaveAttribute(
      "href",
      "/e/e1/blue-return/2026",
    );
    expect(todo.queryByText("残っている作業はありません")).not.toBeInTheDocument();
  });

  it("0 件の項目は出ない（件数のある項目だけ）", async () => {
    mockApi({
      [`GET ${HOME}`]: () =>
        ok(summary({ tasks: { status: "ok", value: tasks({ unlinkedReceipts: 2 }) } })),
    });
    renderHome();
    const todo = within(await section("今日やること"));
    expect(await todo.findByRole("link", { name: "仕訳のない証憑 2 件" })).toBeInTheDocument();
    expect(todo.getAllByRole("link")).toHaveLength(1);
  });

  it("すべて 0 なら「残っている作業はありません」", async () => {
    mockApi({ [`GET ${HOME}`]: () => ok(summary()) });
    renderHome();
    const todo = within(await section("今日やること"));
    expect(await todo.findByText("残っている作業はありません")).toBeInTheDocument();
    expect(todo.queryAllByRole("link")).toHaveLength(0);
  });

  it("未入金・期限切れの 0 件は出さない。期限切れだけが 0 のときは「うち期限切れ」を出さない", async () => {
    mockApi({
      [`GET ${HOME}`]: () =>
        ok(summary({ tasks: { status: "ok", value: tasks({ unpaidInvoices: 2 }) } })),
    });
    renderHome();
    const todo = within(await section("今日やること"));
    expect(await todo.findByRole("link", { name: "未入金の請求書 2 件" })).toBeInTheDocument();
    expect(todo.queryByText(/期限切れ/)).not.toBeInTheDocument();
  });
});

describe("今期の数字", () => {
  it("売上・経費・利益・現金と預金・未回収を表示する。期間は会計期間の期首〜期末", async () => {
    mockApi({ [`GET ${HOME}`]: () => ok(summary()) });
    renderHome();
    const figs = within(await section("今期の数字"));
    expect(await figs.findByText("2026 年度（2026-01-01 〜 2026-12-31）")).toBeInTheDocument();
    const row = (label: string) => figs.getByText(label).closest("div") as HTMLElement;
    expect(row("売上")).toHaveTextContent("1,234,567");
    expect(row("経費")).toHaveTextContent("400,000");
    expect(row("利益")).toHaveTextContent("834,567");
    expect(row("現金と預金")).toHaveTextContent("2,000,000");
    expect(row("未回収")).toHaveTextContent("330,000");
  });

  it("今日を含む会計期間がなければ、登録の案内（会計期間の画面へのリンク）を出す", async () => {
    mockApi({ [`GET ${HOME}`]: () => ok(summary({ figures: { status: "ok", value: null } })) });
    renderHome();
    const figs = within(await section("今期の数字"));
    expect(await figs.findByText(/会計期間が登録されていません/)).toBeInTheDocument();
    expect(figs.getByRole("link", { name: "会計期間を登録する" })).toHaveAttribute(
      "href",
      "/e/e1/periods",
    );
  });
});

describe("最近の仕訳・近道・日時", () => {
  it("最近の仕訳は詳細へのリンク。近道は 3 つ", async () => {
    mockApi({ [`GET ${HOME}`]: () => ok(summary()) });
    renderHome();
    const recent = within(await section("最近の仕訳"));
    const link = await recent.findByRole("link", { name: /文房具/ });
    expect(link).toHaveAttribute("href", `/e/e1/journals/${JOURNAL_ID}`);
    expect(link).toHaveTextContent("2026-10-30");
    expect(link).toHaveTextContent("1,100");

    const shortcuts = within(await section("近道"));
    expect(shortcuts.getByRole("link", { name: "仕訳を入力" })).toHaveAttribute(
      "href",
      "/e/e1/journals/new",
    );
    expect(shortcuts.getByRole("link", { name: "証憑を追加" })).toHaveAttribute(
      "href",
      "/e/e1/receipts/new",
    );
    expect(shortcuts.getByRole("link", { name: "明細を取り込む" })).toHaveAttribute(
      "href",
      "/e/e1/statements/import",
    );
  });

  it("仕訳がなければ「まだありません」", async () => {
    mockApi({
      [`GET ${HOME}`]: () => ok(summary({ recentJournals: { status: "ok", value: [] } })),
    });
    renderHome();
    const recent = within(await section("最近の仕訳"));
    expect(await recent.findByText("まだありません")).toBeInTheDocument();
  });

  it("前回のバックアップ（GET /api/backup/status）と最後の明細の取込を表示し、なければ「まだありません」", async () => {
    mockApi({
      [`GET ${HOME}`]: () => ok(summary({ lastStatementImportAt: { status: "ok", value: null } })),
      "GET /api/backup/status": () =>
        ok({
          folderSource: "configured",
          folder: "/x",
          lastSuccess: "2026-10-30T12:00:00.000Z",
          lastCheck: null,
          lastRun: null,
          alert: null,
          running: false,
        }),
    });
    renderHome();
    const dates = within(await section("日時"));
    const backup = (await dates.findByText("前回のバックアップ")).closest("div") as HTMLElement;
    await waitFor(() => expect(backup).toHaveTextContent(/2026\/10\/30/));
    expect(
      (dates.getByText("最後の明細の取込").closest("div") as HTMLElement).textContent,
    ).toContain("まだありません");
  });

  it("バックアップがまだなら「まだありません」", async () => {
    mockApi({ [`GET ${HOME}`]: () => ok(summary()) });
    renderHome();
    const dates = within(await section("日時"));
    const backup = (await dates.findByText("前回のバックアップ")).closest("div") as HTMLElement;
    await waitFor(() => expect(backup).toHaveTextContent("まだありません"));
    expect((dates.getByText("最後の明細の取込").closest("div") as HTMLElement).textContent).toMatch(
      /2026\/10\/25/,
    );
  });
});

describe("項目の失敗（FR-009）", () => {
  it("失敗した項目だけ「読み込めませんでした」と「再読み込み」を出し、ほかは表示する。再読み込みで取り直す", async () => {
    let calls = 0;
    mockApi({
      [`GET ${HOME}`]: () => {
        calls += 1;
        return ok(
          calls === 1
            ? summary({ tasks: { status: "error", code: "INTERNAL" } })
            : summary({ tasks: { status: "ok", value: tasks({ unlinkedReceipts: 1 }) } }),
        );
      },
    });
    renderHome();
    const todo = within(await section("今日やること"));
    expect(await todo.findByText("読み込めませんでした")).toBeInTheDocument();
    // ほかの項目は出る
    const figs = within(await section("今期の数字"));
    expect(await figs.findByText("1,234,567", { exact: false })).toBeInTheDocument();

    await userEvent.click(todo.getByRole("button", { name: "再読み込み" }));
    expect(await todo.findByRole("link", { name: "仕訳のない証憑 1 件" })).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});
