import { screen, within } from "@testing-library/react";
import type { ImportBatch, ImportBatchJournal } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/imports/$batchId";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const DETAIL = "/api/entities/e1/imports/b1";

const batch: ImportBatch = {
  id: "b1",
  source: "freee_journal",
  fileName: "仕訳帳_2025.csv",
  fileSha256: "ab".repeat(32),
  importedAt: "2026-10-19T02:00:00.000Z",
  periodFrom: "2025-01-01",
  periodTo: "2025-12-31",
  fiscalYears: [2025],
  countNew: 2,
  countAlready: 0,
  countExcluded: 1,
  countRejected: 0,
  countWarnings: 0,
  status: "active",
  voidedAt: null,
  voidReason: null,
};

const journals: ImportBatchJournal[] = [
  {
    journalId: "j1",
    journalNo: 101,
    date: "2025-01-15",
    freeeJournalId: "F-1",
    status: "active",
    version: 1,
  },
  {
    journalId: "j2",
    journalNo: 102,
    date: "2025-03-10",
    freeeJournalId: "F-2",
    status: "voided",
    version: 2,
  },
];

function renderDetail() {
  return renderRoute(Route, { path: "/e/$entityId/imports/$batchId", url: "/e/e1/imports/b1" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("取込の詳細（T034）", () => {
  it("取込の概要と、取り込んだ仕訳の一覧（仕訳へのリンク）を表示する", async () => {
    mockApi({ [`GET ${DETAIL}`]: () => ok({ batch, journals }) });
    renderDetail();

    expect(
      await screen.findByRole("heading", { level: 1, name: "取込の詳細: 仕訳帳_2025.csv" }),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "取り込んだ仕訳" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "101" })).toHaveAttribute(
      "href",
      "/e/e1/journals/j1",
    );
    expect(rows[0]).toHaveTextContent("2025-01-15");
    expect(rows[0]).toHaveTextContent("F-1");
    expect(rows[1]).toHaveTextContent("取消済み");
    expect(screen.getByRole("link", { name: "取込の履歴へ" })).toHaveAttribute(
      "href",
      "/e/e1/imports",
    );
  });

  it("取込がなければ、その旨を表示する", async () => {
    mockApi({
      [`GET ${DETAIL}`]: () => apiError(404, "IMPORT_BATCH_NOT_FOUND", "取込が見つかりません"),
    });
    renderDetail();

    expect(await screen.findByRole("alert")).toHaveTextContent("取込が見つかりません。");
  });
});
