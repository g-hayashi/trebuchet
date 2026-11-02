import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/settings/ai";
import { type ApiCall, apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 006 US5: AI の設定（H:§7。端末の設定）。API キーは入力だけで、応答には `apiKeySet` しか来ない

const SETTINGS = {
  localEnabled: true,
  localAvailable: true,
  externalEnabled: false,
  externalBaseUrl: null as string | null,
  externalModel: null as string | null,
  receiptImagesEnabled: false,
  apiKeySet: false,
};

const putCalls = (all: ApiCall[]) =>
  all.filter((c) => c.method === "PUT" && c.path === "/api/settings/ai");

function openSettings(
  settings: Partial<typeof SETTINGS> = {},
  extra: Record<string, Parameters<typeof mockApi>[0][string]> = {},
) {
  const all = mockApi({
    "GET /api/settings/ai": () => ok({ ...SETTINGS, ...settings }),
    // 保存は、送られた内容を 7.1 の形にして返す（キーは apiKeySet だけ）
    "PUT /api/settings/ai": (call) => {
      const body = call.body as Record<string, unknown>;
      return ok({
        ...SETTINGS,
        ...settings,
        localEnabled: body.localEnabled,
        externalEnabled: body.externalEnabled,
        externalBaseUrl: body.externalBaseUrl ?? null,
        externalModel: body.externalModel ?? null,
        receiptImagesEnabled: body.receiptImagesEnabled,
        apiKeySet: body.apiKey === undefined ? (settings.apiKeySet ?? false) : body.apiKey !== "",
      });
    },
    ...extra,
  });
  renderRoute(Route, { path: "/settings/ai", url: "/settings/ai" });
  return all;
}

const user = () => userEvent.setup();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AI の設定の表示", () => {
  it("端末内の AI の可否と、外部の接続先・モデルを表示する。API キーは出さない", async () => {
    openSettings({
      externalEnabled: true,
      externalBaseUrl: "https://api.example.com/v1",
      externalModel: "model-a",
      apiKeySet: true,
    });
    expect(await screen.findByLabelText("端末内の AI を使う")).toBeChecked();
    expect(screen.getByText("この端末の AI は使えます。")).toBeInTheDocument();
    expect(screen.getByLabelText("外部の AI を使う")).toBeChecked();
    expect(screen.getByLabelText("接続先の URL")).toHaveValue("https://api.example.com/v1");
    expect(screen.getByLabelText("モデル")).toHaveValue("model-a");
    // キーは入力欄に入れない。設定済みであることだけ示す
    expect(screen.getByLabelText("API キー")).toHaveValue("");
    expect(screen.getByLabelText("API キー")).toHaveAttribute("type", "password");
    expect(screen.getByText("API キーは設定済みです。")).toBeInTheDocument();
  });

  it("端末内の AI が使えないときは、その旨を示す", async () => {
    openSettings({ localAvailable: false });
    expect(await screen.findByText("この端末の AI は使えません。")).toBeInTheDocument();
  });

  it("キーが未設定のときは、その旨を示す", async () => {
    openSettings();
    expect(await screen.findByText("API キーは未設定です。")).toBeInTheDocument();
  });
});

