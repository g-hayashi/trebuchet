import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthStatus } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route as RemoteRoute } from "@/routes/settings/remote";
import { Route as SecurityRoute } from "@/routes/settings/security";
import {
  type ApiCall,
  type ApiReply,
  apiError,
  DEFAULT_AUTH_STATUS,
  mockApi,
  ok,
} from "../mock-api";
import { renderRoute } from "../render-route";

// 004 US4（T018）: リモート（Tailscale）の設定と、パスキーの一覧からのペアリングの発行

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(startAuthentication).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HOST = "mac.tail1234.ts.net";
const callsTo = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

describe("設定 → リモート", () => {
  function open(
    settings: { enabled: boolean; host: string | null } = { enabled: false, host: null },
    extra: Parameters<typeof mockApi>[0] = {},
  ) {
    const calls = mockApi({
      "GET /api/settings/remote": () => ok(settings),
      ...extra,
    });
    renderRoute(RemoteRoute, { path: "/settings/remote", url: "/settings/remote" });
    return calls;
  }

  it("tailscale serve の手順と、Funnel は使わない・tailnet の中だけの注意を出す", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "リモート" })).toBeInTheDocument();
    expect(
      screen.getByText("tailscale serve --bg --https=443 http://127.0.0.1:8787"),
    ).toBeVisible();
    expect(screen.getByText(/Funnel は使わない/)).toBeInTheDocument();
    expect(screen.getByText(/tailnet の中だけ/)).toBeInTheDocument();
  });

  it("名前を入れて有効にして保存すると、{ enabled, host } を PUT する", async () => {
    const calls = open(
      { enabled: false, host: null },
      { "PUT /api/settings/remote": (call) => ok(call.body) },
    );
    const enable = await screen.findByRole("checkbox", { name: "リモートを有効にする" });
    expect(enable).not.toBeChecked();
    await userEvent.click(enable);
    await userEvent.type(screen.getByLabelText("ts.net の名前"), `  ${HOST} `);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("保存しました。")).toBeInTheDocument();
    expect(callsTo(calls, "PUT", "/api/settings/remote")[0]?.body).toEqual({
      enabled: true,
      host: HOST,
    });
  });

  it("保存済みの設定を表示し、無効化しても名前は残して送る", async () => {
    const calls = open(
      { enabled: true, host: HOST },
      { "PUT /api/settings/remote": (call) => ok(call.body) },
    );
    const enable = await screen.findByRole("checkbox", { name: "リモートを有効にする" });
    await waitFor(() => expect(enable).toBeChecked());
    expect(screen.getByLabelText("ts.net の名前")).toHaveValue(HOST);
    await userEvent.click(enable);
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await screen.findByText("保存しました。");
    expect(callsTo(calls, "PUT", "/api/settings/remote")[0]?.body).toEqual({
      enabled: false,
      host: HOST,
    });
  });

  it("名前が空のときは null を送る", async () => {
    const calls = open(
      { enabled: false, host: null },
      { "PUT /api/settings/remote": (call) => ok(call.body) },
    );
    await screen.findByRole("checkbox", { name: "リモートを有効にする" });
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("保存しました。");
    expect(callsTo(calls, "PUT", "/api/settings/remote")[0]?.body).toEqual({
      enabled: false,
      host: null,
    });
  });

  it("不正な名前（422 REMOTE_HOST_INVALID）は文言を出し、保存したとは出さない", async () => {
    open(
      { enabled: false, host: null },
      {
        "PUT /api/settings/remote": () =>
          apiError(422, "REMOTE_HOST_INVALID", "*.ts.net の形で入力してください"),
      },
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "リモートを有効にする" }));
    await userEvent.type(screen.getByLabelText("ts.net の名前"), "example.com");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("*.ts.net");
    expect(screen.queryByText("保存しました。")).not.toBeInTheDocument();
  });
});

