import { startAuthentication } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthStatus, TailscaleStatus } from "@trebuchet/schema";
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

// 004 US4（T018）: リモート（Tailscale）の画面。tailscale の状態と serve、設定、ペアリング

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

const TS_PATH = "/api/settings/remote/tailscale";
const SERVE_PATH = "/api/settings/remote/tailscale/serve";
const tsStatus = (s: Partial<TailscaleStatus> = {}): TailscaleStatus => ({
  installed: true,
  running: true,
  dnsName: HOST,
  serving: false,
  ...s,
});

function openRemote(
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

describe("設定 → リモート", () => {
  it("手動の手順は「手動で行う場合」に畳み、Funnel は使わない・tailnet の中だけの注意を出す", async () => {
    openRemote();
    expect(await screen.findByRole("heading", { name: "リモート" })).toBeInTheDocument();
    const details = screen.getByText("手動で行う場合").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(
      within(details as HTMLElement).getByText(
        "tailscale serve --bg --https=443 http://127.0.0.1:8787",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Funnel は使わない/)).toBeInTheDocument();
    expect(screen.getByText(/tailnet の中だけ/)).toBeInTheDocument();
  });

  it("名前を入れて有効にして保存すると、{ enabled, host } を PUT する", async () => {
    const calls = openRemote(
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
    const calls = openRemote(
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
    const calls = openRemote(
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
    openRemote(
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

  it("Tailscale・リモートの設定・ペアリングの 3 つのカードが並ぶ", async () => {
    openRemote();
    expect(await screen.findByRole("region", { name: "Tailscale" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "リモートの設定" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "ペアリング" })).toBeInTheDocument();
  });
});

describe("リモート: Tailscale の状態と serve", () => {
  const card = async () => screen.findByRole("region", { name: "Tailscale" });

  it("未インストール: 案内を出し、開始・停止のボタンは出さない", async () => {
    openRemote(undefined, { [`GET ${TS_PATH}`]: () => ok(tsStatus({ installed: false })) });
    const c = await card();
    expect(await within(c).findByText(/インストールされていません/)).toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: "開始" })).not.toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("停止中: 案内を出し、開始は出さない", async () => {
    openRemote(undefined, {
      [`GET ${TS_PATH}`]: () => ok(tsStatus({ running: false, dnsName: null })),
    });
    const c = await card();
    expect(await within(c).findByText(/停止中/)).toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: "開始" })).not.toBeInTheDocument();
  });

  it("接続中・公開していない: 名前を出し、「開始」で serve を有効にする", async () => {
    let current = tsStatus();
    const calls = openRemote(undefined, {
      [`GET ${TS_PATH}`]: () => ok(current),
      [`PUT ${SERVE_PATH}`]: () => {
        current = tsStatus({ serving: true });
        return ok(current);
      },
    });
    const c = await card();
    expect(await within(c).findByText(HOST)).toBeInTheDocument();
    expect(within(c).getByText(/公開していません/)).toBeInTheDocument();
    expect(within(c).queryByRole("button", { name: "停止" })).not.toBeInTheDocument();

    await userEvent.click(within(c).getByRole("button", { name: "開始" }));
    expect(await within(c).findByText(`https://${HOST}`)).toBeInTheDocument();
    expect(callsTo(calls, "PUT", SERVE_PATH)[0]?.body).toEqual({ enabled: true });
    expect(within(c).getByRole("button", { name: "停止" })).toBeInTheDocument();
  });

  it("公開中: URL を出し、「停止」で serve を止める", async () => {
    let current = tsStatus({ serving: true });
    const calls = openRemote(undefined, {
      [`GET ${TS_PATH}`]: () => ok(current),
      [`PUT ${SERVE_PATH}`]: () => {
        current = tsStatus({ serving: false });
        return ok(current);
      },
    });
    const c = await card();
    expect(await within(c).findByText(`https://${HOST}`)).toBeInTheDocument();
    await userEvent.click(within(c).getByRole("button", { name: "停止" }));
    await waitFor(() => expect(within(c).queryByText(`https://${HOST}`)).not.toBeInTheDocument());
    expect(callsTo(calls, "PUT", SERVE_PATH)[0]?.body).toEqual({ enabled: false });
  });

  it("tailscale のコマンドの失敗（502）は文言を出す", async () => {
    openRemote(undefined, {
      [`GET ${TS_PATH}`]: () => ok(tsStatus()),
      [`PUT ${SERVE_PATH}`]: () => apiError(502, "TAILSCALE_COMMAND_FAILED", "failed"),
    });
    const c = await card();
    await userEvent.click(await within(c).findByRole("button", { name: "開始" }));
    expect(await within(c).findByRole("alert")).toHaveTextContent("tailscale");
  });
});

describe("リモート: この Mac の名前を入れる", () => {
  const FILL = "この Mac の名前を入れる";

  it("名前が空なら、ボタンで tailscale の名前を入力欄に入れる（保存はしない）", async () => {
    const calls = openRemote(
      { enabled: false, host: null },
      { [`GET ${TS_PATH}`]: () => ok(tsStatus()) },
    );
    await userEvent.click(await screen.findByRole("button", { name: FILL }));
    expect(screen.getByLabelText("ts.net の名前")).toHaveValue(HOST);
    expect(callsTo(calls, "PUT", "/api/settings/remote")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: FILL })).not.toBeInTheDocument();
  });

  it("名前が違っても出る。同じなら出ない", async () => {
    openRemote(
      { enabled: true, host: "other.tail1234.ts.net" },
      { [`GET ${TS_PATH}`]: () => ok(tsStatus()) },
    );
    expect(await screen.findByRole("button", { name: FILL })).toBeInTheDocument();
  });

  it("tailscale の名前と同じなら出ない", async () => {
    openRemote({ enabled: true, host: HOST }, { [`GET ${TS_PATH}`]: () => ok(tsStatus()) });
    await screen.findByText(HOST);
    await waitFor(() => expect(screen.getByLabelText("ts.net の名前")).toHaveValue(HOST));
    expect(screen.queryByRole("button", { name: FILL })).not.toBeInTheDocument();
  });

  it("tailscale の名前が取れないときは出ない", async () => {
    openRemote(
      { enabled: false, host: null },
      { [`GET ${TS_PATH}`]: () => ok(tsStatus({ running: false, dnsName: null })) },
    );
    await screen.findByText(/停止中/);
    expect(screen.queryByRole("button", { name: FILL })).not.toBeInTheDocument();
  });
});

describe("リモート: ペアリング", () => {
  const PAIR_BUTTON = "この名前で使うパスキーを追加（ペアリング）";
  const mac = {
    id: "pk1",
    name: "MacBook",
    rpId: "localhost",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null,
  };
  const phone = { ...mac, id: "pk2", name: "iPhone", rpId: HOST };
  const enabled = { remote: { enabled: true, host: HOST } };

  function open(
    status: Partial<AuthStatus>,
    passkeys: (typeof mac)[],
    extra: Parameters<typeof mockApi>[0] = {},
  ) {
    return openRemote(status.remote ?? { enabled: false, host: null }, {
      "GET /api/auth/status": () => ok({ ...DEFAULT_AUTH_STATUS, ...status }),
      "GET /api/auth/passkeys": () => ok({ passkeys }),
      "GET /api/auth/events": () => ok({ events: [] }),
      ...extra,
    });
  }

  it("localhost でサインイン中・リモートが有効・名前が登録済みなら、リモートの画面に出る", async () => {
    open(enabled, [mac]);
    const section = await screen.findByRole("region", { name: "ペアリング" });
    expect(await within(section).findByRole("button", { name: PAIR_BUTTON })).toBeInTheDocument();
    expect(section).not.toHaveTextContent("登録済み");
  });

  it("その名前のパスキーがすでにあっても隠さず、本数を示して追加もできる", async () => {
    open(enabled, [mac, phone]);
    const section = await screen.findByRole("region", { name: "ペアリング" });
    expect(await within(section).findByText("登録済み（1 本）")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: PAIR_BUTTON })).toBeInTheDocument();
  });

  it.each([
    ["リモートが無効", { remote: { enabled: false, host: HOST } }, [mac]],
    ["名前が未登録", { remote: { enabled: true, host: null } }, [mac]],
    ["ts.net の名前で開いている", { ...enabled, rpId: HOST }, [mac]],
  ])("発行のボタンは出ない: %s", async (_name, status, passkeys) => {
    open(status, passkeys);
    const section = await screen.findByRole("region", { name: "ペアリング" });
    await screen.findByRole("region", { name: "リモートの設定" });
    expect(within(section).queryByRole("button", { name: PAIR_BUTTON })).not.toBeInTheDocument();
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

  it("再認証が要るときはパスキーで確認してから発行し、URL・QR・10分・一度だけを表示する", async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: "pk1" } as never);
    const gate = reauthGate();
    const calls = open(enabled, [mac], gate.routes);
    await userEvent.click(await screen.findByRole("button", { name: PAIR_BUTTON }));

    const panel = await screen.findByRole("region", { name: "ペアリングの URL" });
    expect(within(panel).getByRole("textbox", { name: "ペアリングの URL" })).toHaveValue(
      gate.issued.url,
    );
    const qr = within(panel).getByRole("img", { name: "ペアリングの QR コード" });
    expect(qr.querySelector("svg")).not.toBeNull();
    expect(panel).toHaveTextContent("10 分");
    expect(panel).toHaveTextContent("一度だけ");
    expect(panel).toHaveTextContent("iCloud キーチェーン");
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

describe("設定 → セキュリティ: パスキーの一覧", () => {
  it("ペアリングはここでは行わず、リモートの画面へのリンクを 1 行出す", async () => {
    mockApi({
      "GET /api/auth/status": () =>
        ok({ ...DEFAULT_AUTH_STATUS, remote: { enabled: true, host: HOST } }),
      "GET /api/auth/passkeys": () =>
        ok({
          passkeys: [
            {
              id: "pk1",
              name: "MacBook",
              rpId: "localhost",
              createdAt: "2026-10-01T00:00:00.000Z",
              lastUsedAt: null,
            },
          ],
        }),
      "GET /api/auth/sessions": () => ok({ sessions: [] }),
      "GET /api/auth/events": () => ok({ events: [] }),
    });
    renderRoute(SecurityRoute, { path: "/settings/security", url: "/settings/security" });
    await screen.findByRole("table", { name: "パスキーの一覧" });
    expect(
      screen.queryByRole("button", { name: "この名前で使うパスキーを追加（ペアリング）" }),
    ).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /リモート/ });
    expect(link).toHaveAttribute("href", "/settings/remote");
  });
});
