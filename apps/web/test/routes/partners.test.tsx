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

function setup(terms: unknown[] = [], extra: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi({
    [`GET ${BASE}/partners`]: () => ok({ partners: [PARTNER_A, PARTNER_B, PARTNER_C] }),
    [`GET ${BASE}/billing-terms`]: () => ok({ terms }),
    ...extra,
  });
  renderRoute(Route, { path: "/e/$entityId/partners", url: "/e/e1/partners" });
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
