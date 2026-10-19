import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImportBatch, ImportBatchJournal } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/imports/$batchId";
import { type ApiCall, type ApiReply, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const DETAIL = "/api/entities/e1/imports/b1";
const VOID = `${DETAIL}/void`;

const activeBatch: ImportBatch = {
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
  countExcluded: 0,
  countRejected: 0,
  countWarnings: 0,
  status: "active",
  voidedAt: null,
  voidReason: null,
};

const voidedBatch = (reason: string): ImportBatch => ({
  ...activeBatch,
  status: "voided",
  voidedAt: "2026-10-19T03:00:00.000Z",
  voidReason: reason,
});

const journal = (n: number, rest: Partial<ImportBatchJournal> = {}): ImportBatchJournal => ({
  journalId: `j${n}`,
  journalNo: 100 + n,
  date: `2025-0${n}-15`,
  freeeJournalId: `F-${n}`,
  status: "active",
  version: 1,
  ...rest,
});

const journals = [journal(1, { version: 2 }), journal(2)];

/** 取消の API のモック。void の応答を順に返し、成功したら詳細を取消済みにする */
function mockBatch(voidReplies: ((call: ApiCall) => ApiReply)[], batch = activeBatch) {
  let current = batch;
  let index = 0;
  const calls = mockApi({
    [`GET ${DETAIL}`]: () =>
      ok({
        batch: current,
        journals:
          current.status === "voided"
            ? journals.map((j) => ({ ...j, status: "voided" as const }))
            : journals,
      }),
    [`POST ${VOID}`]: (call) => {
      const reply = voidReplies[index++];
      if (!reply) throw new Error("取消の応答が足りません");
      const result = reply(call);
      if (result.status === 200) current = voidedBatch((call.body as { reason: string }).reason);
      return result;
    },
  });
  return calls;
}

const voided = (call: ApiCall) =>
  ok({ batch: voidedBatch((call.body as { reason: string }).reason), voidedCount: 2 });

function renderDetail() {
  return renderRoute(Route, { path: "/e/$entityId/imports/$batchId", url: "/e/e1/imports/b1" });
}

/** 「取込を取り消す」でダイアログを開き、理由を入力する */
async function openAndType(user: ReturnType<typeof userEvent.setup>, reason: string) {
  await user.click(await screen.findByRole("button", { name: "取込を取り消す" }));
  const dialog = await screen.findByRole("dialog", { name: "取込の取消" });
  if (reason) await user.type(within(dialog).getByLabelText("理由"), reason);
  return dialog;
}

const voidCalls = (calls: ApiCall[]) => calls.filter((c) => c.path === VOID);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("取込の取消（T057）", () => {
  it("理由が空なら確定できず、入力して確定すると取消済みになり、ボタンが消える", async () => {
    const calls = mockBatch([voided]);
    const user = userEvent.setup();
    renderDetail();

    const dialog = await openAndType(user, "");
    expect(dialog).toHaveTextContent("2件");
    const confirm = within(dialog).getByRole("button", { name: "取消を確定" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("理由"), "   ");
    expect(confirm).toBeDisabled();
    await user.clear(within(dialog).getByLabelText("理由"));
    await user.type(within(dialog).getByLabelText("理由"), "対応表の誤り");
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(voidCalls(calls)).toHaveLength(1);
    expect(voidCalls(calls)[0]?.body).toEqual({ reason: "対応表の誤り" });
    expect(await screen.findByText(/取消済み（.+）: 対応表の誤り/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2件の仕訳を取り消しました");
    expect(screen.queryByRole("button", { name: "取込を取り消す" })).toBeNull();
  });

  it("訂正済みの仕訳があると件数を表示して再確認を求め、確認すると confirmCorrected を送る", async () => {
    const calls = mockBatch([
      () =>
        apiError(409, "CORRECTED_JOURNALS", "取込の後に訂正された仕訳があります", {
          count: 1,
          journalIds: ["j1"],
        }),
      voided,
    ]);
    const user = userEvent.setup();
    renderDetail();

    const dialog = await openAndType(user, "対応表の誤り");
    await user.click(within(dialog).getByRole("button", { name: "取消を確定" }));

    const notice = await within(dialog).findByRole("alert");
    expect(notice).toHaveTextContent("取込の後に訂正された仕訳が1件あります");
    expect(within(notice).getByRole("link", { name: "101" })).toHaveAttribute(
      "href",
      "/e/e1/journals/j1",
    );
    expect(within(dialog).queryByRole("button", { name: "取消を確定" })).toBeNull();
    await user.click(
      within(dialog).getByRole("button", { name: "訂正済みの仕訳を含めて取り消す" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(voidCalls(calls).map((c) => c.body)).toEqual([
      { reason: "対応表の誤り" },
      { reason: "対応表の誤り", confirmCorrected: true },
    ]);
    expect(await screen.findByText(/取消済み/, { selector: "dd" })).toBeInTheDocument();
  });

  it("締め済みの年度を含むなら、締めの解除が必要と表示する", async () => {
    mockBatch([
      () =>
        apiError(409, "PERIOD_CLOSED", "締め済みの会計期間は変更できません", {
          fiscalYears: [2025],
        }),
    ]);
    const user = userEvent.setup();
    renderDetail();

    const dialog = await openAndType(user, "対応表の誤り");
    await user.click(within(dialog).getByRole("button", { name: "取消を確定" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("2025年度は締め済みのため、この取込は取り消せません");
    expect(alert).toHaveTextContent("締めを解除してから");
    expect(within(alert).getByRole("link", { name: "会計期間" })).toHaveAttribute(
      "href",
      "/e/e1/periods",
    );
    expect(screen.getByText("有効")).toBeInTheDocument();
  });

  it("すでに取り消されていたら、その旨を表示する", async () => {
    mockBatch([() => apiError(409, "IMPORT_BATCH_VOIDED", "取消済みの取込です")]);
    const user = userEvent.setup();
    renderDetail();

    const dialog = await openAndType(user, "対応表の誤り");
    await user.click(within(dialog).getByRole("button", { name: "取消を確定" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "この取込はすでに取り消されています。",
    );
  });

  it("サーバーが理由の空欄を拒否したら、理由の欄に表示する", async () => {
    mockBatch([() => apiError(422, "REASON_REQUIRED", "理由を入力してください")]);
    const user = userEvent.setup();
    renderDetail();

    const dialog = await openAndType(user, "\u200b");
    await user.click(within(dialog).getByRole("button", { name: "取消を確定" }));

    const input = within(dialog).getByLabelText("理由");
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(input).toHaveAccessibleDescription("理由を入力してください");
  });

  it("取消済みの取込には、取消のボタンを表示しない", async () => {
    mockBatch([], voidedBatch("対応表の誤り"));
    renderDetail();

    expect(await screen.findByText(/取消済み（.+）: 対応表の誤り/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取込を取り消す" })).toBeNull();
  });
});
