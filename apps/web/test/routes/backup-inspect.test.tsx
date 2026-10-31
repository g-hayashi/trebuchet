import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackupInspection } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/settings/backup";
import { apiError, formFields, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// T014: 設定 → 復元の「検査」（FR-024・027）。画面からは復元しない

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const inspection: BackupInspection = {
  createdAt: "2026-10-20T09:00:00.000Z",
  macId: "9f3c2b1a-1111-4222-8333-444455556666",
  appVersion: { registry: 3, tenant: 4 },
  entities: [
    {
      id: "0192f3a0-0000-7000-8000-000000000001",
      name: "事業 A",
      fiscalYears: [
        { year: 2025, journals: 3 },
        { year: 2026, journals: 12 },
      ],
    },
  ],
};

function open(inspect: Parameters<typeof mockApi>[0][string]) {
  const calls = mockApi({
    "GET /api/backup/runs": () => ok({ runs: [] }),
    "POST /api/backup/inspect": inspect,
  });
  renderRoute(Route, { path: "/settings/backup", url: "/settings/backup" });
  return calls;
}

async function submit() {
  const file = new File(["bytes"], "trebuchet-9f3c2b1a-20261020.tbk", {
    type: "application/octet-stream",
  });
  await userEvent.upload(await screen.findByLabelText("バックアップのファイル"), file);
  await userEvent.click(screen.getByRole("button", { name: "検査" }));
}

describe("バックアップの検査（008 の D9: 解錠中の鍵で検査する。パスフレーズの入力はない）", () => {
  it("ファイルだけを送り、要約を表示する。パスフレーズの欄はない", async () => {
    const calls = open(() => ok(inspection));
    expect(await screen.findByLabelText("バックアップのファイル")).toBeInTheDocument();
    expect(screen.queryByLabelText(/パスフレーズ/)).not.toBeInTheDocument();
    await submit();
    expect(await screen.findByText("事業 A")).toBeInTheDocument();
    const sent = calls.find((c) => c.path === "/api/backup/inspect");
    expect(formFields(sent?.form)).toEqual({
      file: { name: "trebuchet-9f3c2b1a-20261020.tbk", type: "application/octet-stream", size: 5 },
    });
    const summary = screen.getByRole("region", { name: "検査の結果" });
    expect(summary).toHaveTextContent("9f3c2b1a-1111-4222-8333-444455556666");
    expect(summary).toHaveTextContent("2025年度");
    expect(summary).toHaveTextContent("3件");
    expect(summary).toHaveTextContent("2026年度");
    expect(summary).toHaveTextContent("12件");
  });

  it("成功すると、復元のコマンドの手順を表示する。画面から復元するボタンはない", async () => {
    open(() => ok(inspection));
    await submit();
    const steps = await screen.findByRole("region", { name: "復元の手順" });
    expect(steps).toHaveTextContent("server を止める");
    expect(steps).toHaveTextContent("pnpm restore -- --file <path> [--data-dir <dir>]");
    expect(steps).toHaveTextContent("回復キー");
    expect(steps).toHaveTextContent("パスキーを登録");
    expect(screen.queryByRole("button", { name: /復元/ })).not.toBeInTheDocument();
  });

  it("別の帳簿のバックアップ・ファイルが壊れているときは、区別せず同じ文言を出す。手順は出さない", async () => {
    open(() => apiError(422, "BACKUP_INVALID", "x"));
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "このアプリのバックアップではないか、ファイルが壊れています",
    );
    expect(screen.queryByRole("region", { name: "復元の手順" })).not.toBeInTheDocument();
  });

  it("アプリの版が一致しないときの文言", async () => {
    open(() => apiError(422, "BACKUP_VERSION_MISMATCH", "x"));
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "アプリの版が一致しません。このバックアップを取った版のアプリで復元してください",
    );
  });

  it("大きすぎるときの文言（上限は応答の maxBytes から）", async () => {
    open(() => apiError(413, "FILE_TOO_LARGE", "x", { maxBytes: 200 * 1024 * 1024 }));
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("200 MB まで");
  });

  it("ファイルが空の間は検査できない。失敗の後に直して再度検査すると、前の失敗は消える", async () => {
    let n = 0;
    open(() => (n++ === 0 ? apiError(422, "BACKUP_INVALID", "x") : ok(inspection)));
    expect(await screen.findByRole("button", { name: "検査" })).toBeDisabled();
    await submit();
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "検査" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await screen.findByRole("region", { name: "復元の手順" })).toBeInTheDocument();
  });
});
