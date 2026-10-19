import { screen, within } from "@testing-library/react";
import type { ImportBatch } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "@/lib/format";
import { Route } from "@/routes/e/$entityId/imports/index";
import { mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const IMPORTS = "/api/entities/e1/imports";

const batch = (id: string, rest: Partial<ImportBatch>): ImportBatch => ({
  id,
  source: "freee_journal",
  fileName: `${id}.csv`,
  fileSha256: "ab".repeat(32),
  importedAt: "2026-10-19T02:00:00.000Z",
  periodFrom: "2025-01-01",
  periodTo: "2025-12-31",
  fiscalYears: [2025],
  countNew: 1,
  countAlready: 0,
  countExcluded: 0,
  countRejected: 0,
  countWarnings: 0,
  status: "active",
  voidedAt: null,
  voidReason: null,
  ...rest,
});

const latest = batch("b2", {
  fileName: "仕訳帳_2025_10月.csv",
  importedAt: "2026-10-19T02:30:00.000Z",
  countNew: 12,
  countAlready: 480,
  countExcluded: 3,
  countRejected: 1,
});
const voided = batch("b1", {
  fileName: "仕訳帳_2025.csv",
  importedAt: "2026-09-01T00:00:00.000Z",
  countNew: 480,
  status: "voided",
  voidedAt: "2026-09-02T00:00:00.000Z",
  voidReason: "対応表の誤り",
});

function renderImports() {
  return renderRoute(Route, { path: "/e/$entityId/imports/", url: "/e/e1/imports" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("取込の履歴（T026）", () => {
  it("取込の日時・ファイル名・件数・状態を、API の順（新しい順）に表示する", async () => {
    mockApi({ [`GET ${IMPORTS}`]: () => ok({ batches: [latest, voided] }) });
    renderImports();

    const table = await screen.findByRole("table", { name: "取込の履歴" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);

    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(first).toHaveTextContent(formatDateTime(latest.importedAt));
    expect(within(first).getByRole("link", { name: "仕訳帳_2025_10月.csv" })).toHaveAttribute(
      "href",
      "/e/e1/imports/b2",
    );
    expect(first).toHaveTextContent("2025-01-01 〜 2025-12-31");
    expect(first).toHaveTextContent("12件");
    expect(first).toHaveTextContent("取込済み 480件・対象外 3件・取込不可 1件");
    expect(first).toHaveTextContent("有効");

    expect(second).toHaveTextContent(formatDateTime(voided.importedAt));
    expect(within(second).getByRole("link", { name: "仕訳帳_2025.csv" })).toHaveAttribute(
      "href",
      "/e/e1/imports/b1",
    );
    expect(second).toHaveTextContent("480件");
    expect(second).toHaveTextContent("取消済み");
    expect(second).toHaveClass("text-muted-foreground");

    expect(screen.getByRole("link", { name: "新しい取込" })).toHaveAttribute(
      "href",
      "/e/e1/imports/new",
    );
  });

  it("取込がまだないときは、その旨を表示する", async () => {
    mockApi({ [`GET ${IMPORTS}`]: () => ok({ batches: [] }) });
    renderImports();

    expect(await screen.findByText("まだ取込はありません。")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "取込の履歴" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "新しい取込" })).toBeInTheDocument();
  });
});
