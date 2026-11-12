import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImportBatch, ImportPlanItem, ImportPreview, MappingRow } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "@/features/accounts/api";
import { Route } from "@/routes/e/$entityId/imports/new";
import { ENTITY, TAX_CATEGORIES } from "../fixtures";
import { type ApiCall, apiError, formFields, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const PREVIEW = `${ENTITY}/imports/freee/preview`;
const COMMIT = `${ENTITY}/imports/freee/commit`;
const MAPPINGS = `${ENTITY}/import-mappings`;
const SHA = "ab".repeat(32);

const account = (
  id: string,
  name: string,
  rest: Pick<Account, "category" | "normalSide" | "reportSection" | "sortOrder"> & Partial<Account>,
): Account => ({
  id,
  code: String(rest.sortOrder),
  name,
  reportLine: null,
  isSystem: false,
  isActive: true,
  ...rest,
});

const bank = account("bank", "普通預金", {
  category: "asset",
  normalSide: "debit",
  reportSection: "BS_ASSET",
  sortOrder: 1020,
});
const sales = account("sales", "売上高", {
  category: "revenue",
  normalSide: "credit",
  reportSection: "PL_SALES",
  sortOrder: 4010,
});
const entertainment = account("ent", "接待交際費", {
  category: "expense",
  normalSide: "debit",
  reportSection: "PL_EXPENSE",
  sortOrder: 5140,
});
const supplies = account("supplies", "消耗品費", {
  category: "expense",
  normalSide: "debit",
  reportSection: "PL_EXPENSE",
  sortOrder: 5170,
});
const initialAccounts = () => [bank, sales, entertainment, supplies];

const draft = (date: string, amount: number, debit: string, credit: string) => ({
  date,
  lines: [
    { side: "debit" as const, accountId: debit, amount, taxCategory: "OUT_OF_SCOPE" as const },
    { side: "credit" as const, accountId: credit, amount, taxCategory: "OUT_OF_SCOPE" as const },
  ],
});

const item = (
  id: string,
  date: string,
  rest: Pick<ImportPlanItem, "decision"> & Partial<ImportPlanItem>,
): ImportPlanItem => ({
  freeeJournalId: id,
  freeeJournalNo: id.replace("J", "No."),
  date,
  warnings: [],
  ...rest,
});

/** 前年の決算振替（対象外）、新規3件、未定のため取込不可1件。2026年分の1件を含む */
const baseItems = (): ImportPlanItem[] => [
  item("J1", "2025-01-01", { decision: "excluded", reason: "PRIOR_YEAR_CLOSING" }),
  item("J2", "2025-01-15", { decision: "new", draft: draft("2025-01-15", 11000, "bank", "sales") }),
  item("J3", "2025-03-10", {
    decision: "new",
    draft: draft("2025-03-10", 2200, "supplies", "bank"),
    warnings: ["TAX_CATEGORY_SUSPICIOUS"],
  }),
  item("J4", "2025-06-01", { decision: "rejected", reason: "UNMAPPED" }),
  item("J5", "2026-01-20", {
    decision: "new",
    draft: draft("2026-01-20", 3300, "supplies", "bank"),
  }),
];

const accountRows = (entertainmentMapped: boolean): MappingRow[] => [
  { sourceName: "普通預金", status: "saved", accountId: "bank" },
  { sourceName: "売上高", status: "proposed", accountId: "sales" },
  { sourceName: "事務用品費", status: "proposed", accountId: "supplies" },
  entertainmentMapped
    ? { sourceName: "交際費", status: "saved", accountId: "ent" }
    : { sourceName: "交際費", status: "unmapped" },
];
const taxRows = (): MappingRow[] => [
  { sourceName: "課税売上10%", status: "saved", taxCategory: "SALES_10" },
  { sourceName: "課対仕入10%", status: "proposed", taxCategory: "PURCHASE_10" },
  { sourceName: "対象外", status: "proposed", taxCategory: "OUT_OF_SCOPE" },
];

type Counts = ImportPreview["counts"];
const countItems = (items: ImportPlanItem[]) => {
  const counts = { new: 0, already: 0, excluded: 0, rejected: 0 };
  for (const i of items) counts[i.decision] += 1;
  return counts;
};

/** 仕訳ごとの判定から、件数・年度・合計・ready を組み立てる */
function buildPreview(
  items: ImportPlanItem[],
  {
    entertainmentMapped = false,
    fileName = "仕訳帳_2025.csv",
    warnings = [
      {
        code: "TAX_CATEGORY_SUSPICIOUS",
        message: "費用の科目に売上の税区分が付いています",
        freeeJournalId: "J3",
      },
    ],
  }: {
    entertainmentMapped?: boolean;
    fileName?: string;
    warnings?: ImportPreview["warnings"];
  } = {},
): ImportPreview {
  const counts: Counts = {
    ...countItems(items),
    warnings: items.reduce((n, i) => n + i.warnings.length, 0),
  };
  const total = items
    .filter((i) => i.decision === "new")
    .reduce((sum, i) => sum + (i.draft?.lines[0]?.amount ?? 0), 0);
  const years = [2025, 2026].map((fiscalYear) => ({
    fiscalYear,
    hasPeriod: true,
    closed: false,
    counts: countItems(items.filter((i) => i.date.startsWith(String(fiscalYear)))),
  }));
  const mappings = { accounts: accountRows(entertainmentMapped), taxes: taxRows() };
  const unmapped = [...mappings.accounts, ...mappings.taxes].some((m) => m.status === "unmapped");
  return {
    file: { name: fileName, sha256: SHA, kind: "journal", encoding: "utf-8", rowCount: 12 },
    years,
    counts,
    totals: { debit: total, credit: total },
    items,
    mappings,
    toCreate: {
      subAccounts: [{ accountId: "bank", name: "○○銀行" }],
      partners: ["取引先A"],
      tags: [],
    },
    warnings,
    ready: !unmapped && counts.new > 0,
  };
}

const optionsOf = (call: ApiCall) => JSON.parse(String(call.form?.get("options") ?? "null"));

function mockImport(routes: Parameters<typeof mockApi>[0], accounts = initialAccounts()) {
  return mockApi({
    [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
    [`GET ${ENTITY}/tax-categories`]: () => ok({ taxCategories: TAX_CATEGORIES, taxRates: [] }),
    ...Object.fromEntries(
      ["bank", "sales", "ent", "supplies", "new-ent"].map((id) => [
        `GET ${ENTITY}/accounts/${id}/sub-accounts`,
        () => ok({ subAccounts: [] }),
      ]),
    ),
    ...routes,
  });
}

const csv = (name = "仕訳帳_2025.csv") =>
  new File(['"取引日","仕訳ID"\n'], name, { type: "text/csv" });

function renderNew() {
  return renderRoute(Route, { path: "/e/$entityId/imports/new", url: "/e/e1/imports/new" });
}

async function choose(user: ReturnType<typeof userEvent.setup>, file = csv()) {
  await user.upload(await screen.findByLabelText("仕訳帳のファイル"), file);
  return screen.findByRole("region", { name: "プレビューの要約" });
}

/** 要約の項目（dt）の値（dd） */
const summaryValue = (summary: HTMLElement, term: string) =>
  within(summary).getByText(term, { selector: "dt" }).nextElementSibling?.textContent;

const mappingRow = (table: string, sourceName: string) => {
  const row = within(screen.getByRole("table", { name: table }))
    .getByRole("rowheader", { name: sourceName })
    .closest("tr");
  if (!row) throw new Error(`${sourceName} の行がありません`);
  return row;
};

const planRow = (freeeJournalNo: string) => {
  const row = within(screen.getByRole("table", { name: "仕訳ごとの判定" }))
    .getByText(freeeJournalNo)
    .closest("tr");
  if (!row) throw new Error(`${freeeJournalNo} の行がありません`);
  return row;
};

const previewCalls = (calls: ApiCall[]) => calls.filter((c) => c.path === PREVIEW);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("新しい取込: プレビュー（T026）", () => {
  it("FR-051: 上に、期首残高（元帳から作る）と元帳との照合へのリンクを出す", async () => {
    mockImport({});
    renderNew();

    expect(
      await screen.findByRole("link", { name: "期首残高（元帳から作る）" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "元帳と照合" })).toHaveAttribute(
      "href",
      "/e/e1/imports/reconcile",
    );
  });

  it("ファイルを選ぶと、件数・期間・借方と貸方の合計・年度ごとの件数を表示する", async () => {
    const calls = mockImport({
      [`POST ${PREVIEW}`]: () => ok({ preview: buildPreview(baseItems()) }),
    });
    const user = userEvent.setup();
    renderNew();

    const summary = await choose(user);

    expect(formFields(previewCalls(calls)[0]?.form)).toEqual({
      file: { name: "仕訳帳_2025.csv", type: "text/csv", size: csv().size },
      options: "{}",
    });
    expect(summary).toHaveTextContent("仕訳帳_2025.csv");
    expect(summaryValue(summary, "期間")).toBe("2025-01-01 〜 2026-01-20");
    expect(summaryValue(summary, "新規")).toBe("3件");
    expect(summaryValue(summary, "取込済み")).toBe("0件");
    expect(summaryValue(summary, "対象外")).toBe("1件");
    expect(summaryValue(summary, "取込不可")).toBe("1件");
    expect(summaryValue(summary, "警告")).toBe("1件");
    expect(summaryValue(summary, "借方合計")).toBe("16,500円");
    expect(summaryValue(summary, "貸方合計")).toBe("16,500円");
    // 新しく作るもの
    expect(summary).toHaveTextContent("普通預金 ／ ○○銀行");
    expect(summary).toHaveTextContent("取引先A");
    // 警告の一覧（コードは日本語で表示する）
    const warnings = screen.getByRole("list", { name: "警告の一覧" });
    expect(warnings).toHaveTextContent("税区分が科目と合わない可能性");
    expect(warnings).toHaveTextContent("費用の科目に売上の税区分が付いています");
    expect(warnings).toHaveTextContent("No.3");

    const y2025 = screen.getByRole("checkbox", { name: "2025年" });
    expect(y2025).toBeChecked();
    expect(y2025.closest("li")).toHaveTextContent(
      "新規 2件・取込済み 0件・対象外 1件・取込不可 1件",
    );
    expect(screen.getByRole("checkbox", { name: "2026年" }).closest("li")).toHaveTextContent(
      "新規 1件・取込済み 0件・対象外 0件・取込不可 0件",
    );

    // 仕訳ごとの判定と、理由の日本語
    expect(within(planRow("No.1")).getByText("対象外")).toBeInTheDocument();
    expect(planRow("No.1")).toHaveTextContent("前年の決算整理（期首残高に反映済み）");
    expect(planRow("No.4")).toHaveTextContent("対応表で対応が決まっていない名前がある");
    expect(planRow("No.2")).toHaveTextContent("11,000");
    expect(planRow("No.3")).toHaveTextContent("税区分が科目と合わない可能性");
  });

  it("免税の期間の税区分の警告は、件数を1行にまとめ、開くと freee の仕訳 ID の一覧が出る（US7）", async () => {
    const items = baseItems();
    mockImport({
      [`POST ${PREVIEW}`]: () =>
        ok({
          preview: buildPreview(items, {
            warnings: [
              {
                code: "TAX_CATEGORY_SUSPICIOUS_EXEMPT",
                message: "免税の期間のため税区分の警告を 2 件まとめました",
                details: { count: 2, freeeJournalIds: ["900000077", "900000088"] },
              },
            ],
          }),
        }),
    });
    const user = userEvent.setup();
    renderNew();
    await choose(user);

    const warnings = screen.getByRole("list", { name: "警告の一覧" });
    expect(warnings.children).toHaveLength(1);
    expect(warnings).toHaveTextContent("免税の期間のため税区分の警告を 2 件まとめました");
    // 開くと freee の仕訳 ID の一覧
    await user.click(within(warnings).getByText("免税の期間のため税区分の警告を 2 件まとめました"));
    const ids = within(warnings).getByRole("list", { name: "まとめた警告の freee の仕訳 ID" });
    expect(
      within(ids)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["900000077", "900000088"]);
  });

  it("判定で仕訳の一覧を絞り込める", async () => {
    mockImport({ [`POST ${PREVIEW}`]: () => ok({ preview: buildPreview(baseItems()) }) });
    const user = userEvent.setup();
    renderNew();
    await choose(user);

    const table = screen.getByRole("table", { name: "仕訳ごとの判定" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);

    await user.selectOptions(screen.getByLabelText("判定で絞り込む"), "rejected");

    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("No.4");

    await user.selectOptions(screen.getByLabelText("判定で絞り込む"), "new");
    expect(within(table).getAllByRole("row").slice(1)).toHaveLength(3);
  });

  it("freee の仕訳帳でないファイルは、理由と見つからない列を表示する", async () => {
    mockImport({
      [`POST ${PREVIEW}`]: () =>
        apiError(422, "IMPORT_UNKNOWN_FORMAT", "freee の仕訳帳ではありません", {
          expected: "journal",
          missingColumns: ["仕訳ID", "借方金額"],
        }),
    });
    const user = userEvent.setup();
    renderNew();

    await user.upload(await screen.findByLabelText("仕訳帳のファイル"), csv("other.csv"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("freee の仕訳帳として読み取れませんでした");
    expect(alert).toHaveTextContent("見つからない列: 仕訳ID、借方金額");
    expect(screen.queryByRole("region", { name: "プレビューの要約" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取り込む" })).not.toBeInTheDocument();
  });
});

describe("新しい取込: 対応表（T026）", () => {
  it("未定の対応があると「取り込む」が押せず、未定の行が目立つ", async () => {
    mockImport({ [`POST ${PREVIEW}`]: () => ok({ preview: buildPreview(baseItems()) }) });
    const user = userEvent.setup();
    renderNew();
    await choose(user);

    const row = mappingRow("勘定科目の対応表", "交際費");
    expect(row).toHaveAttribute("data-status", "unmapped");
    expect(within(row).getByText("未定")).toBeInTheDocument();
    expect(within(row).getByRole("combobox", { name: "「交際費」の勘定科目" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(within(mappingRow("勘定科目の対応表", "普通預金")).getByText("保存済み")).toBeVisible();
    expect(within(mappingRow("勘定科目の対応表", "売上高")).getByText("案")).toBeVisible();
    expect(
      within(mappingRow("勘定科目の対応表", "売上高")).getByRole("combobox", {
        name: "「売上高」の勘定科目",
      }),
    ).toHaveValue("sales");
    expect(
      within(mappingRow("税区分の対応表", "課対仕入10%")).getByRole("combobox", {
        name: "「課対仕入10%」の税区分",
      }),
    ).toHaveValue("PURCHASE_10");

    const commit = screen.getByRole("button", { name: "取り込む" });
    expect(commit).toBeDisabled();
    expect(commit).toHaveAccessibleDescription(
      "対応が決まっていない名前が1件あります。対応表で選んで保存してください。",
    );
  });

  it("対応を選んで「対応表を保存」すると、保存してからプレビューを作り直す", async () => {
    let saved = false;
    const calls = mockImport({
      [`POST ${PREVIEW}`]: () => {
        const items = baseItems().map((i) =>
          saved && i.freeeJournalId === "J4"
            ? item("J4", "2025-06-01", {
                decision: "new",
                draft: draft("2025-06-01", 5500, "ent", "bank"),
              })
            : i,
        );
        return ok({ preview: buildPreview(items, { entertainmentMapped: saved }) });
      },
      [`PUT ${MAPPINGS}`]: () => {
        saved = true;
        return ok({ accounts: [], taxes: [] });
      },
    });
    const user = userEvent.setup();
    renderNew();
    await choose(user);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "「交際費」の勘定科目" }),
      "接待交際費",
    );
    // 保存していない変更があるうちは取り込めない
    expect(screen.getByRole("button", { name: "取り込む" })).toHaveAccessibleDescription(
      "対応表の変更を保存してから取り込んでください。",
    );
    await user.click(screen.getByRole("button", { name: "対応表を保存" }));

    await waitFor(() => expect(previewCalls(calls)).toHaveLength(2));
    // 変えた行と、案のままの行（利用者が確かめた案）を保存する。保存済みで変えていない行は送らない
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      accounts: [
        { sourceName: "売上高", accountId: "sales" },
        { sourceName: "事務用品費", accountId: "supplies" },
        { sourceName: "交際費", accountId: "ent" },
      ],
      taxes: [
        { sourceName: "課対仕入10%", taxCategory: "PURCHASE_10" },
        { sourceName: "対象外", taxCategory: "OUT_OF_SCOPE" },
      ],
    });
    const putIndex = calls.findIndex((c) => c.method === "PUT");
    expect(calls.findIndex((c, i) => i > putIndex && c.path === PREVIEW)).toBeGreaterThan(putIndex);

    expect(
      await within(mappingRow("勘定科目の対応表", "交際費")).findByText("保存済み"),
    ).toBeVisible();
    expect(summaryValue(screen.getByRole("region", { name: "プレビューの要約" }), "新規")).toBe(
      "4件",
    );
    expect(screen.getByRole("button", { name: "取り込む" })).toBeEnabled();
  });

  it("新しい科目のダイアログで科目を作り、その科目を選べる", async () => {
    let accounts = initialAccounts();
    const created = account("new-ent", "交際費", {
      category: "expense",
      normalSide: "debit",
      reportSection: "PL_EXPENSE",
      sortOrder: 5300,
      reportLine: 14,
    });
    const calls = mockImport(
      {
        [`GET ${ENTITY}/accounts`]: () => ok({ accounts }),
        [`POST ${PREVIEW}`]: () => ok({ preview: buildPreview(baseItems()) }),
        [`POST ${ENTITY}/accounts`]: () => {
          accounts = [...accounts, created];
          return ok({ account: created }, 201);
        },
      },
      accounts,
    );
    const user = userEvent.setup();
    renderNew();
    await choose(user);

    await user.click(
      within(mappingRow("勘定科目の対応表", "交際費")).getByRole("button", {
        name: "新しい科目を作る（交際費）",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "新しい勘定科目" });
    expect(within(dialog).getByLabelText("名称")).toHaveValue("交際費");
    expect(within(dialog).getByLabelText("区分")).toHaveValue("expense");
    expect(within(dialog).getByLabelText("決算書の区分")).toHaveValue("PL_EXPENSE");
    await user.type(within(dialog).getByLabelText("欄番号"), "14");
    await user.click(within(dialog).getByRole("button", { name: "作成して選ぶ" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "新しい勘定科目" })).not.toBeInTheDocument(),
    );
    expect(calls.find((c) => c.method === "POST" && c.path === `${ENTITY}/accounts`)?.body).toEqual(
      { name: "交際費", category: "expense", reportSection: "PL_EXPENSE", reportLine: 14 },
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "「交際費」の勘定科目" })).toHaveValue("new-ent"),
    );
    expect(screen.getByRole("combobox", { name: "「交際費」の勘定科目" })).not.toHaveAttribute(
      "aria-invalid",
    );
  });

  it("科目の作成に失敗したら、ダイアログの中にエラーを表示する", async () => {
    mockImport({
      [`POST ${PREVIEW}`]: () => ok({ preview: buildPreview(baseItems()) }),
      [`POST ${ENTITY}/accounts`]: () =>
        apiError(422, "VALIDATION", "入力が正しくありません", {
          issues: [{ path: ["name"], message: "同じ名称の科目があります" }],
        }),
    });
    const user = userEvent.setup();
    renderNew();
    await choose(user);

    await user.click(screen.getByRole("button", { name: "新しい科目を作る（交際費）" }));
    const dialog = await screen.findByRole("dialog", { name: "新しい勘定科目" });
    await user.click(within(dialog).getByRole("button", { name: "作成して選ぶ" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("同じ名称の科目があります");
    // ダイアログを開いている間、背後の画面は aria-hidden になる
    expect(
      screen.getByRole("combobox", { name: "「交際費」の勘定科目", hidden: true }),
    ).toHaveValue("");
  });
});

describe("新しい取込: 年度と個別の指定（T026）", () => {
  it("年度のチェックを外すと、その年度を除いてプレビューを作り直し、件数が変わる", async () => {
    const calls = mockImport({
      [`POST ${PREVIEW}`]: (call) => {
        const years: number[] | undefined = optionsOf(call).fiscalYears;
        const items = baseItems().map((i) =>
          years && !years.includes(Number(i.date.slice(0, 4)))
            ? item(i.freeeJournalId, i.date, { decision: "excluded", reason: "YEAR_NOT_SELECTED" })
            : i,
        );
        return ok({ preview: buildPreview(items) });
      },
    });
    const user = userEvent.setup();
    renderNew();
    const summary = await choose(user);
    expect(summaryValue(summary, "新規")).toBe("3件");

    await user.click(screen.getByRole("checkbox", { name: "2026年" }));

    await waitFor(() => expect(summaryValue(summary, "新規")).toBe("2件"));
    expect(optionsOf(previewCalls(calls)[1] as ApiCall)).toEqual({ fiscalYears: [2025] });
    expect(summaryValue(summary, "対象外")).toBe("2件");
    expect(screen.getByRole("checkbox", { name: "2026年" })).not.toBeChecked();
    expect(planRow("No.5")).toHaveTextContent("取り込む年度に選ばれていない");

    await user.click(screen.getByRole("checkbox", { name: "2026年" }));
    await waitFor(() => expect(summaryValue(summary, "新規")).toBe("3件"));
    expect(optionsOf(previewCalls(calls)[2] as ApiCall)).toEqual({ fiscalYears: [2025, 2026] });
  });

  it("会計期間のない年度は選べず、会計期間の作成を案内する", async () => {
    mockImport({
      [`GET ${ENTITY}/fiscal-periods`]: () =>
        ok({
          fiscalPeriods: [
            {
              id: "p2025",
              fiscalYear: 2025,
              startDate: "2025-01-01",
              endDate: "2025-12-31",
              status: "open",
              closedAt: null,
            },
          ],
        }),
      [`POST ${PREVIEW}`]: () => {
        const p = buildPreview(baseItems());
        return ok({
          preview: {
            ...p,
            years: [
              { ...(p.years[0] as ImportPreview["years"][number]), closed: true },
              {
                fiscalYear: 2026,
                hasPeriod: false,
                closed: false,
                counts: { new: 0, already: 0, excluded: 0, rejected: 1 },
              },
            ],
          },
        });
      },
    });
    const user = userEvent.setup();
    renderNew();
    await choose(user);

    const y2026 = screen.getByRole("checkbox", { name: "2026年" });
    expect(y2026).toBeDisabled();
    expect(y2026).not.toBeChecked();
    expect(
      await within(y2026.closest("li") as HTMLElement).findByText(/翌年度を作成してください/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "会計期間" })).toHaveAttribute("href", "/e/e1/periods");
    expect(screen.getByRole("checkbox", { name: "2025年" }).closest("li")).toHaveTextContent(
      "締め済み",
    );
  });

  it("取込対象外の仕訳を個別に含め、また外せる", async () => {
    const calls = mockImport({
      [`POST ${PREVIEW}`]: (call) => {
        const { include = [], exclude = [] } = optionsOf(call) as {
          include?: string[];
          exclude?: string[];
        };
        const items = baseItems().map((i) => {
          if (include.includes(i.freeeJournalId))
            return item(i.freeeJournalId, i.date, {
              decision: "new",
              draft: draft(i.date, 1000, "bank", "sales"),
            });
          if (exclude.includes(i.freeeJournalId))
            return item(i.freeeJournalId, i.date, {
              decision: "excluded",
              reason: "USER_EXCLUDED",
            });
          return i;
        });
        return ok({ preview: buildPreview(items) });
      },
    });
    const user = userEvent.setup();
    renderNew();
    const summary = await choose(user);

    await user.click(within(planRow("No.1")).getByRole("button", { name: "含める（No.1）" }));

    await waitFor(() => expect(summaryValue(summary, "新規")).toBe("4件"));
    expect(optionsOf(previewCalls(calls)[1] as ApiCall)).toEqual({ include: ["J1"] });
    expect(within(planRow("No.1")).getByText("新規")).toBeInTheDocument();

    // 新規の仕訳を個別に外す
    await user.click(within(planRow("No.2")).getByRole("button", { name: "外す（No.2）" }));
    await waitFor(() => expect(planRow("No.2")).toHaveTextContent("個別に外した"));
    expect(optionsOf(previewCalls(calls)[2] as ApiCall)).toEqual({
      include: ["J1"],
      exclude: ["J2"],
    });

    // 外した仕訳を戻し、含めた仕訳を対象外に戻す
    await user.click(within(planRow("No.2")).getByRole("button", { name: "含める（No.2）" }));
    await waitFor(() => expect(previewCalls(calls)).toHaveLength(4));
    await user.click(within(planRow("No.1")).getByRole("button", { name: "外す（No.1）" }));
    await waitFor(() => expect(previewCalls(calls)).toHaveLength(5));
    expect(optionsOf(previewCalls(calls)[4] as ApiCall)).toEqual({});
    await waitFor(() =>
      expect(planRow("No.1")).toHaveTextContent("前年の決算整理（期首残高に反映済み）"),
    );
  });
});

describe("新しい取込: 確定（T026）", () => {
  const batch: ImportBatch = {
    id: "b1",
    source: "freee_journal",
    fileName: "仕訳帳_2025.csv",
    fileSha256: SHA,
    importedAt: "2026-10-19T02:00:00.000Z",
    periodFrom: "2025-01-01",
    periodTo: "2025-12-31",
    fiscalYears: [2025],
    countNew: 3,
    countAlready: 0,
    countExcluded: 1,
    countRejected: 0,
    countWarnings: 1,
    status: "active",
    voidedAt: null,
    voidReason: null,
  };
  const readyItems = () => baseItems().filter((i) => i.freeeJournalId !== "J4");

  it("「取り込む」で確定し、件数と取込の詳細へのリンクを表示する", async () => {
    const preview = buildPreview(readyItems(), { entertainmentMapped: true });
    const calls = mockImport({
      [`POST ${PREVIEW}`]: () => ok({ preview }),
      [`POST ${COMMIT}`]: () => ok({ batch, preview }, 201),
    });
    const user = userEvent.setup();
    renderNew();
    await choose(user);

    await user.click(screen.getByRole("button", { name: "取り込む" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("3件の仕訳を取り込みました");
    expect(within(status).getByRole("link", { name: "取込の詳細を見る" })).toHaveAttribute(
      "href",
      "/e/e1/imports/b1",
    );
    expect(formFields(calls.find((c) => c.path === COMMIT)?.form)).toEqual({
      file: { name: "仕訳帳_2025.csv", type: "text/csv", size: csv().size },
      options: "{}",
      expected: JSON.stringify({ fileSha256: SHA, countNew: 3 }),
    });
    expect(screen.queryByRole("button", { name: "取り込む" })).not.toBeInTheDocument();
  });

  it("確定の前に帳簿が変わったら、新しいプレビューに差し替えて知らせる", async () => {
    const preview = buildPreview(readyItems(), { entertainmentMapped: true });
    const changed = buildPreview(
      readyItems().map((i) =>
        i.freeeJournalId === "J2"
          ? item("J2", i.date, { decision: "already", reason: "ALREADY_IMPORTED" })
          : i,
      ),
      { entertainmentMapped: true },
    );
    mockImport({
      [`POST ${PREVIEW}`]: () => ok({ preview }),
      [`POST ${COMMIT}`]: () =>
        apiError(409, "IMPORT_PLAN_CHANGED", "プレビューの件数が変わりました", {
          preview: changed,
        }),
    });
    const user = userEvent.setup();
    renderNew();
    const summary = await choose(user);

    await user.click(screen.getByRole("button", { name: "取り込む" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "プレビューの後に帳簿が変わったため、プレビューを作り直しました",
    );
    expect(summaryValue(summary, "新規")).toBe("2件");
    expect(summaryValue(summary, "取込済み")).toBe("1件");
    expect(screen.getByRole("button", { name: "取り込む" })).toBeEnabled();
  });

  it("すべて取込済みなら「取り込む」が押せない", async () => {
    const items = readyItems().map((i) =>
      item(i.freeeJournalId, i.date, { decision: "already", reason: "ALREADY_IMPORTED" }),
    );
    mockImport({
      [`POST ${PREVIEW}`]: () =>
        ok({ preview: buildPreview(items, { entertainmentMapped: true }) }),
    });
    const user = userEvent.setup();
    renderNew();
    const summary = await choose(user);

    expect(summaryValue(summary, "取込済み")).toBe("4件");
    const commit = screen.getByRole("button", { name: "取り込む" });
    expect(commit).toBeDisabled();
    expect(commit).toHaveAccessibleDescription(
      "新しく取り込む仕訳はありません（すべて取込済みです）。",
    );
  });
});
