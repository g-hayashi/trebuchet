import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/invoices/new";
import { type ApiReply, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const BASE = "/api/entities/e1";
const PARTNERS = [
  { id: "p1", name: "株式会社A", honorific: "御中", memo: null, isActive: true },
  { id: "p2", name: "B 商事", honorific: null, memo: null, isActive: true },
  { id: "p3", name: "C 社", honorific: "様", memo: null, isActive: true },
];

const hourlyDraft = (over: Record<string, unknown> = {}) => ({
  partnerId: "p1",
  targetMonth: "2026-10",
  issueDate: "2026-11-05",
  salesDate: "2026-10-31",
  dueDate: "2026-11-30",
  items: [
    {
      name: "システム開発",
      quantity: 40.5,
      unit: "時間",
      unitPrice: 10_000,
      amount: 405_000,
      taxCategory: "SALES_10",
      taxRate: 10,
    },
  ],
  total: 405_000,
  taxDisplay: "inclusive_only",
  taxBreakdown: [],
  warnings: [],
  ...over,
});

const monthlyDraft = {
  partnerId: "p2",
  targetMonth: "2026-10",
  issueDate: "2026-11-05",
  salesDate: "2026-10-31",
  dueDate: "2026-11-30",
  items: [{ name: "保守費", amount: 100_000, taxCategory: "SALES_10", taxRate: 10 }],
  total: 100_000,
  taxDisplay: "inclusive_only",
  taxBreakdown: [],
  warnings: [],
};

const INVOICE = {
  id: "inv1",
  invoiceNo: "2026-0001",
  partnerId: "p1",
  recipientName: "株式会社A",
  targetMonth: "2026-10",
  issueDate: "2026-11-05",
  dueDate: "2026-11-30",
  total: 405_000,
  paid: 0,
  remaining: 405_000,
  status: "unpaid",
  overdue: false,
};

function setup(
  drafts: unknown[],
  extra: Parameters<typeof mockApi>[0] = {},
  skipped: { partnerId: string; reason: string }[] = [],
) {
  const calls = mockApi({
    [`GET ${BASE}/partners`]: () => ok({ partners: PARTNERS }),
    [`POST ${BASE}/invoices/drafts`]: () => ok({ drafts, skipped }),
    ...extra,
  });
  renderRoute(Route, {
    path: "/e/$entityId/invoices/new",
    url: "/e/e1/invoices/new?month=2026-10",
  });
  return calls;
}

const user = () => userEvent.setup();

async function makeDrafts(u: ReturnType<typeof userEvent.setup>) {
  await u.click(await screen.findByRole("button", { name: "内容を確認する" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("請求書の案と発行（US1。FR-006〜016）", () => {
  it("免税の案を税抜10%に変えるとAPIの合計198000を確認して発行する", async () => {
    const calls = setup(
      [
        hourlyDraft({
          items: [
            {
              name: "開発",
              quantity: 30,
              unit: "時間",
              unitPrice: 6000,
              amount: 180000,
              taxCategory: "OUT_OF_SCOPE",
              taxRate: null,
            },
          ],
        }),
      ],
      {
        [`POST ${BASE}/invoices/calculate`]: ({ body }) =>
          ok(
            (body as { priceMode: string }).priceMode === "exclusive"
              ? {
                  subtotal: 180000,
                  total: 198000,
                  taxBreakdown: [{ rate: 10, exclusive: 180000, tax: 18000, inclusive: 198000 }],
                }
              : { subtotal: 180000, total: 180000, taxBreakdown: [] },
          ),
        [`POST ${BASE}/invoices`]: () => ok({ invoice: INVOICE, journal: { id: "j1" } }, 201),
      },
    );
    const u = user();
    await makeDrafts(u);
    const region = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    expect(await within(region).findByText("合計 180,000 円")).toBeInTheDocument();
    await u.selectOptions(within(region).getByLabelText("金額の入力方法"), "exclusive");
    expect(within(region).getByLabelText("請求税率 1")).toHaveValue("10");
    expect(await within(region).findByText("合計 198,000 円")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(region).getByRole("button", { name: "発行する" })).toBeEnabled(),
    );
    await u.click(within(region).getByRole("button", { name: "発行する" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === `${BASE}/invoices`)?.body,
      ).toMatchObject({
        priceMode: "exclusive",
        items: [{ unitPrice: 6000, quantity: 30, amount: 180000, taxRate: 10 }],
      }),
    );
    const body = calls.find((c) => c.method === "POST" && c.path === `${BASE}/invoices`)?.body as {
      items: object[];
    };
    expect(body.items[0]).not.toHaveProperty("taxCategory");
  });

  it("計算エラーでは発行できない", async () => {
    setup([hourlyDraft()], {
      [`POST ${BASE}/invoices/calculate`]: () => apiError(400, "VALIDATION", "計算できません"),
    });
    await makeDrafts(user());
    const region = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    expect(await within(region).findByRole("alert")).toHaveTextContent("計算できません");
    expect(within(region).getByRole("button", { name: "発行する" })).toBeDisabled();
  });
  it("利用者が加算なしを明示した行は税抜への切替でも維持する", async () => {
    const calls = setup([monthlyDraft]);
    const u = user();
    await makeDrafts(u);
    const region = await screen.findByRole("region", { name: "請求書の案（B 商事）" });
    await u.selectOptions(within(region).getByLabelText("請求税率 1"), "none");
    await u.selectOptions(within(region).getByLabelText("金額の入力方法"), "exclusive");
    expect(within(region).getByLabelText("請求税率 1")).toHaveValue("none");
    await waitFor(() =>
      expect(calls.findLast((c) => c.path === `${BASE}/invoices/calculate`)?.body).toEqual({
        priceMode: "exclusive",
        items: [{ amount: 100000, taxRate: null }],
        partnerId: "p2",
        issueDate: "2026-11-05",
      }),
    );
  });

  it("計算待ちは発行できず、遅い旧応答が新しい入力の合計を上書きしない", async () => {
    let resolveOld: (reply: ApiReply) => void = () => {};
    const oldResponse = new Promise<ApiReply>((resolve) => {
      resolveOld = resolve;
    });
    const calls = setup([monthlyDraft], {
      [`POST ${BASE}/invoices/calculate`]: ({ body }) => {
        const input = body as { priceMode: string; items: { amount: number; taxRate: number }[] };
        if (input.priceMode === "exclusive" && input.items[0]?.taxRate === 10) return oldResponse;
        return ok({
          subtotal: 100000,
          total: input.priceMode === "exclusive" ? 108000 : 100000,
          taxBreakdown: [],
        });
      },
    });
    const u = user();
    await makeDrafts(u);
    const region = await screen.findByRole("region", { name: "請求書の案（B 商事）" });
    expect(await within(region).findByText("合計 100,000 円")).toBeInTheDocument();
    await u.selectOptions(within(region).getByLabelText("金額の入力方法"), "exclusive");
    expect(within(region).getByRole("button", { name: "発行する" })).toBeDisabled();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === `${BASE}/invoices/calculate`)).toHaveLength(2),
    );
    await u.selectOptions(within(region).getByLabelText("請求税率 1"), "8");
    expect(await within(region).findByText("合計 108,000 円")).toBeInTheDocument();
    await act(async () => {
      resolveOld(ok({ subtotal: 100000, total: 110000, taxBreakdown: [] }));
      await oldResponse;
    });
    expect(within(region).getByText("合計 108,000 円")).toBeInTheDocument();
    expect(within(region).queryByText("合計 110,000 円")).not.toBeInTheDocument();
  });

  it("発行処理中は明細とモードを変更できず、不正入力では発行できない", async () => {
    let finish: (reply: ApiReply) => void = () => {};
    const pending = new Promise<ApiReply>((resolve) => {
      finish = resolve;
    });
    const calls = setup([monthlyDraft], { [`POST ${BASE}/invoices`]: () => pending });
    const u = user();
    await makeDrafts(u);
    const region = await screen.findByRole("region", { name: "請求書の案（B 商事）" });
    const amount = within(region).getByLabelText("金額 1");
    await u.clear(amount);
    await u.type(amount, "1.5");
    expect(within(region).getByRole("button", { name: "発行する" })).toBeDisabled();
    await u.clear(amount);
    await u.type(amount, "100000");
    await waitFor(() =>
      expect(within(region).getByRole("button", { name: "発行する" })).toBeEnabled(),
    );
    await u.click(within(region).getByRole("button", { name: "発行する" }));
    expect(amount).toBeDisabled();
    expect(within(region).getByLabelText("金額の入力方法")).toBeDisabled();
    expect(within(region).getByLabelText("請求税率 1")).toBeDisabled();
    expect(calls.filter((c) => c.method === "POST" && c.path === `${BASE}/invoices`)).toHaveLength(
      1,
    );
    await act(async () => {
      finish(ok({ invoice: INVOICE, journal: { id: "j1" } }, 201));
      await pending;
    });
  });
  it("発行が無効な入力では送信前に行と修正方法を示す", async () => {
    const calls = setup([hourlyDraft()]);
    const u = user();
    await makeDrafts(u);
    const region = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    const quantity = within(region).getByLabelText("数量 1");
    await u.clear(quantity);
    await u.type(quantity, "1.25");
    expect(
      within(region).getByText("1 行目の数量は 0.5 単位の正の数で入力してください"),
    ).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "発行する" })).toBeDisabled();
    await u.clear(quantity);
    await u.type(quantity, "1");
    const price = within(region).getByLabelText("単価 1");
    await u.clear(price);
    await u.type(price, "1000000000000");
    expect(
      within(region).getByText("1 行目の単価は 1 円以上、1 兆円未満の整数で入力してください"),
    ).toBeInTheDocument();
    await u.clear(price);
    await u.type(price, "10000");
    await u.click(within(region).getByRole("button", { name: "明細を追加" }));
    expect(within(region).getByText("2 行目の品名を入力してください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === `${BASE}/invoices`)).toBe(false);
  });
  it("対象月の案を作り、取引先ごとに明細・合計・日付を出す", async () => {
    const calls = setup([hourlyDraft(), monthlyDraft]);
    const u = user();
    await makeDrafts(u);

    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    expect(calls.find((c) => c.path === `${BASE}/invoices/drafts`)?.body).toEqual({
      month: "2026-10",
    });
    expect(within(a).getByLabelText("品名 1")).toHaveValue("システム開発");
    expect(within(a).getByLabelText("数量 1")).toHaveValue(40.5);
    expect(within(a).getByLabelText("単価 1")).toHaveValue(10_000);
    expect(within(a).getByLabelText("金額 1")).toHaveValue("405,000");
    expect(await within(a).findByText("合計 405,000 円")).toBeInTheDocument();
    expect(within(a).getByLabelText("発行日")).toHaveValue("2026-11-05");
    expect(within(a).getByLabelText("売上の計上日")).toHaveValue("2026-10-31");
    expect(within(a).getByText(/支払期限 2026-11-30/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "請求書の案（B 商事）" })).toBeInTheDocument();
  });

  it("工数がなくて案を作れなかった取引先を知らせる", async () => {
    setup([hourlyDraft()], {}, [
      { partnerId: "p2", reason: "NO_HOURS" },
      { partnerId: "p3", reason: "ZERO_HOURS" },
    ]);
    await makeDrafts(user());

    await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    expect(screen.getByText(/B 商事.*工数が未入力/)).toBeInTheDocument();
    expect(screen.getByText(/C 社.*工数が 0/)).toBeInTheDocument();
  });

  it("数量を直すと金額と合計を再計算する（0.5 刻み、端数は切り捨て）", async () => {
    setup([hourlyDraft()]);
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });

    await u.clear(within(a).getByLabelText("単価 1"));
    await u.type(within(a).getByLabelText("単価 1"), "3333");
    // floor(40.5 * 3333) = 134986
    expect(within(a).getByLabelText("金額 1")).toHaveValue("134,986");
    expect(await within(a).findByText("合計 134,986 円")).toBeInTheDocument();
  });

  it("明細は最大 5 行まで足せ、行を消せる。月額の行は金額を直接入力する", async () => {
    setup([monthlyDraft]);
    const u = user();
    await makeDrafts(u);
    const b = await screen.findByRole("region", { name: "請求書の案（B 商事）" });

    for (let i = 0; i < 4; i += 1) {
      await u.click(within(b).getByRole("button", { name: "明細を追加" }));
    }
    expect(within(b).getByLabelText("品名 5")).toBeInTheDocument();
    expect(within(b).getByRole("button", { name: "明細を追加" })).toBeDisabled();

    await u.type(within(b).getByLabelText("品名 2"), "出張費");
    await u.type(within(b).getByLabelText("金額 2"), "2500");
    // 未入力の明細が残る間は合計を確定表示しない。
    for (let n = 5; n >= 3; n -= 1)
      await u.click(within(b).getByRole("button", { name: `明細 ${n} を削除` }));
    expect(await within(b).findByText("合計 102,500 円")).toBeInTheDocument();

    await u.click(within(b).getByRole("button", { name: "明細 2 を削除" }));
    expect(within(b).queryByLabelText("品名 5")).not.toBeInTheDocument();
    expect(await within(b).findByText("合計 100,000 円")).toBeInTheDocument();
  });

  it("発行すると POST /invoices に、発行日・売上の計上日（既定値）と明細を載せる", async () => {
    const calls = setup([hourlyDraft()], {
      [`POST ${BASE}/invoices`]: () => ok({ invoice: INVOICE, journal: { id: "j1" } }, 201),
    });
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });

    await u.click(within(a).getByRole("button", { name: "発行する" }));

    // 発行の知らせは画面の上の toast に出る（請求書の案の外）
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2026-0001"));
    expect(within(a).getByRole("link", { name: "請求書 2026-0001 を開く" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoices/inv1"),
    );
    expect(calls.find((c) => c.method === "POST" && c.path === `${BASE}/invoices`)?.body).toEqual({
      priceMode: "inclusive",
      partnerId: "p1",
      targetMonth: "2026-10",
      issueDate: "2026-11-05",
      salesDate: "2026-10-31",
      items: [
        {
          name: "システム開発",
          quantity: 40.5,
          unit: "時間",
          unitPrice: 10_000,
          amount: 405_000,
          taxCategory: "SALES_10",
          taxRate: 10,
        },
      ],
    });
  });

  it("発行日と売上の計上日を変えると、変えた値が発行の入力に載る", async () => {
    const calls = setup([monthlyDraft], {
      [`POST ${BASE}/invoices`]: () =>
        ok({ invoice: { ...INVOICE, partnerId: "p2" }, journal: { id: "j1" } }, 201),
    });
    const u = user();
    await makeDrafts(u);
    const b = await screen.findByRole("region", { name: "請求書の案（B 商事）" });

    await u.clear(within(b).getByLabelText("発行日"));
    await u.type(within(b).getByLabelText("発行日"), "2026-11-10");
    await u.clear(within(b).getByLabelText("売上の計上日"));
    await u.type(within(b).getByLabelText("売上の計上日"), "2026-11-01");
    await u.click(within(b).getByRole("button", { name: "発行する" }));

    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(calls.find((c) => c.method === "POST" && c.path === `${BASE}/invoices`)?.body).toEqual({
      priceMode: "inclusive",
      partnerId: "p2",
      targetMonth: "2026-10",
      issueDate: "2026-11-10",
      salesDate: "2026-11-01",
      items: [{ name: "保守費", amount: 100_000, taxCategory: "SALES_10", taxRate: 10 }],
    });
  });

  it("同じ月の請求書がある警告は、確認のチェックを入れるまで発行できず、確認を載せて送る", async () => {
    const calls = setup(
      [
        hourlyDraft({
          warnings: [
            {
              code: "INVOICE_DUPLICATE_MONTH",
              message: "この取引先・月の請求書がすでにあります",
            },
          ],
        }),
      ],
      {
        [`POST ${BASE}/invoices`]: () => ok({ invoice: INVOICE, journal: { id: "j1" } }, 201),
      },
    );
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });

    expect(within(a).getByText(/この取引先・月の請求書がすでにあります/)).toBeInTheDocument();
    expect(within(a).getByRole("button", { name: "発行する" })).toBeDisabled();
    await u.click(within(a).getByRole("button", { name: "追加で作る" }));
    await u.click(within(a).getByRole("button", { name: "発行する" }));

    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(calls.find((c) => c.method === "POST" && c.path === `${BASE}/invoices`)?.body).toEqual(
      expect.objectContaining({ confirmDuplicate: true }),
    );
  });

  it("発行者の設定が足りないときは、設定の画面へ案内する", async () => {
    setup([hourlyDraft()], {
      [`POST ${BASE}/invoices`]: () =>
        apiError(422, "INVOICE_ISSUER_INCOMPLETE", "発行者の設定が不足しています"),
    });
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    await u.click(within(a).getByRole("button", { name: "発行する" }));

    expect(await within(a).findByRole("alert")).toHaveTextContent("発行者の設定が不足");
    expect(within(a).getByRole("link", { name: "請求の設定を開く" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoice-settings"),
    );
  });

  it("締め済みの期間・消費税の設定の空白のエラーを文言にして出す", async () => {
    let n = 0;
    setup([hourlyDraft()], {
      [`POST ${BASE}/invoices`]: () => {
        n += 1;
        return n === 1
          ? apiError(409, "PERIOD_CLOSED", "締め済み")
          : apiError(422, "TAX_SETTING_GAP", "2026-11-05 の設定がありません");
      },
    });
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });

    await u.click(within(a).getByRole("button", { name: "発行する" }));
    expect(await within(a).findByRole("alert")).toHaveTextContent(
      "締め済みの会計期間は変更できません。",
    );
    await u.click(within(a).getByRole("button", { name: "発行する" }));
    await waitFor(() =>
      expect(within(a).getByRole("alert")).toHaveTextContent(
        "消費税の設定の期間に空白または重複があります。",
      ),
    );
  });

  it("金額が 0 の案は、発行前に入力を促す（発行できない）", async () => {
    const calls = setup([{ ...monthlyDraft, items: [{ name: "保守費", amount: 0 }], total: 0 }]);
    const u = user();
    await makeDrafts(u);
    const b = await screen.findByRole("region", { name: "請求書の案（B 商事）" });

    expect(within(b).getByRole("button", { name: "発行する" })).toBeDisabled();
    expect(within(b).getByText(/金額が 0 円/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === `${BASE}/invoices`)).toBe(false);
  });
});