describe("AI の設定の保存（H:§7.2）", () => {
  it("入力した内容を PUT する。キーを打たなければ apiKey は送らない", async () => {
    const all = openSettings({
      externalBaseUrl: "https://api.example.com/v1",
      externalModel: "model-a",
      apiKeySet: true,
      externalEnabled: true,
    });
    const u = user();
    await screen.findByLabelText("端末内の AI を使う");
    await u.click(screen.getByLabelText("端末内の AI を使う"));
    await u.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putCalls(all)).toHaveLength(1));
    expect(putCalls(all)[0]?.body).toEqual({
      localEnabled: false,
      externalEnabled: true,
      externalBaseUrl: "https://api.example.com/v1",
      externalModel: "model-a",
      receiptImagesEnabled: false,
    });
    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
  });

  it("証憑の画像の送信（receiptImagesEnabled）は今の値を保って送る。外部を無効にすると false にする（010 R15）", async () => {
    const all = openSettings({
      externalBaseUrl: "https://api.example.com/v1",
      externalModel: "model-a",
      apiKeySet: true,
      externalEnabled: true,
      receiptImagesEnabled: true,
    });
    const u = user();
    await screen.findByLabelText("端末内の AI を使う");
    await u.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(putCalls(all)).toHaveLength(1));
    expect(putCalls(all)[0]?.body).toMatchObject({
      externalEnabled: true,
      receiptImagesEnabled: true,
    });

    await u.click(screen.getByLabelText("外部の AI を使う"));
    await u.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(putCalls(all)).toHaveLength(2));
    expect(putCalls(all)[1]?.body).toMatchObject({
      externalEnabled: false,
      receiptImagesEnabled: false,
    });
  });

  it("キーを打つと apiKey を送り、保存の後は入力欄を空に戻す", async () => {
    const all = openSettings();
    const u = user();
    await screen.findByLabelText("端末内の AI を使う");
    await u.click(screen.getByLabelText("外部の AI を使う"));
    await u.type(screen.getByLabelText("接続先の URL"), "http://localhost:11434/v1");
    await u.type(screen.getByLabelText("モデル"), "model-b");
    await u.type(screen.getByLabelText("API キー"), "sk-test-123");
    await u.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(putCalls(all)).toHaveLength(1));
    expect(putCalls(all)[0]?.body).toEqual({
      localEnabled: true,
      externalEnabled: true,
      externalBaseUrl: "http://localhost:11434/v1",
      externalModel: "model-b",
      receiptImagesEnabled: false,
      apiKey: "sk-test-123",
    });
    await waitFor(() => expect(screen.getByLabelText("API キー")).toHaveValue(""));
  });

  it("「API キーを削除」で空文字を送る", async () => {
    const all = openSettings({ apiKeySet: true });
    const u = user();
    await u.click(await screen.findByRole("button", { name: "API キーを削除" }));
    await waitFor(() => expect(putCalls(all)).toHaveLength(1));
    expect(putCalls(all)[0]?.body).toMatchObject({ apiKey: "" });
  });

  it("https でも localhost でもない URL は、送らずに知らせる", async () => {
    const all = openSettings();
    const u = user();
    await screen.findByLabelText("端末内の AI を使う");
    await u.type(screen.getByLabelText("接続先の URL"), "http://example.com/v1");
    await u.click(screen.getByRole("button", { name: "保存" }));
    expect(
      await screen.findByText("接続先の URL は https:// か localhost だけです"),
    ).toBeInTheDocument();
    expect(putCalls(all)).toHaveLength(0);
  });

  it("外部の AI を使うのに接続先・モデル・キーがそろっていなければ、送らずに知らせる", async () => {
    const all = openSettings();
    const u = user();
    await screen.findByLabelText("端末内の AI を使う");
    await u.click(screen.getByLabelText("外部の AI を使う"));
    await u.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("接続先の URL を入力してください")).toBeInTheDocument();
    expect(screen.getByText("モデルを入力してください")).toBeInTheDocument();
    expect(screen.getByText("API キーを入力してください")).toBeInTheDocument();
    expect(putCalls(all)).toHaveLength(0);
  });

  it("422 AI_NOT_CONFIGURED はエラーとして示す", async () => {
    openSettings(
      { apiKeySet: true },
      {
        "PUT /api/settings/ai": () =>
          apiError(
            422,
            "AI_NOT_CONFIGURED",
            "外部の AI の接続先・モデル・API キーがそろっていません",
          ),
      },
    );
    const u = user();
    await u.click(await screen.findByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "外部の AI の接続先・モデル・API キーがそろっていません",
    );
  });
});
