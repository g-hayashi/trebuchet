import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReceiptDetail, ReceiptHistoryEntry } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/receipts/$receiptId";
import { type ApiCall, apiError, formFields, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, RECEIPT_SHA, receiptDetail } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T029: 訂正・差し替え・削除・履歴（H: §2・§8。US5）。理由の要否は web で判断せず、422 REASON_REQUIRED を受けて求める

const DETAIL = `/api/entities/e1/receipts/${RECEIPT_ID}`;
const SHA_OLD = "b".repeat(64);

const renderDetail = () =>
  renderRoute(Route, {
    path: "/e/$entityId/receipts/$receiptId",
    url: `/e/e1/receipts/${RECEIPT_ID}`,
  });

const callsOf = (calls: ApiCall[], method: string, suffix = "") =>
  calls.filter((c) => c.method === method && c.path === `${DETAIL}${suffix}`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("訂正（入力済みの値の変更）", () => {
  it("422 REASON_REQUIRED を受けたら理由を求め、同じ変更に reason を足して送り直す", async () => {
    let current = receiptDetail();
    const calls = mockApi({
      [`GET ${DETAIL}`]: () => ok({ receipt: current }),
      [`PATCH ${DETAIL}`]: ({ body }) => {
        const input = body as { version: number; amount?: number; reason?: string };
        if (input.reason === undefined) {
          return apiError(422, "REASON_REQUIRED", "入力済みの値を変えるときは理由が必要です");
        }
        current = { ...current, amount: input.amount ?? null, version: current.version + 1 };
        return ok({ receipt: current });
      },
    });
    renderDetail();
    const form = await screen.findByRole("form", { name: "証憑の値" });
    const user = userEvent.setup();
    await user.clear(within(form).getByLabelText("金額"));
    await user.type(within(form).getByLabelText("金額"), "2000");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("理由")).toBeInTheDocument();
    expect(callsOf(calls, "PATCH")[0]?.body).toEqual({ version: 1, amount: 2000 });
    await user.type(within(dialog).getByLabelText("理由"), "金額の誤り");
    await user.click(within(dialog).getByRole("button", { name: "訂正を確定" }));

    await waitFor(() => expect(callsOf(calls, "PATCH")).toHaveLength(2));
    expect(callsOf(calls, "PATCH")[1]?.body).toEqual({
      version: 1,
      amount: 2000,
      reason: "金額の誤り",
    });
    expect(await within(form).findByText("保存しました。")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("理由を求められて戻ると送らない（値は変わらない）", async () => {
    const calls = mockApi({
      [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail() }),
      [`PATCH ${DETAIL}`]: () => apiError(422, "REASON_REQUIRED", "理由が必要です"),
    });
    renderDetail();
    const form = await screen.findByRole("form", { name: "証憑の値" });
    const user = userEvent.setup();
    await user.clear(within(form).getByLabelText("取引先"));
    await user.type(within(form).getByLabelText("取引先"), "別の店");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callsOf(calls, "PATCH")).toHaveLength(1);
  });
});

describe("ファイルの差し替え（撮り直し）", () => {
  it("ファイルを選び、理由を入れて multipart で送る（options は reason と version）", async () => {
    let current = receiptDetail({ category: "paper_scan" });
    const calls = mockApi({
      [`GET ${DETAIL}`]: () => ok({ receipt: current }),
      [`POST ${DETAIL}/files`]: () => {
        current = receiptDetail({
          category: "paper_scan",
          version: 2,
          warnings: [{ code: "NOT_FULL_COLOR" }],
        });
        return ok({ receipt: current }, 201);
      },
    });
    renderDetail();
    const section = await screen.findByRole("region", { name: "ファイルの差し替え" });
    const user = userEvent.setup();
    expect(within(section).getByRole("button", { name: "差し替える" })).toBeDisabled();
    await user.upload(
      within(section).getByLabelText("撮り直したファイル"),
      new File([new Uint8Array(10)], "撮り直し.jpg", { type: "image/jpeg" }),
    );
    await user.click(within(section).getByRole("button", { name: "差し替える" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("理由"), "ぼやけていたため");
    await user.click(within(dialog).getByRole("button", { name: "差し替えを確定" }));

    await waitFor(() => expect(callsOf(calls, "POST", "/files")).toHaveLength(1));
    const fields = formFields(callsOf(calls, "POST", "/files")[0]?.form);
    expect(fields?.file).toMatchObject({ name: "撮り直し.jpg" });
    expect(JSON.parse(String(fields?.options))).toEqual({ reason: "ぼやけていたため", version: 1 });
    // 差し替え後の警告は証憑の警告として出る（保存は済んでいる）
    expect(await screen.findByRole("list", { name: "警告" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("重複などの失敗はダイアログに示し、閉じない", async () => {
    mockApi({
      [`GET ${DETAIL}`]: () => ok({ receipt: receiptDetail() }),
      [`POST ${DETAIL}/files`]: () =>
        apiError(409, "RECEIPT_DUPLICATE", "同じ内容のファイルがすでにあります"),
    });
    renderDetail();
    const section = await screen.findByRole("region", { name: "ファイルの差し替え" });
    const user = userEvent.setup();
    await user.upload(
      within(section).getByLabelText("撮り直したファイル"),
      new File([new Uint8Array(10)], "again.jpg", { type: "image/jpeg" }),
    );
    await user.click(within(section).getByRole("button", { name: "差し替える" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("理由"), "撮り直し");
    await user.click(within(dialog).getByRole("button", { name: "差し替えを確定" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "同じファイルがすでにあります",
    );
  });
});

describe("削除", () => {
  it("理由を入れて POST …/delete（reason と version）。削除済みの表示になり、操作が消える", async () => {
    let current = receiptDetail();
    const calls = mockApi({
      [`GET ${DETAIL}`]: () => ok({ receipt: current }),
      [`POST ${DETAIL}/delete`]: ({ body }) => {
        current = receiptDetail({
          deleted: true,
          deletedAt: "2026-10-21T00:00:00.000Z",
          deletedReason: (body as { reason: string }).reason,
          version: 2,
        });
        return ok({ receipt: current });
      },
    });
    renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "この証憑を削除" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("理由"), "重複して取り込んだ");
    await user.click(within(dialog).getByRole("button", { name: "削除を確定" }));

    await waitFor(() => expect(callsOf(calls, "POST", "/delete")).toHaveLength(1));
    expect(callsOf(calls, "POST", "/delete")[0]?.body).toEqual({
      reason: "重複して取り込んだ",
      version: 1,
    });
    expect(await screen.findByText(/削除済みです/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "この証憑を削除" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "ファイルの差し替え" })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "証憑の値" })).not.toBeInTheDocument();
  });

  it("結びつきがあれば 409 RECEIPT_LINKED。先に解除するよう促し、削除はされない", async () => {
    const calls = mockApi({
      [`GET ${DETAIL}`]: () =>
        ok({
          receipt: receiptDetail({
            linkState: "linked",
            journal: { id: "j1", journalNo: 12, date: "2026-10-20", status: "active" },
          }),
        }),
      [`POST ${DETAIL}/delete`]: () =>
        apiError(409, "RECEIPT_LINKED", "仕訳に結びついた証憑は削除できません", {
          journalId: "j1",
        }),
    });
    renderDetail();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "この証憑を削除" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("理由"), "不要");
    await user.click(within(dialog).getByRole("button", { name: "削除を確定" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callsOf(calls, "POST", "/delete")).toHaveLength(1);
    expect(await screen.findByRole("alert")).toHaveTextContent(/先に.*結びつきを解除/);
  });
});

describe("履歴", () => {
  const history: ReceiptHistoryEntry[] = [
    {
      occurredAt: "2026-10-20T09:00:00.000Z",
      targetType: "receipt",
      action: "create",
      reason: null,
      before: null,
      after: { category: "electronic", amount: 1100, sha256: RECEIPT_SHA },
    },
    {
      occurredAt: "2026-10-21T09:00:00.000Z",
      targetType: "receipt",
      action: "update",
      reason: "金額の誤り",
      before: { category: "electronic", amount: 1100, partnerName: "合成の店", memo: null },
      after: { category: "electronic", amount: 2000, partnerName: "合成の店", memo: null },
    },
    {
      occurredAt: "2026-10-22T09:00:00.000Z",
      targetType: "receipt",
      action: "replace_file",
      reason: "撮り直し",
      before: { sha256: SHA_OLD, fileVersion: 1 },
      after: { sha256: RECEIPT_SHA, fileVersion: 2 },
    },
  ];

  const twoFiles = () => {
    const first = { ...receiptDetail().currentFile, sha256: SHA_OLD, fileVersion: 1 };
    const second = { ...receiptDetail().currentFile, sha256: RECEIPT_SHA, fileVersion: 2 };
    return receiptDetail({ version: 3, currentFile: second, files: [first, second] });
  };

  it("操作・日時・理由と、訂正の前後の値を示す", async () => {
    mockApi({
      [`GET ${DETAIL}`]: () => ok({ receipt: twoFiles() }),
      [`GET ${DETAIL}/history`]: () => ok({ history }),
    });
    renderDetail();
    const section = await screen.findByRole("region", { name: "履歴" });
    const items = await within(section).findAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("追加"),
      expect.stringContaining("訂正"),
      expect.stringContaining("ファイルを差し替え"),
    ]);
    expect(items[1]).toHaveTextContent("金額の誤り");
    expect(items[1]).toHaveTextContent("1,100");
    expect(items[1]).toHaveTextContent("2,000");
    // 変わっていない項目は出さない
    expect(items[1]).not.toHaveTextContent("合成の店");
    expect(items[2]).toHaveTextContent("撮り直し");
  });

  it("差し替え前の版の画像を原本で開ける。今の版にもリンクがある", async () => {
    mockApi({
      [`GET ${DETAIL}`]: () => ok({ receipt: twoFiles() }),
      [`GET ${DETAIL}/history`]: () => ok({ history }),
    });
    renderDetail();
    const section = await screen.findByRole("region", { name: "履歴" });
    const old = await within(section).findByRole("link", { name: "版 1 を開く" });
    expect(old).toHaveAttribute(
      "href",
      `/api/entities/e1/receipts/${RECEIPT_ID}/files/${SHA_OLD}?variant=original`,
    );
    expect(within(section).getByRole("link", { name: "版 2 を開く" })).toBeInTheDocument();
  });

  it("削除済みの証憑も履歴を開ける。削除の理由が出る", async () => {
    mockApi({
      [`GET ${DETAIL}`]: () =>
        ok({
          receipt: receiptDetail({
            deleted: true,
            deletedAt: "2026-10-23T00:00:00.000Z",
            deletedReason: "重複",
          } as Partial<ReceiptDetail>),
        }),
      [`GET ${DETAIL}/history`]: () =>
        ok({
          history: [
            ...history.slice(0, 1),
            {
              occurredAt: "2026-10-23T00:00:00.000Z",
              targetType: "receipt",
              action: "delete",
              reason: "重複",
              before: { amount: 1100 },
              after: { deletedAt: "2026-10-23T00:00:00.000Z" },
            },
          ],
        }),
    });
    renderDetail();
    const section = await screen.findByRole("region", { name: "履歴" });
    const items = await within(section).findAllByRole("listitem");
    expect(items[1]).toHaveTextContent("削除");
    expect(items[1]).toHaveTextContent("重複");
  });
});