describe("請求書を作る画面（011 US5。FR-032・033）", () => {
  const issuedList = (over: Record<string, unknown> = {}) => ({
    [`GET ${BASE}/invoices`]: () =>
      ok({
        invoices: [
          INVOICE,
          { ...INVOICE, id: "inv9", invoiceNo: "2026-0009", partnerId: "p2", status: "voided" },
          { ...INVOICE, id: "inv8", invoiceNo: "2026-0008", targetMonth: "2026-09" },
        ],
        outstandingByPartner: [],
        ...over,
      }),
  });

  it("言葉は「請求書を作る」にそろえ、案は保存しないと知らせる", async () => {
    setup([hourlyDraft()]);
    expect(await screen.findByRole("heading", { name: "請求書を作る" })).toBeInTheDocument();
    expect(
      screen.getByText("ここでは保存しません。発行すると請求書と仕訳ができます"),
    ).toBeInTheDocument();
  });

  it("同じ取引先・対象月（未取消）の請求書があれば「発行済み（番号）」と示し、選ぶまで発行できない", async () => {
    const calls = setup([hourlyDraft(), monthlyDraft], {
      ...issuedList(),
      [`POST ${BASE}/invoices`]: () => ok({ invoice: INVOICE, journal: { id: "j1" } }, 201),
    });
    const u = user();
    await makeDrafts(u);
    const a = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    expect(await within(a).findByText("発行済み（2026-0001）")).toBeInTheDocument();
    expect(within(a).getByRole("link", { name: "取り消す" })).toHaveAttribute(
      "href",
      expect.stringContaining("/e/e1/invoices/inv1"),
    );
    expect(within(a).getByRole("button", { name: "発行する" })).toBeDisabled();
    // 一覧は対象月で読む。取消済みの請求書しかない取引先は、発行済みにしない
    expect(
      calls.some(
        (c) => c.method === "GET" && c.path === `${BASE}/invoices` && c.query.month === "2026-10",
      ),
    ).toBe(true);
    const b = screen.getByRole("region", { name: "請求書の案（B 商事）" });
    expect(within(b).queryByText(/発行済み/)).not.toBeInTheDocument();
    expect(within(b).getByRole("button", { name: "発行する" })).toBeEnabled();

    await u.click(within(a).getByRole("button", { name: "追加で作る" }));
    await u.click(within(a).getByRole("button", { name: "発行する" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path === `${BASE}/invoices`)).toBe(true),
    );
    expect(calls.find((c) => c.method === "POST" && c.path === `${BASE}/invoices`)?.body).toEqual(
      expect.objectContaining({ partnerId: "p1", confirmDuplicate: true }),
    );
  });

  /** variant="default" の「発行する」が入っている案の名前 */
  const primaryIssueRegions = () =>
    screen
      .getAllByRole("button", { name: "発行する" })
      .filter((b) => b.className.split(" ").includes("bg-primary"))
      .map((b) => b.closest("section")?.getAttribute("aria-label"));

  it("案が 2 件のとき、default の「発行する」は先頭の案の 1 つだけ（ui-shell §7）", async () => {
    setup([hourlyDraft(), monthlyDraft]);
    await makeDrafts(user());
    await screen.findByRole("region", { name: "請求書の案（B 商事）" });
    expect(screen.getAllByRole("button", { name: "発行する" })).toHaveLength(2);
    expect(primaryIssueRegions()).toEqual(["請求書の案（株式会社A）"]);
  });

  it("先頭の案が発行済みなら、次の未発行の案の「発行する」が default になる", async () => {
    setup([hourlyDraft(), monthlyDraft], issuedList());
    await makeDrafts(user());
    await screen.findByText("発行済み（2026-0001）");
    await waitFor(() => expect(primaryIssueRegions()).toEqual(["請求書の案（B 商事）"]));
  });

  it("追加で作らない（選んでいない）ときは confirmDuplicate を送らない", async () => {
    const calls = setup([monthlyDraft], {
      ...issuedList(),
      [`POST ${BASE}/invoices`]: () => ok({ invoice: INVOICE, journal: { id: "j1" } }, 201),
    });
    const u = user();
    await makeDrafts(u);
    const b = await screen.findByRole("region", { name: "請求書の案（B 商事）" });
    await u.click(within(b).getByRole("button", { name: "発行する" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(
      calls.find((c) => c.path === `${BASE}/invoices` && c.method === "POST")?.body as object,
    ).not.toHaveProperty("confirmDuplicate");
  });

  it("使用停止の取引先は、案にも作れなかった知らせにも出さない", async () => {
    setup(
      [hourlyDraft(), { ...monthlyDraft, partnerId: "p3" }],
      {
        [`GET ${BASE}/partners`]: () =>
          ok({ partners: PARTNERS.map((p) => (p.id === "p3" ? { ...p, isActive: false } : p)) }),
      },
      [{ partnerId: "p3", reason: "NO_HOURS" }],
    );
    await makeDrafts(user());

    await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    expect(screen.queryByRole("region", { name: "請求書の案（C 社）" })).not.toBeInTheDocument();
    expect(screen.queryByText(/C 社/)).not.toBeInTheDocument();
  });
});

describe("源泉徴収（013 R8・FR-005）", () => {
  const WITHHOLDING_CALC = {
    subtotal: 330_000,
    total: 330_000,
    taxBreakdown: [{ rate: 10, exclusive: 300_000, tax: 30_000, inclusive: 330_000 }],
    withholdingBase: 300_000,
    withholdingTax: 30_630,
    netAmount: 299_370,
  };

  it("源泉徴収税額がある案は、合計の後に源泉徴収税額と差引請求額を出し、計算に取引先と発行日を渡す", async () => {
    const calls = setup(
      [
        hourlyDraft({
          items: [{ name: "業務", amount: 330_000, taxCategory: "SALES_10", taxRate: 10 }],
          total: 330_000,
          withholdingBase: 300_000,
          withholdingTax: 30_630,
          netAmount: 299_370,
        }),
      ],
      { [`POST ${BASE}/invoices/calculate`]: () => ok(WITHHOLDING_CALC) },
    );
    await makeDrafts(user());
    const region = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    const total = await within(region).findByText("合計 330,000 円");
    const tax = within(region).getByText("源泉徴収税額 30,630 円");
    const net = within(region).getByText("差引請求額 299,370 円");
    expect(total.compareDocumentPosition(tax) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tax.compareDocumentPosition(net) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() =>
      expect(calls.findLast((c) => c.path === `${BASE}/invoices/calculate`)?.body).toMatchObject({
        partnerId: "p1",
        issueDate: "2026-11-05",
      }),
    );
  });

  it("源泉徴収税額が 0 なら、源泉徴収の行を出さない", async () => {
    setup([hourlyDraft()]);
    await makeDrafts(user());
    const region = await screen.findByRole("region", { name: "請求書の案（株式会社A）" });
    expect(await within(region).findByText("合計 405,000 円")).toBeInTheDocument();
    expect(within(region).queryByText(/源泉徴収税額/)).not.toBeInTheDocument();
    expect(within(region).queryByText(/差引請求額/)).not.toBeInTheDocument();
  });
});
