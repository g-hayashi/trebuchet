import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReceiptDetail } from "@trebuchet/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { receiptKeys } from "@/features/receipts/api";
import { Route } from "@/routes/e/$entityId/receipts/$receiptId";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { RECEIPT_ID, receiptDetail } from "../receipts-fixtures";
import { renderRoute } from "../render-route";

// T017b: 理由なしで未入力の値を埋める（H: §2 の PATCH。US2 シナリオ 3、D1）

const DETAIL = `/api/entities/e1/receipts/${RECEIPT_ID}`;

const EMPTY: Partial<ReceiptDetail> = {
  category: "paper_scan",
  transactionDate: null,
  amount: null,
  partnerName: null,
  memo: null,
  warnings: [{ code: "FIELDS_MISSING" }],
};

const renderDetail = () =>
  renderRoute(Route, {
    path: "/e/$entityId/receipts/$receiptId",
    url: `/e/e1/receipts/${RECEIPT_ID}`,
  });

/** PATCH を受けて値を変え、version を進める状態つきの応答 */
function statefulApi(initial: Partial<ReceiptDetail>, patchReply?: () => ReturnType<typeof ok>) {
  let current = receiptDetail(initial);
  const calls = mockApi({
    [`GET ${DETAIL}`]: () => ok({ receipt: current }),
    [`PATCH ${DETAIL}`]: ({ body }) => {
      if (patchReply) return patchReply();
      const { version: _version, ...values } = body as Record<string, unknown>;
      current = {
        ...current,
        ...values,
        version: current.version + 1,
        warnings: [],
      } as ReceiptDetail;
      return ok({ receipt: current });
    },
  });
  return calls;
}

const patches = (calls: ApiCall[]) => calls.filter((c) => c.method === "PATCH");

async function openForm() {
  return await screen.findByRole("form", { name: "証憑の値" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("証憑の値の入力（未入力を埋める）", () => {
  it("今の値を入れて開く。未入力の欄は空", async () => {
    statefulApi({ ...EMPTY, partnerName: "合成の店", memo: "メモ" });
    renderDetail();
    const form = await openForm();
    expect(within(form).getByLabelText("取引年月日")).toHaveValue("");
    expect(within(form).getByLabelText("金額")).toHaveValue("");
    expect(within(form).getByLabelText("取引先")).toHaveValue("合成の店");
    expect(within(form).getByLabelText("メモ")).toHaveValue("メモ");
  });

  it("入れた値だけを version と一緒に PATCH で送る。理由は求めない", async () => {
    const calls = statefulApi(EMPTY);
    const { queryClient } = renderDetail();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const form = await openForm();
    const user = userEvent.setup();

    expect(within(form).queryByLabelText("理由")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("取引年月日"), "2026-10-20");
    await user.type(within(form).getByLabelText("金額"), "1,100");
    await user.type(within(form).getByLabelText("取引先"), "合成の店");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.body).toEqual({
      version: 1,
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
    });
    expect(await within(form).findByText("保存しました。")).toBeInTheDocument();
    // 検索の結果に出るよう、証憑のクエリ（一覧・検索・詳細）を読み直す
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: receiptKeys.all("e1") }),
    );
    // 保存後は新しい version で開き直し、未入力の警告が消える
    await waitFor(() =>
      expect(screen.queryByText("未入力の項目があります")).not.toBeInTheDocument(),
    );
    await user.clear(within(form).getByLabelText("メモ"));
    await user.type(within(form).getByLabelText("メモ"), "会議");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(2));
    expect(patches(calls)[1]?.body).toEqual({ version: 2, memo: "会議" });
  });

  it("メモは入力済みでも変えられる。空にすると null を送る", async () => {
    const calls = statefulApi({ ...EMPTY, memo: "古いメモ" });
    renderDetail();
    const form = await openForm();
    await userEvent.clear(within(form).getByLabelText("メモ"));
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.body).toEqual({ version: 1, memo: null });
  });

  it("変えていなければ送らずに知らせる", async () => {
    const calls = statefulApi(EMPTY);
    renderDetail();
    const form = await openForm();
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("変更がありません")).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
  });

  it("金額が 1 円以上の整数でなければ送らない。取引年月日は日付の入力欄", async () => {
    const calls = statefulApi(EMPTY);
    renderDetail();
    const form = await openForm();
    expect(within(form).getByLabelText("取引年月日")).toHaveAttribute("type", "date");
    await userEvent.type(within(form).getByLabelText("金額"), "12.5");
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("1 円以上の整数で入力してください")).toBeInTheDocument();
    expect(patches(calls)).toHaveLength(0);
  });

  it("入力済みの値を変えると、server が 422 REASON_REQUIRED を返し、理由を求める（値は変わらない。訂正は receipt-edit.test.tsx）", async () => {
    const calls = statefulApi(
      {
        category: "electronic",
        transactionDate: "2026-10-20",
        amount: 1100,
        partnerName: "合成の店",
      },
      () => apiError(422, "REASON_REQUIRED", "入力済みの値を変えるときは理由が必要です"),
    );
    renderDetail();
    const form = await openForm();
    expect(
      within(form).getByText(
        /入力済みの値（取引年月日・金額・取引先・区分）を変えるには理由が必要です/,
      ),
    ).toBeInTheDocument();
    const amount = within(form).getByLabelText("金額");
    expect(amount).toHaveValue("1,100");
    await userEvent.clear(amount);
    await userEvent.type(amount, "2000");
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("dialog")).toHaveTextContent("理由");
    expect(patches(calls)[0]?.body).toEqual({ version: 1, amount: 2000 });
    expect(within(form).queryByText("保存しました。")).not.toBeInTheDocument();
  });

  it("他の操作で更新されていれば（409 VERSION_CONFLICT）エラーを示し、最新を読み直す", async () => {
    let reads = 0;
    mockApi({
      [`GET ${DETAIL}`]: () => {
        reads += 1;
        return ok({ receipt: receiptDetail(EMPTY) });
      },
      [`PATCH ${DETAIL}`]: () =>
        apiError(409, "VERSION_CONFLICT", "別の操作で更新されています。開き直してください"),
    });
    renderDetail();
    const form = await openForm();
    await userEvent.type(within(form).getByLabelText("金額"), "100");
    await userEvent.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("別の操作で更新されています");
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});