describe("パスキーの一覧: この名前で使うパスキーの追加（ペアリング）", () => {
  const PAIR_BUTTON = "この名前で使うパスキーを追加（ペアリング）";
  const mac = {
    id: "pk1",
    name: "MacBook",
    rpId: "localhost",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null,
  };
  const phone = { ...mac, id: "pk2", name: "iPhone", rpId: HOST };

  function open(
    status: Partial<AuthStatus>,
    passkeys: (typeof mac)[],
    extra: Parameters<typeof mockApi>[0] = {},
  ) {
    const calls = mockApi({
      "GET /api/auth/status": () => ok({ ...DEFAULT_AUTH_STATUS, ...status }),
      "GET /api/auth/passkeys": () => ok({ passkeys }),
      "GET /api/auth/sessions": () => ok({ sessions: [] }),
      "GET /api/auth/events": () => ok({ events: [] }),
      ...extra,
    });
    renderRoute(SecurityRoute, { path: "/settings/security", url: "/settings/security" });
    return calls;
  }
  const enabled = { remote: { enabled: true, host: HOST } };

  it("localhost でサインイン中・リモートが有効・名前が登録済み・その名前のパスキーが無いときだけ出る", async () => {
    open(enabled, [mac]);
    expect(await screen.findByRole("button", { name: PAIR_BUTTON })).toBeInTheDocument();
  });

  it.each([
    ["リモートが無効", { remote: { enabled: false, host: HOST } }, [mac]],
    ["名前が未登録", { remote: { enabled: true, host: null } }, [mac]],
    ["その名前のパスキーがすでにある", enabled, [mac, phone]],
    ["ts.net の名前で開いている", { ...enabled, rpId: HOST }, [mac]],
  ])("出ない: %s", async (_name, status, passkeys) => {
    open(status, passkeys);
    await screen.findByRole("table", { name: "パスキーの一覧" });
    expect(screen.queryByRole("button", { name: PAIR_BUTTON })).not.toBeInTheDocument();
  });

  /** 再認証（reauth/verify）の前は 403 REAUTH_REQUIRED、後は発行の応答 */
  function reauthGate() {
    let reauthed = false;
    const issued = {
      token: "tok123",
      url: `https://${HOST}/pair?token=tok123`,
      expiresAt: "2026-11-02T00:10:00.000Z",
    };
    return {
      routes: {
        "POST /api/auth/reauth/options": () => ok({ challenge: "ra1" }),
        "POST /api/auth/reauth/verify": () => {
          reauthed = true;
          return { status: 204, body: undefined } satisfies ApiReply;
        },
        "POST /api/auth/pairing": () =>
          reauthed ? ok(issued, 201) : apiError(403, "REAUTH_REQUIRED", "再認証が必要です"),
      },
      issued,
    };
  }

  it("再認証が要るときはパスキーで確認してから発行し、URL・10分・一度だけを表示する", async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: "pk1" } as never);
    const gate = reauthGate();
    const calls = open(enabled, [mac], gate.routes);
    await userEvent.click(await screen.findByRole("button", { name: PAIR_BUTTON }));

    const panel = await screen.findByRole("region", { name: "ペアリングの URL" });
    expect(within(panel).getByRole("textbox", { name: "ペアリングの URL" })).toHaveValue(
      gate.issued.url,
    );
    expect(panel).toHaveTextContent("10 分");
    expect(panel).toHaveTextContent("一度だけ");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/api/auth/pairing",
      "/api/auth/reauth/options",
      "/api/auth/reauth/verify",
      "/api/auth/pairing",
    ]);
  });

  it("URL をコピーできる", async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: "pk1" } as never);
    const gate = reauthGate();
    const user = userEvent.setup();
    open(enabled, [mac], gate.routes);
    await user.click(await screen.findByRole("button", { name: PAIR_BUTTON }));
    await user.click(await screen.findByRole("button", { name: "URL をコピー" }));
    expect(await navigator.clipboard.readText()).toBe(gate.issued.url);
  });

  it("REMOTE_NOT_CONFIGURED は、設定の「リモート」で登録する案内を出す", async () => {
    open(enabled, [mac], {
      "POST /api/auth/pairing": () =>
        apiError(409, "REMOTE_NOT_CONFIGURED", "リモートが有効ではありません"),
    });
    await userEvent.click(await screen.findByRole("button", { name: PAIR_BUTTON }));
    expect(await screen.findByRole("alert")).toHaveTextContent("リモート");
    expect(screen.queryByRole("region", { name: "ペアリングの URL" })).not.toBeInTheDocument();
  });
});
