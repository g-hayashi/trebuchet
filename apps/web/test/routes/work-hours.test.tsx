import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/work-hours";
import { ENTITY as BASE } from "../fixtures";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const term = (partnerId: string, partnerName: string, billingType: "hourly" | "monthly") => ({
  partnerId,
  billingType,
  unitPrice: billingType === "hourly" ? 10_000 : null,
  monthlyAmount: billingType === "monthly" ? 300_000 : null,
  dueMonthsAfter: 1,
  dueDay: 31,
  defaultItemName: "システム開発",
  billingName: null,
  updatedAt: "2026-10-24T09:00:00.000Z",
  partnerName,
  honorific: "御中",
  partnerActive: true,
});

const TERMS = [
  term("p1", "株式会社A", "hourly"),
  term("p2", "B 商事", "hourly"),
  term("p3", "C 社（月額）", "monthly"),
];

function setup(entries: { partnerId: string; hours: number | null }[], extra = {}) {
  const calls = mockApi({
    [`GET ${BASE}/billing-terms`]: () => ok({ terms: TERMS }),
    [`GET ${BASE}/work-hours`]: () => ok({ entries }),
    ...extra,
  });
  renderRoute(Route, {
    path: "/e/$entityId/work-hours",
    url: "/e/e1/work-hours?month=2026-10",
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("工数の入力（US1。FR-005）", () => {
  it("対象月の時間単価型の取引先ごとに、入力済みの時間と未入力の欄を出す", async () => {
    const calls = setup([
      { partnerId: "p1", hours: 40.5 },
      { partnerId: "p2", hours: null },
    ]);

    expect(await screen.findByLabelText("株式会社A の時間")).toHaveValue(40.5);
    expect(screen.getByLabelText("B 商事 の時間")).toHaveValue(null);
    expect(screen.queryByLabelText(/C 社/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("対象月")).toHaveValue("2026-10");
    expect(calls.find((c) => c.path === `${BASE}/work-hours`)?.query).toEqual({ month: "2026-10" });
  });

  it("入力した分だけを PUT する（未入力の取引先は送らない）", async () => {
    const calls = setup(
      [
        { partnerId: "p1", hours: null },
        { partnerId: "p2", hours: null },
      ],
      {
        [`PUT ${BASE}/work-hours/2026-10`]: () =>
          ok({ entries: [{ partnerId: "p1", hours: 40.5 }] }),
      },
    );
    const user = userEvent.setup();
    await screen.findByLabelText("株式会社A の時間");

    await user.type(screen.getByLabelText("株式会社A の時間"), "40.5");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("保存しました"));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      entries: [{ partnerId: "p1", hours: 40.5 }],
    });
  });

  it("0.5 単位でない時間は送らず、欄にメッセージを出す", async () => {
    const calls = setup([{ partnerId: "p1", hours: null }]);
    const user = userEvent.setup();
    await screen.findByLabelText("株式会社A の時間");

    await user.type(screen.getByLabelText("株式会社A の時間"), "1.25");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("0.5 時間単位で入力してください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("保存の失敗を表示する", async () => {
    setup([{ partnerId: "p1", hours: null }], {
      [`PUT ${BASE}/work-hours/2026-10`]: () => apiError(409, "PERIOD_CLOSED", "締め済みです"),
    });
    const user = userEvent.setup();
    await screen.findByLabelText("株式会社A の時間");
    await user.type(screen.getByLabelText("株式会社A の時間"), "8");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("締め済み");
  });

  it("請求書の案を作る画面へ、対象月つきで案内する", async () => {
    setup([{ partnerId: "p1", hours: 8 }]);
    const link = await screen.findByRole("link", { name: "請求書の案を作る" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/e/e1/invoices/new"));
    expect(link).toHaveAttribute("href", expect.stringContaining("month=2026-10"));
  });
});
