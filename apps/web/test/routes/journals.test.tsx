import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/lib/queries";
import { Route } from "@/routes/e/$entityId/journals/index";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const account = (n: number, name: string, isActive = true): Account => ({
  id: uuid(n),
  code: String(n),
  name,
  category: "asset",
  normalSide: "debit",
  reportSection: "BS_ASSET",
  reportLine: null,
  sortOrder: n,
  isSystem: false,
  isActive,
});

const bank = account(1020, "普通預金");
const owner = account(1900, "事業主貸");
const receivable = account(1100, "売掛金");
const sales = account(4010, "売上高", false);

type LineSpec = [side: "debit" | "credit", accountId: string, amount: number, description?: string];

const journal = (
  journalNo: number,
  date: string,
  lines: LineSpec[],
  rest: { memo?: string; status?: "active" | "voided" } = {},
) => ({
  id: uuid(9000 + journalNo),
  journalNo,
  date,
  fiscalPeriodId: "p2026",
  memo: rest.memo ?? null,
  status: rest.status ?? "active",
  correctsJournalId: null,
  source: "manual",
  version: 1,
  createdAt: "2026-10-31T09:00:00.000Z",
  updatedAt: "2026-10-31T09:00:00.000Z",
  lines: lines.map(([side, accountId, amount, description], i) => ({
    id: uuid(9100 + journalNo * 10 + i),
    lineNo: i + 1,
    side,
    accountId,
    subAccountId: null,
    amount,
    taxCategory: "OUT_OF_SCOPE",
    taxAmount: 0,
    partnerId: null,
    description: description ?? null,
    tagIds: [],
  })),
});

function renderJournals() {
  return renderRoute(Route, { path: "/e/$entityId/journals/", url: "/e/e1/journals" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("仕訳の一覧（US2）", () => {
  it("API の順（新しい順）に、日付・仕訳番号・借方と貸方の科目と金額・摘要を表示する", async () => {
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [bank, owner, receivable, sales] }),
      [`GET ${ENTITY}/journals`]: () =>
        ok({
          journals: [
            journal(
              3,
              "2026-11-30",
              [
                ["debit", bank.id, 487_037],
                ["debit", owner.id, 7963, "源泉所得税"],
                ["credit", receivable.id, 495_000],
              ],
              { memo: "10月分の入金" },
            ),
            journal(1, "2026-10-31", [
              ["debit", receivable.id, 495_000, "10月分"],
              ["credit", sales.id, 495_000],
            ]),
            journal(
              2,
              "2026-10-01",
              [
                ["debit", receivable.id, 1000],
                ["credit", sales.id, 1000],
              ],
              { status: "voided" },
            ),
          ],
        }),
    });
    renderJournals();

    const table = await screen.findByRole("table", { name: "仕訳の一覧" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[1]?.textContent)).toEqual([
      "3",
      "1",
      "2",
    ]);
    const first = rows[0];
    if (!first) throw new Error("行がない");
    expect(first).toHaveTextContent("2026-11-30");
    expect(first).toHaveTextContent("普通預金487,037");
    expect(first).toHaveTextContent("事業主貸7,963");
    expect(first).toHaveTextContent("売掛金495,000");
    expect(first).toHaveTextContent("10月分の入金");
    expect(first).toHaveTextContent("源泉所得税");
    // 使用停止の科目でも名称を表示する
    expect(rows[1]).toHaveTextContent("売上高495,000");
    expect(rows[2]).toHaveTextContent("取消済み");
    expect(rows[1]).not.toHaveTextContent("取消済み");
  });

  it("仕訳がなければその旨を表示し、入力画面へのリンクを出す", async () => {
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [bank] }),
      [`GET ${ENTITY}/journals`]: () => ok({ journals: [] }),
    });
    renderJournals();

    expect(await screen.findByText(/仕訳がありません/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "仕訳を入力" })).toHaveAttribute(
      "href",
      "/e/e1/journals/new",
    );
  });
});
