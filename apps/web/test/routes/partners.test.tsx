import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/partners";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const BASE = "/api/entities/e1";
const PARTNER_A = {
  id: "p1",
  name: "株式会社A",
  honorific: "御中",
  memo: "月末締め",
  isActive: true,
};
const PARTNER_B = { id: "p2", name: "B 商事", honorific: null, memo: null, isActive: true };
const PARTNER_C = { id: "p3", name: "旧取引先C", honorific: "様", memo: null, isActive: false };

const HOURLY = {
  partnerId: "p1",
  billingType: "hourly",
  unitPrice: 10_000,
  monthlyAmount: null,
  priceMode: "inclusive",
  taxRate: 10,
  dueMonthsAfter: 1,
  dueDay: 31,
  defaultItemName: "システム開発",
  billingName: null,
  updatedAt: "2026-10-24T09:00:00.000Z",
  partnerName: "株式会社A",
  honorific: "御中",
  partnerActive: true,
};

let queryClient: ReturnType<typeof renderRoute>["queryClient"];

function setup(terms: unknown[] = [], extra: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi({
    [`GET ${BASE}/partners`]: () => ok({ partners: [PARTNER_A, PARTNER_B, PARTNER_C] }),
    [`GET ${BASE}/billing-terms`]: () => ok({ terms }),
    ...extra,
  });
  ({ queryClient } = renderRoute(Route, { path: "/e/$entityId/partners", url: "/e/e1/partners" }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const rowNames = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelectorAll("td")[0]?.textContent ?? "");

describe("取引先の画面（011 FR-049）", () => {
  it("一覧に敬称・メモ・請求の条件・状態を出す。条件がなければ「未設定」", async () => {
    setup([HOURLY]);
    const table = await screen.findByRole("table");
    const rowA = within(table).getByRole("row", { name: /株式会社A/ });
    expect(within(rowA).getByText("御中")).toBeInTheDocument();
    expect(within(rowA).getByText("月末締め")).toBeInTheDocument();
    expect(within(rowA).getByText(/時間単価 10,000 円/)).toBeInTheDocument();
    expect(within(rowA).getByText("有効")).toBeInTheDocument();
    const rowB = within(table).getByRole("row", { name: /B 商事/ });
    expect(within(rowB).getByText("未設定")).toBeInTheDocument();
    const rowC = within(table).getByRole("row", { name: /旧取引先C/ });
    expect(within(rowC).getByText("使用停止")).toBeInTheDocument();
  });

  it("検索で名前とメモを絞り込み、見つからなければ知らせる", async () => {
    setup();
    const user = userEvent.setup();
    await screen.findByRole("table");
    expect(rowNames()).toEqual(["株式会社A", "B 商事", "旧取引先C"]);

    const search = screen.getByRole("searchbox", { name: "取引先を検索" });
    await user.type(search, "商事");
    expect(rowNames()).toEqual(["B 商事"]);

    await user.clear(search);
    await user.type(search, "月末");
    expect(rowNames()).toEqual(["株式会社A"]);

    await user.clear(search);
    await user.type(search, "存在しない");
    expect(screen.getByText("条件に合う取引先はありません。")).toBeInTheDocument();
  });

  it("編集は名前・敬称・メモ・使用停止・請求の条件を 1 回の PUT /profile で保存する", async () => {
    const calls = setup([HOURLY], {
      [`PUT ${BASE}/partners/p1/profile`]: () =>
        ok({ partner: { ...PARTNER_A, isActive: false }, billingTerms: HOURLY }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "取引先の編集（株式会社A）" }));
    const form = within(await screen.findByRole("dialog")).getByRole("form", {
      name: "取引先の編集（株式会社A）",
    });
    expect(within(form).getByLabelText("名称")).toHaveValue("株式会社A");
    expect(within(form).getByLabelText("請求の条件を設定する")).toBeChecked();
    expect(within(form).getByLabelText("使用停止にする")).not.toBeChecked();

    await user.click(within(form).getByLabelText("使用停止にする"));
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`${BASE}/partners/p1/profile`);
    expect(put?.body).toMatchObject({
      partner: { name: "株式会社A", honorific: "御中", memo: "月末締め", isActive: false },
      billingTerms: { billingType: "hourly", unitPrice: 10_000 },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("請求の条件を外すと billingTerms: null を送る", async () => {
    const calls = setup([HOURLY], {
      [`PUT ${BASE}/partners/p1/profile`]: () => ok({ partner: PARTNER_A, billingTerms: null }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "取引先の編集（株式会社A）" }));
    const form = within(await screen.findByRole("dialog")).getByRole("form");
    await user.click(within(form).getByLabelText("請求の条件を設定する"));
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ billingTerms: null });
  });

  it("取引先を登録する（POST /partners/profile）。名称が空なら送らずに知らせる", async () => {
    const calls = setup([], {
      [`POST ${BASE}/partners/profile`]: () =>
        ok(
          { partner: { id: "p9", name: "新規D", honorific: null, memo: "", isActive: true } },
          201,
        ),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "取引先を登録" }));
    const form = within(await screen.findByRole("dialog")).getByRole("form", {
      name: "取引先を登録",
    });

    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText("名称を入力してください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await user.type(within(form).getByLabelText("名称"), "新規D");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      partner: { name: "新規D", isActive: true },
      billingTerms: null,
    });
  });

  it("名前と敬称だけなら、請求の条件なし（null）で POST /partners/profile する", async () => {
    const calls = setup([], {
      [`POST ${BASE}/partners/profile`]: () =>
        ok(
          {
            partner: { id: "p9", name: "C 工業", honorific: "様", memo: null, isActive: true },
            billingTerms: null,
          },
          201,
        ),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "取引先を登録" }));
    const form = within(await screen.findByRole("dialog")).getByRole("form", {
      name: "取引先を登録",
    });
    expect(within(form).queryByLabelText("既定の品名")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("名称"), "C 工業");
    await user.selectOptions(within(form).getByLabelText("敬称"), "様");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`${BASE}/partners/profile`);
    expect(post?.body).toEqual({
      partner: { name: "C 工業", honorific: "様", memo: "", isActive: true },
      billingTerms: null,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("請求の条件を設定して登録すると、取引先・条件・工数を読み直す", async () => {
    const calls = setup([], {
      [`POST ${BASE}/partners/profile`]: () =>
        ok(
          {
            partner: { id: "p9", name: "C 工業", honorific: null, memo: null, isActive: true },
            billingTerms: { ...HOURLY, partnerId: "p9", unitPrice: 8000 },
          },
          201,
        ),
    });
    const user = userEvent.setup();
    await screen.findByRole("table");
    queryClient.setQueryData(["entities", "e1", "work-hours", "2026-10"], []);
    await user.click(screen.getByRole("button", { name: "取引先を登録" }));
    const form = within(await screen.findByRole("dialog")).getByRole("form", {
      name: "取引先を登録",
    });
    await user.type(within(form).getByLabelText("名称"), "C 工業");
    await user.click(within(form).getByLabelText("請求の条件を設定する"));
    await user.type(within(form).getByLabelText("時間単価（円）"), "8000");
    await user.type(within(form).getByLabelText("既定の品名"), "保守");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      partner: { name: "C 工業", honorific: null },
      billingTerms: {
        billingType: "hourly",
        unitPrice: 8000,
        defaultItemName: "保守",
        dueMonthsAfter: 1,
        dueDay: 31,
      },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // 請求の条件のある取引先が工数の対象になる（工数の問い合わせを無効にして読み直させる）
    expect(
      queryClient.getQueryState(["entities", "e1", "work-hours", "2026-10"])?.isInvalidated,
    ).toBe(true);
    expect(calls.filter((c) => c.method === "GET" && c.path === `${BASE}/partners`).length).toBe(2);
    expect(
      calls.filter((c) => c.method === "GET" && c.path === `${BASE}/billing-terms`).length,
    ).toBe(2);
  });

  it("条件を設定するのに金額・品名が空なら、送らずに欄ごとに知らせる", async () => {
    const calls = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "取引先を登録" }));
    const form = within(await screen.findByRole("dialog")).getByRole("form", {
      name: "取引先を登録",
    });
    await user.type(within(form).getByLabelText("名称"), "C 工業");
    await user.click(within(form).getByLabelText("請求の条件を設定する"));
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(
      await within(form).findByText("単価は 1 円以上の整数で入力してください"),
    ).toBeInTheDocument();
    expect(within(form).getByText("既定の品名を入力してください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("サーバーのエラーはフォームの近くに出す", async () => {
    setup([], {
      [`PUT ${BASE}/partners/p2/profile`]: () =>
        apiError(400, "VALIDATION", "同じ名前の取引先があります"),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "取引先の編集（B 商事）" }));
    const form = within(await screen.findByRole("dialog")).getByRole("form");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByRole("alert")).toBeInTheDocument();
  });
});
