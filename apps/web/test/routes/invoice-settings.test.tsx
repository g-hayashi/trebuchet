import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/invoice-settings";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const PATH = "/api/entities/e1/invoice-settings";

const SETTINGS = {
  issuerName: "山田 太郎",
  tradeName: "山田設計",
  address: "東京都千代田区",
  contact: "taro@example.com",
  bankAccount: "○○銀行 普通 1234567",
  registrationNumber: "T1234567890123",
  taxDisplay: "separate",
  nextSeq: 43,
  updatedAt: "2026-10-24T09:00:00.000Z",
};

function renderPage() {
  return renderRoute(Route, {
    path: "/e/$entityId/invoice-settings",
    url: "/e/e1/invoice-settings",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fillRequired = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText("氏名"), "山田 太郎");
  await user.type(screen.getByLabelText("住所"), "東京都千代田区");
  await user.type(screen.getByLabelText("連絡先"), "taro@example.com");
  await user.type(screen.getByLabelText("振込先"), "○○銀行 普通 1234567");
};

describe("請求の設定の画面（US4。FR-003, FR-004）", () => {
  it("設定がなければ空のフォームで、次の通し番号の下限を案内する", async () => {
    mockApi({ [`GET ${PATH}`]: () => ok({ settings: null, minimumNextSeq: 1 }) });
    renderPage();

    expect(await screen.findByLabelText("氏名")).toHaveValue("");
    expect(screen.getByLabelText("次の通し番号")).toHaveValue(1);
    expect(screen.getByText(/1 以上/)).toBeInTheDocument();
    expect(screen.getByLabelText("税率ごとの内訳表示")).toHaveValue("inclusive_only");
    expect(screen.getByText(/請求額は変わりません/)).toBeInTheDocument();
  });

  it("保存済みの設定がフォームに入る", async () => {
    mockApi({ [`GET ${PATH}`]: () => ok({ settings: SETTINGS, minimumNextSeq: 12 }) });
    renderPage();

    expect(await screen.findByLabelText("氏名")).toHaveValue("山田 太郎");
    expect(screen.getByLabelText("屋号")).toHaveValue("山田設計");
    expect(screen.getByLabelText("登録番号")).toHaveValue("T1234567890123");
    expect(screen.getByLabelText("税率ごとの内訳表示")).toHaveValue("separate");
    expect(screen.getByLabelText("次の通し番号")).toHaveValue(43);
    expect(screen.getByText(/12 以上/)).toBeInTheDocument();
  });

  it("入力して保存すると PUT し、保存した知らせを出す（任意の項目は送らない）", async () => {
    const calls = mockApi({
      [`GET ${PATH}`]: () => ok({ settings: null, minimumNextSeq: 1 }),
      [`PUT ${PATH}`]: () => ok({ settings: SETTINGS }),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("氏名");

    await fillRequired(user);
    await user.selectOptions(screen.getByLabelText("税率ごとの内訳表示"), "separate");
    await user.clear(screen.getByLabelText("次の通し番号"));
    await user.type(screen.getByLabelText("次の通し番号"), "43");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("保存しました"));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({
      issuerName: "山田 太郎",
      address: "東京都千代田区",
      contact: "taro@example.com",
      bankAccount: "○○銀行 普通 1234567",
      taxDisplay: "separate",
      nextSeq: 43,
    });
  });

  it("屋号と登録番号を入れると一緒に送る", async () => {
    const calls = mockApi({
      [`GET ${PATH}`]: () => ok({ settings: null, minimumNextSeq: 1 }),
      [`PUT ${PATH}`]: () => ok({ settings: SETTINGS }),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("氏名");
    await fillRequired(user);
    await user.type(screen.getByLabelText("屋号"), "山田設計");
    await user.type(screen.getByLabelText("登録番号"), "T1234567890123");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("保存しました"));
    expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({
      tradeName: "山田設計",
      registrationNumber: "T1234567890123",
    });
  });

  it("INVOICE_SEQ_TOO_LOW は下限つきの文言で知らせる", async () => {
    mockApi({
      [`GET ${PATH}`]: () => ok({ settings: SETTINGS, minimumNextSeq: 12 }),
      [`PUT ${PATH}`]: () =>
        apiError(422, "INVOICE_SEQ_TOO_LOW", "次の通し番号が小さすぎます", { minimum: 12 }),
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByLabelText("氏名");

    await user.click(screen.getByRole("button", { name: "保存" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("次の通し番号は 12 以上にしてください");
  });

  it("次の通し番号が 0 や小数、登録番号の形が違うときは送らずに知らせる", async () => {
    const calls = mockApi({
      [`GET ${PATH}`]: () => ok({ settings: SETTINGS, minimumNextSeq: 1 }),
      [`PUT ${PATH}`]: () => ok({ settings: SETTINGS }),
    });
    const user = userEvent.setup();
    renderPage();
    const seq = await screen.findByLabelText("次の通し番号");

    await user.clear(seq);
    await user.type(seq, "0");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/1 以上の整数/)).toBeInTheDocument();

    await user.clear(seq);
    await user.type(seq, "2.5");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/1 以上の整数/)).toBeInTheDocument();

    await user.clear(seq);
    await user.type(seq, "5");
    await user.clear(screen.getByLabelText("登録番号"));
    await user.type(screen.getByLabelText("登録番号"), "T123");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/T と 13 桁/)).toBeInTheDocument();

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(false));
  });
});
