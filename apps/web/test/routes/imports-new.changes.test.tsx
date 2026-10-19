import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImportPlanItem, ImportPreview } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/imports/new";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const ENTITY = "/api/entities/e1";
const PREVIEW = `${ENTITY}/imports/freee/preview`;

/** packages/domain の canonicalSnapshot と同じ形の正準 JSON */
const snapshot = (amount: number, date = "2025-04-01") =>
  JSON.stringify({
    date,
    memo: null,
    lines: [
      {
        side: "debit",
        account: "消耗品費",
        subAccount: null,
        amount,
        tax: "課対仕入10%",
        taxAmount: Math.floor(amount / 11),
        partner: "文具店A",
        tags: [],
        description: "コピー用紙",
      },
      {
        side: "credit",
        account: "普通預金",
        subAccount: "○○銀行",
        amount,
        tax: "対象外",
        taxAmount: 0,
        partner: null,
        tags: [],
        description: "コピー用紙",
      },
    ],
  });

const items: ImportPlanItem[] = [
  {
    freeeJournalId: "F-10",
    freeeJournalNo: "No.10",
    date: "2025-04-01",
    decision: "already",
    reason: "ALREADY_IMPORTED",
    warnings: ["FREEE_CHANGED"],
  },
  {
    freeeJournalId: "F-12",
    freeeJournalNo: "No.12",
    date: "2025-10-05",
    decision: "new",
    draft: {
      date: "2025-10-05",
      lines: [
        { side: "debit", accountId: "supplies", amount: 550, taxCategory: "OUT_OF_SCOPE" },
        { side: "credit", accountId: "bank", amount: 550, taxCategory: "OUT_OF_SCOPE" },
      ],
    },
    warnings: [],
  },
];

const preview: ImportPreview = {
  file: {
    name: "仕訳帳_2025_v2.csv",
    sha256: "ab".repeat(32),
    kind: "journal",
    encoding: "utf-8",
    rowCount: 4,
  },
  years: [
    {
      fiscalYear: 2025,
      hasPeriod: true,
      closed: false,
      counts: { new: 1, already: 1, excluded: 0, rejected: 0 },
    },
  ],
  counts: { new: 1, already: 1, excluded: 0, rejected: 0, warnings: 2 },
  totals: { debit: 550, credit: 550 },
  items,
  mappings: { accounts: [], taxes: [] },
  toCreate: { subAccounts: [], partners: [], tags: [] },
  warnings: [
    {
      code: "FREEE_CHANGED",
      message: "前回の取込の後に freee 側で内容が変わっています",
      freeeJournalId: "F-10",
      details: { journalId: "j7", journalNo: 7, before: snapshot(11000), after: snapshot(12000) },
    },
    {
      code: "FREEE_DELETED",
      message: "ファイルの期間内にあるはずの仕訳がありません",
      freeeJournalId: "F-11",
      details: {
        journalId: "j8",
        journalNo: 8,
        freeeJournalNo: "No.11",
        before: snapshot(3300, "2025-06-20"),
      },
    },
  ],
  ready: true,
};

const csv = () => new File(['"取引日","仕訳ID"\n'], "仕訳帳_2025_v2.csv", { type: "text/csv" });

function renderNew() {
  return renderRoute(Route, { path: "/e/$entityId/imports/new", url: "/e/e1/imports/new" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("新しい取込: freee 側の変更・削除（T064）", () => {
  it("変更あり（変更前と変更後の行）と削除の一覧を、帳簿の仕訳へのリンクつきで表示する", async () => {
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [] }),
      [`GET ${ENTITY}/tax-categories`]: () => ok({ taxCategories: [], taxRates: [] }),
      [`POST ${PREVIEW}`]: () => ok({ preview }),
    });
    const user = userEvent.setup();
    renderNew();

    await user.upload(await screen.findByLabelText("仕訳帳のファイル"), csv());
    const panel = await screen.findByRole("region", { name: "freee 側の変更・削除" });
    expect(panel).toHaveTextContent("帳簿の仕訳は変わりません");

    const changed = within(panel).getByRole("list", { name: "freee 側で変更あり" });
    const [changedItem] = within(changed).getAllByRole("listitem");
    expect(changedItem).toHaveTextContent("No.10");
    expect(changedItem).toHaveTextContent("前回の取込の後に freee 側で内容が変わっています");
    const before = within(changedItem as HTMLElement).getByRole("table", {
      name: "No.10 の変更前",
    });
    const after = within(changedItem as HTMLElement).getByRole("table", { name: "No.10 の変更後" });
    expect(before).toHaveTextContent("2025-04-01");
    const beforeDebit = within(before).getAllByRole("row")[1];
    expect(beforeDebit).toHaveTextContent("借方");
    expect(beforeDebit).toHaveTextContent("消耗品費");
    expect(beforeDebit).toHaveTextContent("11,000");
    expect(beforeDebit).toHaveTextContent("課対仕入10%");
    expect(beforeDebit).toHaveTextContent("コピー用紙");
    expect(within(before).getAllByRole("row")[2]).toHaveTextContent("普通預金 ／ ○○銀行");
    expect(after).toHaveTextContent("12,000");
    expect(after).not.toHaveTextContent("11,000");
    expect(
      within(changedItem as HTMLElement).getByRole("link", { name: "帳簿の仕訳 No.7" }),
    ).toHaveAttribute("href", "/e/e1/journals/j7");

    const deleted = within(panel).getByRole("list", { name: "freee 側で削除" });
    const [deletedItem] = within(deleted).getAllByRole("listitem");
    expect(deletedItem).toHaveTextContent("No.11");
    expect(deletedItem).toHaveTextContent("2025-06-20");
    expect(
      within(deletedItem as HTMLElement).getByRole("table", { name: "No.11 の取込のときの内容" }),
    ).toHaveTextContent("3,300");
    expect(
      within(deletedItem as HTMLElement).getByRole("link", { name: "帳簿の仕訳 No.8" }),
    ).toHaveAttribute("href", "/e/e1/journals/j8");

    // 同じ警告を要約の警告の一覧に重ねて出さない
    expect(screen.queryByRole("list", { name: "警告の一覧" })).toBeNull();
  });

  it("変更・削除がなければ、一覧を表示しない", async () => {
    mockApi({
      [`GET ${ENTITY}/accounts`]: () => ok({ accounts: [] }),
      [`GET ${ENTITY}/tax-categories`]: () => ok({ taxCategories: [], taxRates: [] }),
      [`POST ${PREVIEW}`]: () =>
        ok({
          preview: {
            ...preview,
            items: items.map((i) => ({ ...i, warnings: [] })),
            counts: { ...preview.counts, warnings: 0 },
            warnings: [],
          },
        }),
    });
    const user = userEvent.setup();
    renderNew();

    await user.upload(await screen.findByLabelText("仕訳帳のファイル"), csv());
    await screen.findByRole("region", { name: "プレビューの要約" });
    expect(screen.queryByRole("region", { name: "freee 側の変更・削除" })).toBeNull();
  });
});
