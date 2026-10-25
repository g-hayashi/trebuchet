import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/partners";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const BASE = "/api/entities/e1";
const PARTNER_A = { id: "p1", name: "株式会社A", honorific: "御中", memo: null, isActive: true };
const PARTNER_B = { id: "p2", name: "B 商事", honorific: null, memo: null, isActive: true };

const HOURLY = {
  partnerId: "p1",
  billingType: "hourly",
  unitPrice: 10_000,
  monthlyAmount: null,
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
    [`GET ${BASE}/partners`]: () => ok({ partners: [PARTNER_A, PARTNER_B] }),
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

/** 一覧の取引先の行を開き、請求の条件の編集を開く */
async function openBilling(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: `請求の条件（${name}）` }));
  return screen.getByRole("form", { name: `請求の条件（${name}）` });
}

describe("取引先の請求の条件（US4。FR-001, FR-002）", () => {
  it("一覧に請求の型と金額を出す。条件がなければ「未設定」", async () => {
    setup([HOURLY]);
    const table = await screen.findByRole("table");
    const rowA = within(table).getByRole("row", { name: /株式会社A/ });
    expect(within(rowA).getByText(/時間単価 10,000 円/)).toBeInTheDocument();
    const rowB = within(table).getByRole("row", { name: /B 商事/ });
    expect(within(rowB).getByText("未設定")).toBeInTheDocument();
  });

  it("時間単価型を保存する（既定は 1 か月後・末日。宛名は空なら送らない）", async () => {
    const calls = setup([], {
      [`PUT ${BASE}/partners/p1/billing-terms`]: () => ok({ terms: HOURLY }),
    });
    const user = userEvent.setup();
    const form = await openBilling(user, "株式会社A");

    expect(within(form).getByLabelText("請求の型")).toHaveValue("hourly");
    expect(within(form).getByLabelText("支払期限（月）")).toHaveValue("1");
    expect(within(form).getByLabelText("支払期限（日）")).toHaveValue("31");
    expect(within(form).queryByLabelText("月額（円）")).not.toBeInTheDocument();

    await user.type(within(form).getByLabelText("時間単価（円）"), "10000");
    await user.type(within(form).getByLabelText("既定の品名"), "システム開発");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      billingType: "hourly",
      unitPrice: 10_000,
      dueMonthsAfter: 1,
      dueDay: 31,
      defaultItemName: "システム開発",
    });
  });

  it("月額定額型に切り替えると月額の欄になり、期限と宛名も送る", async () => {
    const calls = setup([], {
      [`PUT ${BASE}/partners/p1/billing-terms`]: () => ok({ terms: HOURLY }),
    });
    const user = userEvent.setup();
    const form = await openBilling(user, "株式会社A");

    await user.selectOptions(within(form).getByLabelText("請求の型"), "monthly");
    expect(within(form).queryByLabelText("時間単価（円）")).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("月額（円）"), "300000");
    await user.selectOptions(within(form).getByLabelText("支払期限（月）"), "2");
    await user.selectOptions(within(form).getByLabelText("支払期限（日）"), "25");
    await user.type(within(form).getByLabelText("既定の品名"), "顧問料");
    await user.type(within(form).getByLabelText("宛名（空なら取引先名）"), "A 社 経理部");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      billingType: "monthly",
      monthlyAmount: 300_000,
      dueMonthsAfter: 2,
      dueDay: 25,
      defaultItemName: "顧問料",
      billingName: "A 社 経理部",
    });
  });

  it("日の選択肢は 1〜28 と末日だけ（29・30 はない）", async () => {
    setup();
    const user = userEvent.setup();
    const form = await openBilling(user, "株式会社A");
    const options = within(within(form).getByLabelText("支払期限（日）"))
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"));
    expect(options).toHaveLength(29);
    expect(options).toContain("28");
    expect(options).toContain("31");
    expect(options).not.toContain("29");
    expect(options).not.toContain("30");
  });

  it("0 や小数の単価、品名なしでは保存できない（送らずに知らせる）", async () => {
    const calls = setup();
    const user = userEvent.setup();
    const form = await openBilling(user, "株式会社A");
    const price = within(form).getByLabelText("時間単価（円）");
    await user.type(within(form).getByLabelText("既定の品名"), "開発");

    await user.type(price, "0");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText(/1 円以上の整数/)).toBeInTheDocument();

    await user.clear(price);
    await user.type(price, "1500.5");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText(/1 円以上の整数/)).toBeInTheDocument();

    await user.clear(price);
    await user.type(price, "1000");
    await user.clear(within(form).getByLabelText("既定の品名"));
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByText(/品名を入力/)).toBeInTheDocument();

    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("保存済みの条件がフォームに入り、「条件を外す」で DELETE する", async () => {
    const calls = setup([HOURLY], {
      [`DELETE ${BASE}/partners/p1/billing-terms`]: () => ({ status: 204, body: undefined }),
    });
    const user = userEvent.setup();
    const form = await openBilling(user, "株式会社A");
    expect(within(form).getByLabelText("時間単価（円）")).toHaveValue("10000");
    expect(within(form).getByLabelText("既定の品名")).toHaveValue("システム開発");

    await user.click(within(form).getByRole("button", { name: "条件を外す" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("敬称を変えると PATCH /partners/:id で直してから条件を保存する", async () => {
    const calls = setup([], {
      [`PATCH ${BASE}/partners/p1`]: () => ok({ partner: { ...PARTNER_A, honorific: "様" } }),
      [`PUT ${BASE}/partners/p1/billing-terms`]: () => ok({ terms: HOURLY }),
    });
    const user = userEvent.setup();
    const form = await openBilling(user, "株式会社A");

    expect(within(form).getByLabelText("請求書の敬称")).toHaveValue("御中");
    await user.selectOptions(within(form).getByLabelText("請求書の敬称"), "様");
    await user.type(within(form).getByLabelText("時間単価（円）"), "10000");
    await user.type(within(form).getByLabelText("既定の品名"), "開発");
    await user.click(within(form).getByRole("button", { name: "保存" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(`${BASE}/partners/p1`);
    expect(patch?.body).toEqual({ name: "株式会社A", honorific: "様" });
    expect(calls.indexOf(patch as never)).toBeLessThan(calls.findIndex((c) => c.method === "PUT"));
  });

  it("敬称を変えなければ PATCH しない", async () => {
    const calls = setup([HOURLY], {
      [`PUT ${BASE}/partners/p1/billing-terms`]: () => ok({ terms: HOURLY }),
    });
    const user = userEvent.setup();
    const form = await openBilling(user, "株式会社A");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("サーバーの VALIDATION はフォームの近くに出す", async () => {
    setup([HOURLY], {
      [`PUT ${BASE}/partners/p1/billing-terms`]: () =>
        apiError(400, "VALIDATION", "入力が正しくありません", {
          issues: [{ path: ["dueDay"], message: "不正な日です" }],
        }),
    });
    const user = userEvent.setup();
    const form = await openBilling(user, "株式会社A");
    await user.click(within(form).getByRole("button", { name: "保存" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("dueDay: 不正な日です");
  });
});
