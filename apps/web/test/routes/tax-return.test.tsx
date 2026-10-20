import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route as TaxReturnRoute } from "@/routes/e/$entityId/tax-return/$year";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const BASE = "/api/entities/e1/tax-return/2025";
const MEMOS = `${BASE}/memos`;
const DOCUMENTS = `${BASE}/documents`;

const memo = (over: Record<string, unknown> = {}) => ({
  id: "m-1",
  fiscalYear: 2025,
  kind: "salary",
  label: null,
  amount: 3_000_000,
  filePath: "/Users/me/docs/withholding.pdf",
  memo: "源泉徴収票",
  fileExists: true,
  ...over,
});

const document = (over: Record<string, unknown> = {}) => ({
  id: "d-1",
  fiscalYear: 2025,
  kind: "blue_return",
  filePath: "/Users/me/docs/blue.pdf",
  filedOn: "2026-03-10",
  memo: "e-Tax",
  fileExists: true,
  ...over,
});

type State = { memos: ReturnType<typeof memo>[]; documents: ReturnType<typeof document>[] };

function mockScreen(initial: Partial<State> = {}) {
  const state: State = { memos: initial.memos ?? [], documents: initial.documents ?? [] };
  const calls = mockApi({
    [`GET ${MEMOS}`]: () => ok({ memos: state.memos }),
    [`POST ${MEMOS}`]: (call) => {
      const saved = memo({ id: "m-new", fileExists: false, ...(call.body as object) });
      state.memos = [...state.memos, saved];
      return ok({ memo: saved }, 201);
    },
    [`PUT ${MEMOS}/m-1`]: (call) => {
      const saved = memo({ ...(call.body as object) });
      state.memos = [saved];
      return ok({ memo: saved });
    },
    [`DELETE ${MEMOS}/m-1`]: () => {
      state.memos = [];
      return { status: 204, body: undefined };
    },
    [`GET ${DOCUMENTS}`]: () => ok({ documents: state.documents }),
    [`POST ${DOCUMENTS}`]: (call) => {
      const saved = document({ id: "d-new", fileExists: false, ...(call.body as object) });
      state.documents = [...state.documents, saved];
      return ok({ document: saved }, 201);
    },
    [`PUT ${DOCUMENTS}/d-1`]: (call) => {
      const saved = document({ ...(call.body as object) });
      state.documents = [saved];
      return ok({ document: saved });
    },
    [`DELETE ${DOCUMENTS}/d-1`]: () => {
      state.documents = [];
      return { status: 204, body: undefined };
    },
  });
  return { calls, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderPage = () =>
  renderRoute(TaxReturnRoute, {
    path: "/e/$entityId/tax-return/$year",
    url: "/e/e1/tax-return/2025",
  });

const callsOf = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

const cellsOf = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((c) => c.textContent);

describe("申告の控えの画面（US6、FR-033〜036）", () => {
  it("控えの表に、種類（日本語）・金額・ファイルの場所・メモ・有無を出す", async () => {
    mockScreen({
      memos: [
        memo(),
        memo({ id: "m-2", kind: "other", label: "ふるさと納税", amount: null, filePath: null }),
        memo({
          id: "m-3",
          kind: "donation",
          amount: 50_000,
          filePath: "/Users/me/gone.pdf",
          memo: null,
          fileExists: false,
        }),
      ],
    });
    renderPage();

    const table = await screen.findByRole("table", { name: "事業所得以外の控え" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(cellsOf(rows[0] as HTMLElement)).toEqual(
      expect.arrayContaining([
        "給与所得",
        "3,000,000",
        "/Users/me/docs/withholding.pdf",
        "源泉徴収票",
        "あり",
      ]),
    );
    expect(cellsOf(rows[1] as HTMLElement)).toEqual(
      expect.arrayContaining(["その他（ふるさと納税）"]),
    );
    expect(cellsOf(rows[2] as HTMLElement)).toEqual(
      expect.arrayContaining(["寄附金控除", "50,000", "見つかりません"]),
    );
  });

  it("書類の表に、種類・場所・提出日・メモ・有無を出す", async () => {
    mockScreen({
      documents: [
        document(),
        document({ id: "d-2", kind: "attachment", filedOn: null, fileExists: false }),
      ],
    });
    renderPage();

    const table = await screen.findByRole("table", { name: "提出書類" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(cellsOf(rows[0] as HTMLElement)).toEqual(
      expect.arrayContaining([
        "青色申告決算書",
        "/Users/me/docs/blue.pdf",
        "2026-03-10",
        "e-Tax",
        "あり",
      ]),
    );
    expect(cellsOf(rows[1] as HTMLElement)).toEqual(
      expect.arrayContaining(["添付書類", "見つかりません"]),
    );
  });

  it("年分の API を読む。空のときは案内を出す", async () => {
    const { calls } = mockScreen();
    renderPage();
    expect(await screen.findByText("控えはまだ登録されていません。")).toBeInTheDocument();
    expect(screen.getByText("書類はまだ記録されていません。")).toBeInTheDocument();
    expect(callsOf(calls, "GET", MEMOS)).toHaveLength(1);
    expect(callsOf(calls, "GET", DOCUMENTS)).toHaveLength(1);
  });

  it("控えを登録する。金額は整数、空欄は null、種類は日本語の選択肢", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    const kind = await screen.findByRole("combobox", { name: "控えの種類" });
    expect(
      within(kind)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toContain("小規模企業共済等掛金控除");
    await user.selectOptions(kind, "donation");
    await user.type(screen.getByRole("textbox", { name: "控えの金額" }), "50,000");
    await user.type(
      screen.getByRole("textbox", { name: "控えのファイルの場所" }),
      "/Users/me/receipt.pdf",
    );
    await user.click(screen.getByRole("button", { name: "控えを登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", MEMOS)).toHaveLength(1));
    expect(callsOf(calls, "POST", MEMOS)[0]?.body).toEqual({
      kind: "donation",
      label: null,
      amount: 50_000,
      filePath: "/Users/me/receipt.pdf",
      memo: null,
    });
    expect(await screen.findByRole("table", { name: "事業所得以外の控え" })).toBeInTheDocument();
    expect(await screen.findByText("登録しました。")).toBeInTheDocument();
  });

  it("相対パス・不正な金額・項目名のない「その他」は送らない", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await user.type(
      await screen.findByRole("textbox", { name: "控えのファイルの場所" }),
      "docs/a.pdf",
    );
    await user.type(screen.getByRole("textbox", { name: "控えの金額" }), "12.5");
    await user.click(screen.getByRole("button", { name: "控えを登録" }));
    expect(await screen.findByText(/絶対パス（\/ で始まる）/)).toBeInTheDocument();
    expect(screen.getByText(/金額は 0 以上の整数/)).toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "控えのファイルの場所" }));
    await user.clear(screen.getByRole("textbox", { name: "控えの金額" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "控えの種類" }), "other");
    await user.click(screen.getByRole("button", { name: "控えを登録" }));
    expect(await screen.findByText(/項目名を入力してください/)).toBeInTheDocument();
    expect(callsOf(calls, "POST", MEMOS)).toHaveLength(0);
  });

  it("控えを編集（PUT）、削除（確認のあと DELETE）できる", async () => {
    const { calls } = mockScreen({ memos: [memo()] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    const row = await screen.findByRole("row", { name: /給与所得/ });
    await user.click(within(row).getByRole("button", { name: /編集/ }));
    expect(screen.getByRole("textbox", { name: "控えの金額" })).toHaveValue("3000000");
    await user.clear(screen.getByRole("textbox", { name: "控えの金額" }));
    await user.type(screen.getByRole("textbox", { name: "控えの金額" }), "3200000");
    await user.click(screen.getByRole("button", { name: "控えを更新" }));
    await waitFor(() => expect(callsOf(calls, "PUT", `${MEMOS}/m-1`)).toHaveLength(1));
    expect(callsOf(calls, "PUT", `${MEMOS}/m-1`)[0]?.body).toMatchObject({
      kind: "salary",
      amount: 3_200_000,
    });
    expect(await screen.findByText("更新しました。")).toBeInTheDocument();

    const updated = await screen.findByRole("row", { name: /3,200,000/ });
    await user.click(within(updated).getByRole("button", { name: /削除/ }));
    await waitFor(() => expect(callsOf(calls, "DELETE", `${MEMOS}/m-1`)).toHaveLength(1));
    expect(await screen.findByText("控えはまだ登録されていません。")).toBeInTheDocument();
  });

  it("削除の確認で取り消すと DELETE しない", async () => {
    const { calls } = mockScreen({ memos: [memo()] });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();

    const row = await screen.findByRole("row", { name: /給与所得/ });
    await user.click(within(row).getByRole("button", { name: /削除/ }));
    expect(callsOf(calls, "DELETE", `${MEMOS}/m-1`)).toHaveLength(0);
  });

  it("書類を記録する。提出日・メモは任意", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "書類の種類" }),
      "tax_return",
    );
    await user.type(
      screen.getByRole("textbox", { name: "書類のファイルの場所" }),
      "/Users/me/return.pdf",
    );
    await user.type(screen.getByLabelText("提出日"), "2026-03-15");
    await user.click(screen.getByRole("button", { name: "書類を登録" }));

    await waitFor(() => expect(callsOf(calls, "POST", DOCUMENTS)).toHaveLength(1));
    expect(callsOf(calls, "POST", DOCUMENTS)[0]?.body).toEqual({
      kind: "tax_return",
      filePath: "/Users/me/return.pdf",
      filedOn: "2026-03-15",
      memo: null,
    });
    expect(await screen.findByText("登録しました。")).toBeInTheDocument();
  });

  it("書類の場所が空・相対パスなら送らない", async () => {
    const { calls } = mockScreen();
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "書類を登録" }));
    expect(await screen.findByText(/ファイルの場所を入力してください/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "書類のファイルの場所" }), "a.pdf");
    await user.click(screen.getByRole("button", { name: "書類を登録" }));
    expect(await screen.findByText(/絶対パス（\/ で始まる）/)).toBeInTheDocument();
    expect(callsOf(calls, "POST", DOCUMENTS)).toHaveLength(0);
  });

  it("書類を編集（PUT）・削除（DELETE）できる", async () => {
    const { calls } = mockScreen({ documents: [document()] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    const row = await screen.findByRole("row", { name: /青色申告決算書/ });
    await user.click(within(row).getByRole("button", { name: /編集/ }));
    expect(screen.getByRole("textbox", { name: "書類のファイルの場所" })).toHaveValue(
      "/Users/me/docs/blue.pdf",
    );
    await user.clear(screen.getByRole("textbox", { name: "書類のメモ" }));
    await user.type(screen.getByRole("textbox", { name: "書類のメモ" }), "紙で提出");
    await user.click(screen.getByRole("button", { name: "書類を更新" }));
    await waitFor(() => expect(callsOf(calls, "PUT", `${DOCUMENTS}/d-1`)).toHaveLength(1));
    expect(callsOf(calls, "PUT", `${DOCUMENTS}/d-1`)[0]?.body).toMatchObject({ memo: "紙で提出" });
    expect(await screen.findByText("更新しました。")).toBeInTheDocument();

    const updated = await screen.findByRole("row", { name: /紙で提出/ });
    await user.click(within(updated).getByRole("button", { name: /削除/ }));
    await waitFor(() => expect(callsOf(calls, "DELETE", `${DOCUMENTS}/d-1`)).toHaveLength(1));
    expect(await screen.findByText("書類はまだ記録されていません。")).toBeInTheDocument();
  });

  it("サーバーの業務エラーを画面に出す", async () => {
    mockApi({
      [`GET ${MEMOS}`]: () => ok({ memos: [] }),
      [`GET ${DOCUMENTS}`]: () => ok({ documents: [] }),
      [`POST ${MEMOS}`]: () =>
        apiError(422, "ENTITY_KIND_UNSUPPORTED", "個人事業主の事業体だけが使えます"),
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "控えを登録" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("個人の事業体");
  });
});
