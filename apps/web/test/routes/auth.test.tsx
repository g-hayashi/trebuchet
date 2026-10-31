import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthStatus } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "@/features/auth/AuthGate";
import { entitiesQuery } from "@/features/entities/api";
import { Route } from "@/routes/settings/security";
import {
  type ApiCall,
  type ApiReply,
  apiError,
  DEFAULT_AUTH_STATUS,
  mockApi,
  ok,
} from "../mock-api";
import { renderRoute } from "../render-route";

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

const NO_CONTENT = { status: 204, body: undefined };

beforeEach(() => {
  vi.mocked(startRegistration).mockReset();
  vi.mocked(startAuthentication).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** サーバーが持つ認証の状態。操作で変わる応答を、テストの中で書き換える */
function authState(initial: Partial<AuthStatus>) {
  let status: AuthStatus = { ...DEFAULT_AUTH_STATUS, ...initial };
  return {
    get: () => status,
    set(patch: Partial<AuthStatus>) {
      status = { ...status, ...patch };
    },
  };
}

/** AuthGate の中身。解錠済みのときだけ描画され、帳簿の API を呼ぶ */
function LedgerProbe() {
  useQuery(entitiesQuery());
  return <p>帳簿の画面</p>;
}

function renderGate() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <LedgerProbe />
      </AuthGate>
    </QueryClientProvider>,
  );
}

const callsTo = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

/** 回復キーの保管の画面で、キーを読んで「保管した」にチェックを付け、先へ進む */
async function acknowledgeKey(expected: string) {
  const panel = await screen.findByRole("region", { name: "回復キーの保管" });
  expect(within(panel).getByRole("textbox", { name: "回復キー" })).toHaveValue(expected);
  expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
  expect(within(panel).getByRole("button", { name: "続ける" })).toBeDisabled();
  await userEvent.click(
    within(panel).getByRole("checkbox", { name: "回復キーを安全な場所に保管しました" }),
  );
  await userEvent.click(within(panel).getByRole("button", { name: "続ける" }));
}

const LOCKED_STATUS = { signedIn: false, recoveryAcknowledged: null } as const;

describe("AuthGate: 初回の設定", () => {
  it("未設定なら初回の設定の画面。PRF の出力が返らなければ認証をもう一度行い、回復キーは「保管した」を押すまで先に進めない", async () => {
    const state = authState({ registered: false, ...LOCKED_STATUS });
    vi.mocked(startRegistration).mockResolvedValue({ id: "cred1" } as never);
    vi.mocked(startAuthentication).mockResolvedValue({
      id: "cred1",
      clientExtensionResults: { prf: { results: { first: new Uint8Array([1, 2, 3]).buffer } } },
    } as never);
    let verifyCount = 0;
    const calls = mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "POST /api/auth/register/options": () => ok({ challenge: "c1" }),
      "POST /api/auth/register/verify": () => {
        verifyCount += 1;
        if (verifyCount === 1) return ok({ status: "prf_required", options: { challenge: "p2" } });
        state.set({ registered: true, signedIn: true, recoveryAcknowledged: false });
        return ok({ recoveryCode: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH" }, 201);
      },
      "POST /api/auth/recovery/acknowledge": () => {
        state.set({ recoveryAcknowledged: true });
        return NO_CONTENT;
      },
      "GET /api/entities": () => ok({ entities: [] }),
    });
    renderGate();

    expect(await screen.findByRole("heading", { name: "初回の設定" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "パスキーを作成" }));
    await acknowledgeKey("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH");

    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "c1" } });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "p2" } });
    const verifies = callsTo(calls, "POST", "/api/auth/register/verify");
    expect(verifies.map((v) => v.body)).toEqual([
      { response: { id: "cred1" } },
      {
        response: { id: "cred1", clientExtensionResults: { prf: { results: { first: "AQID" } } } },
      },
    ]);
    expect(callsTo(calls, "POST", "/api/auth/recovery/acknowledge")).toHaveLength(1);
    // 確認した後は、作り直しの案内も出ない
    expect(screen.queryByText(/作り直/)).not.toBeInTheDocument();
  });

  it("PRF の出力が最初から返れば、認証は 1 回だけ", async () => {
    const state = authState({ registered: false, ...LOCKED_STATUS });
    vi.mocked(startRegistration).mockResolvedValue({ id: "cred1" } as never);
    mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "POST /api/auth/register/options": () => ok({ challenge: "c1" }),
      "POST /api/auth/register/verify": () => ok({ recoveryCode: "KEY1" }, 201),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "パスキーを作成" }));
    expect(await screen.findByRole("region", { name: "回復キーの保管" })).toBeInTheDocument();
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("ts.net の rpId で未設定なら、設定の操作は出ず、localhost で開く案内が出る", async () => {
    mockApi({
      "GET /api/auth/status": () =>
        ok({
          ...DEFAULT_AUTH_STATUS,
          registered: false,
          signedIn: false,
          rpId: "mac.tail1234.ts.net",
          recoveryAcknowledged: null,
        }),
    });
    renderGate();

    expect(
      await screen.findByText(/Mac のローカルの名前（localhost）で開いて設定してください/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "パスキーを作成" })).not.toBeInTheDocument();
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
  });

  it("パスキーの確認に失敗したら、文言を出してやり直せる", async () => {
    vi.mocked(startRegistration).mockRejectedValue(new Error("NotAllowedError"));
    mockApi({
      "GET /api/auth/status": () =>
        ok({ ...DEFAULT_AUTH_STATUS, registered: false, ...LOCKED_STATUS }),
      "POST /api/auth/register/options": () => ok({ challenge: "c1" }),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "パスキーを作成" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("パスキーの確認に失敗しました");
    expect(screen.getByRole("button", { name: "パスキーを作成" })).toBeEnabled();
  });

  it("PRF に対応しないパスキーなら、対応するパスキーの案内を出す", async () => {
    vi.mocked(startRegistration).mockResolvedValue({ id: "cred1" } as never);
    mockApi({
      "GET /api/auth/status": () =>
        ok({ ...DEFAULT_AUTH_STATUS, registered: false, ...LOCKED_STATUS }),
      "POST /api/auth/register/options": () => ok({ challenge: "c1" }),
      "POST /api/auth/register/verify": () =>
        apiError(400, "PRF_UNSUPPORTED", "このパスキーは鍵の保護（PRF）に対応していません"),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "パスキーを作成" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("iCloud キーチェーン");
    expect(alert).toHaveTextContent("1Password");
    expect(screen.queryByRole("region", { name: "回復キーの保管" })).not.toBeInTheDocument();
  });
});

describe("AuthGate: パスキーで解錠", () => {
  it("施錠中なら解錠の画面。成功すると帳簿の画面", async () => {
    const state = authState(LOCKED_STATUS);
    vi.mocked(startAuthentication).mockResolvedValue({
      id: "cred1",
      clientExtensionResults: { prf: { results: { first: new Uint8Array([1, 2, 3]).buffer } } },
    } as never);
    const calls = mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "POST /api/auth/sign-in/options": () =>
        ok({
          challenge: "s1",
          extensions: { prf: { evalByCredential: { cred1: { first: "AQID" } } } },
        }),
      "POST /api/auth/sign-in/verify": () => {
        state.set({ signedIn: true, recoveryAcknowledged: true });
        return ok({ ok: true });
      },
      "GET /api/entities": () => ok({ entities: [] }),
    });
    renderGate();

    expect(
      await screen.findByRole("heading", { name: "帳簿は施錠されています" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
    expect(callsTo(calls, "GET", "/api/entities")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "パスキーで解錠" }));

    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    // PRF の入力は bytes にして渡し、出力は base64url にして送る
    const arg = vi.mocked(startAuthentication).mock.calls[0]?.[0] as unknown as {
      optionsJSON: { extensions: { prf: { evalByCredential: { cred1: { first: Uint8Array } } } } };
    };
    expect(Array.from(arg.optionsJSON.extensions.prf.evalByCredential.cred1.first)).toEqual([
      1, 2, 3,
    ]);
    expect(callsTo(calls, "POST", "/api/auth/sign-in/verify")[0]?.body).toEqual({
      response: { id: "cred1", clientExtensionResults: { prf: { results: { first: "AQID" } } } },
    });
  });

  it("API が 401 UNAUTHENTICATED を返したら、解錠の画面に戻る", async () => {
    const state = authState({});
    mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "GET /api/entities": () => {
        state.set(LOCKED_STATUS);
        return apiError(401, "UNAUTHENTICATED", "解錠が必要です");
      },
    });
    renderGate();

    expect(await screen.findByRole("button", { name: "パスキーで解錠" })).toBeInTheDocument();
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
  });

  it("API が 401 LOCKED を返したら（無操作の失効など）、解錠の画面に戻る", async () => {
    const state = authState({});
    mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "GET /api/entities": () => {
        state.set(LOCKED_STATUS);
        return apiError(401, "LOCKED", "帳簿は施錠されています");
      },
    });
    renderGate();

    expect(await screen.findByRole("button", { name: "パスキーで解錠" })).toBeInTheDocument();
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
  });

  it("解錠の検証に失敗したら、文言を出す", async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: "x" } as never);
    mockApi({
      "GET /api/auth/status": () => ok({ ...DEFAULT_AUTH_STATUS, ...LOCKED_STATUS }),
      "POST /api/auth/sign-in/options": () => ok({ challenge: "s1" }),
      "POST /api/auth/sign-in/verify": () =>
        apiError(400, "WEBAUTHN_FAILED", "パスキーの確認に失敗しました"),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "パスキーで解錠" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("パスキーの確認に失敗しました");
  });
});

describe("AuthGate: 回復キーで解錠", () => {
  it("回復キー → 新しいパスキー（失敗してもやり直せる。PRF の認証も行う）→ 新しいキーの表示 → 保管した → 帳簿の画面", async () => {
    const state = authState(LOCKED_STATUS);
    vi.mocked(startRegistration)
      .mockRejectedValueOnce(new Error("NotAllowedError"))
      .mockResolvedValueOnce({ id: "cred2" } as never);
    vi.mocked(startAuthentication).mockResolvedValue({
      id: "cred2",
      clientExtensionResults: { prf: { results: { first: new Uint8Array([4, 5, 6]).buffer } } },
    } as never);
    let verifyCount = 0;
    const calls = mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "POST /api/auth/recovery/verify": () => ok({ ok: true }),
      "POST /api/auth/recovery/register/options": () => ok({ challenge: "r1" }),
      "POST /api/auth/recovery/register/verify": () => {
        verifyCount += 1;
        if (verifyCount === 1) return ok({ status: "prf_required", options: { challenge: "r2" } });
        state.set({ signedIn: true, recoveryAcknowledged: false });
        return ok({ recoveryCode: "NEW1-NEW2" }, 201);
      },
      "POST /api/auth/recovery/acknowledge": () => {
        state.set({ recoveryAcknowledged: true });
        return NO_CONTENT;
      },
      "GET /api/entities": () => ok({ entities: [] }),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "回復キーで解錠" }));
    await userEvent.type(screen.getByRole("textbox", { name: "回復キー" }), "OLD1-OLD2");
    await userEvent.click(screen.getByRole("button", { name: "回復キーを確認" }));
    expect(callsTo(calls, "POST", "/api/auth/recovery/verify")[0]?.body).toEqual({
      code: "OLD1-OLD2",
    });

    // 1回目の登録は失敗。回復キーの入力には戻らず、そのままやり直せる
    await userEvent.click(await screen.findByRole("button", { name: "新しいパスキーを登録" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("パスキーの確認に失敗しました");
    await userEvent.click(screen.getByRole("button", { name: "新しいパスキーを登録" }));

    await acknowledgeKey("NEW1-NEW2");
    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    expect(callsTo(calls, "POST", "/api/auth/recovery/verify")).toHaveLength(1);
    expect(callsTo(calls, "POST", "/api/auth/recovery/register/verify")[1]?.body).toEqual({
      response: { id: "cred2", clientExtensionResults: { prf: { results: { first: "BAUG" } } } },
    });
    expect(callsTo(calls, "POST", "/api/auth/recovery/acknowledge")).toHaveLength(1);
  });

  it("RECOVERY_INVALID の文言（008: 回復のロックはなくした）", async () => {
    mockApi({
      "GET /api/auth/status": () => ok({ ...DEFAULT_AUTH_STATUS, ...LOCKED_STATUS }),
      "POST /api/auth/recovery/verify": () =>
        apiError(400, "RECOVERY_INVALID", "回復キーが違います"),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "回復キーで解錠" }));
    await userEvent.type(screen.getByRole("textbox", { name: "回復キー" }), "WRONG");
    await userEvent.click(screen.getByRole("button", { name: "回復キーを確認" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("回復キーが違います");
    // もう一度入力できる
    expect(screen.getByRole("button", { name: "回復キーを確認" })).toBeEnabled();
  });
});

describe("AuthGate: 回復キーの作り直しの案内", () => {
  it("recoveryAcknowledged が false なら案内が出る。作り直して「保管した」を確認すると出なくなる", async () => {
    const state = authState({ recoveryAcknowledged: false });
    const calls = mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "POST /api/auth/recovery/regenerate": () => ok({ recoveryCode: "RE11-RE22" }, 201),
      "POST /api/auth/recovery/acknowledge": () => {
        state.set({ recoveryAcknowledged: true });
        return NO_CONTENT;
      },
      "GET /api/entities": () => ok({ entities: [] }),
    });
    renderGate();

    // 帳簿の画面の上に案内が出る
    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    const notice = screen.getByRole("region", { name: "回復キーの確認" });
    await userEvent.click(within(notice).getByRole("button", { name: "回復キーを作り直す" }));

    // 保管の確認をするまでは、帳簿の画面に戻らない
    await acknowledgeKey("RE11-RE22");
    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    expect(callsTo(calls, "POST", "/api/auth/recovery/acknowledge")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "回復キーの確認" })).not.toBeInTheDocument();
  });

  it("確認済みなら案内は出ない", async () => {
    mockApi({ "GET /api/entities": () => ok({ entities: [] }) });
    renderGate();
    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "回復キーの確認" })).not.toBeInTheDocument();
  });
});

describe("設定 / セキュリティ", () => {
  const passkeys = [
    {
      id: "pk1",
      name: "MacBook",
      rpId: "localhost",
      createdAt: "2026-10-01T00:00:00.000Z",
      lastUsedAt: "2026-10-10T00:00:00.000Z",
    },
    {
      id: "pk2",
      name: "iPhone",
      rpId: "mac.tail1234.ts.net",
      createdAt: "2026-10-02T00:00:00.000Z",
      lastUsedAt: null,
    },
  ];
  const sessions = [
    {
      id: "s1",
      rpId: "localhost",
      userAgent: "Mac Safari",
      createdAt: "2026-10-10T00:00:00.000Z",
      lastSeenAt: "2026-10-10T01:00:00.000Z",
      current: true,
    },
    {
      id: "s2",
      rpId: "mac.tail1234.ts.net",
      userAgent: "iPhone Safari",
      createdAt: "2026-10-09T00:00:00.000Z",
      lastSeenAt: "2026-10-09T01:00:00.000Z",
      current: false,
    },
  ];
  const events = [
    {
      id: "ev3",
      occurredAt: "2026-10-10T03:00:00.000Z",
      kind: "sign_in",
      rpId: "localhost",
      passkeyId: "pk1",
      sessionId: "s1",
      userAgent: "Mac Safari",
      detail: null,
    },
    {
      id: "ev2",
      occurredAt: "2026-10-10T02:00:00.000Z",
      kind: "sign_in_failed",
      rpId: "localhost",
      passkeyId: null,
      sessionId: null,
      userAgent: "Mac Safari",
      detail: null,
    },
    {
      id: "ev1",
      occurredAt: "2026-10-10T01:00:00.000Z",
      kind: "register",
      rpId: "localhost",
      passkeyId: "pk1",
      sessionId: "s1",
      userAgent: "Mac Safari",
      detail: null,
    },
  ];

  function open(extra: Parameters<typeof mockApi>[0] = {}) {
    const calls = mockApi({
      "GET /api/auth/passkeys": () => ok({ passkeys }),
      "GET /api/auth/sessions": () => ok({ sessions }),
      "GET /api/auth/events": () => ok({ events }),
      ...extra,
    });
    renderRoute(Route, { path: "/settings/security", url: "/settings/security" });
    return calls;
  }

  /** 再認証（reauth/verify）の前は 403 REAUTH_REQUIRED、後は渡した応答を返す */
  function reauthGate() {
    let reauthed = false;
    return {
      mark: () => {
        reauthed = true;
      },
      guard: (reply: () => ApiReply): ApiReply =>
        reauthed ? reply() : apiError(403, "REAUTH_REQUIRED", "再認証が必要です"),
    };
  }

  const reauthRoutes = (gate: ReturnType<typeof reauthGate>) => ({
    "POST /api/auth/reauth/options": () =>
      ok({
        challenge: "ra1",
        extensions: { prf: { evalByCredential: { pk1: { first: "AQID" } } } },
      }),
    "POST /api/auth/reauth/verify": () => {
      gate.mark();
      return NO_CONTENT;
    },
  });

  it("パスキーの一覧と、名前の変更", async () => {
    const calls = open({
      "PATCH /api/auth/passkeys/pk2": () =>
        ok({ passkey: { ...passkeys[1], name: "仕事用 iPhone" } }),
    });
    const list = await screen.findByRole("table", { name: "パスキーの一覧" });
    const rows = within(list).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("MacBook");
    expect(rows[1]).toHaveTextContent("localhost");
    expect(rows[2]).toHaveTextContent("iPhone");
    expect(rows[2]).toHaveTextContent("mac.tail1234.ts.net");

    await userEvent.click(
      within(rows[2] as HTMLElement).getByRole("button", { name: "名前の変更" }),
    );
    const input = screen.getByLabelText("パスキーの名前");
    await userEvent.clear(input);
    await userEvent.type(input, "仕事用 iPhone");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(callsTo(calls, "PATCH", "/api/auth/passkeys/pk2")).toHaveLength(1));
    expect(callsTo(calls, "PATCH", "/api/auth/passkeys/pk2")[0]?.body).toEqual({
      name: "仕事用 iPhone",
    });
  });

  it("パスキーの削除は確認してから。最後の1つ（LAST_PASSKEY）は文言を出す", async () => {
    const calls = open({
      "DELETE /api/auth/passkeys/pk1": () =>
        apiError(409, "LAST_PASSKEY", "この Mac（localhost）の最後のパスキーは削除できません"),
    });
    const list = await screen.findByRole("table", { name: "パスキーの一覧" });
    const row = within(list).getAllByRole("row")[1] as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "削除" }));
    expect(callsTo(calls, "DELETE", "/api/auth/passkeys/pk1")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("最後のパスキー");
    expect(callsTo(calls, "DELETE", "/api/auth/passkeys/pk1")).toHaveLength(1);
  });

  it("パスキーの削除で再認証が要るとき（403 REAUTH_REQUIRED）は、パスキーで確認してから操作をやり直す", async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: "pk1" } as never);
    const gate = reauthGate();
    const calls = open({
      ...reauthRoutes(gate),
      "DELETE /api/auth/passkeys/pk2": () => gate.guard(() => NO_CONTENT),
    });
    const list = await screen.findByRole("table", { name: "パスキーの一覧" });
    const row = within(list).getAllByRole("row")[2] as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "削除" }));
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));

    await waitFor(() => expect(callsTo(calls, "DELETE", "/api/auth/passkeys/pk2")).toHaveLength(2));
    expect(calls.map((c) => `${c.method} ${c.path}`).filter((k) => !k.startsWith("GET"))).toEqual([
      "DELETE /api/auth/passkeys/pk2",
      "POST /api/auth/reauth/options",
      "POST /api/auth/reauth/verify",
      "DELETE /api/auth/passkeys/pk2",
    ]);
    const arg = vi.mocked(startAuthentication).mock.calls[0]?.[0] as unknown as {
      optionsJSON: { challenge: string; extensions: { prf: { evalByCredential: object } } };
    };
    expect(arg.optionsJSON.challenge).toBe("ra1");
    expect(callsTo(calls, "POST", "/api/auth/reauth/verify")[0]?.body).toEqual({
      response: { id: "pk1" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("パスキーの追加（PRF の認証もする）。再認証が要れば確認してからやり直す", async () => {
    vi.mocked(startRegistration).mockResolvedValue({ id: "cred3" } as never);
    vi.mocked(startAuthentication).mockResolvedValue({
      id: "cred3",
      clientExtensionResults: { prf: { results: { first: new Uint8Array([1, 2, 3]).buffer } } },
    } as never);
    const gate = reauthGate();
    let verifyCount = 0;
    const calls = open({
      ...reauthRoutes(gate),
      "POST /api/auth/passkeys/options": () => gate.guard(() => ok({ challenge: "p1" })),
      "POST /api/auth/passkeys/verify": () => {
        verifyCount += 1;
        if (verifyCount === 1) return ok({ status: "prf_required", options: { challenge: "p2" } });
        return ok({ passkey: passkeys[0] }, 201);
      },
    });
    await screen.findByRole("table", { name: "パスキーの一覧" });
    await userEvent.type(screen.getByLabelText("追加するパスキーの名前"), "予備");
    await userEvent.click(screen.getByRole("button", { name: "パスキーを追加" }));

    await waitFor(() =>
      expect(callsTo(calls, "POST", "/api/auth/passkeys/verify")).toHaveLength(2),
    );
    expect(callsTo(calls, "POST", "/api/auth/reauth/verify")).toHaveLength(1);
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "p1" } });
    expect(callsTo(calls, "POST", "/api/auth/passkeys/verify").map((v) => v.body)).toEqual([
      { response: { id: "cred3" }, name: "予備" },
      {
        response: {
          id: "cred3",
          clientExtensionResults: { prf: { results: { first: "AQID" } } },
        },
        name: "予備",
      },
    ]);
  });

  it("セッションは現在のものに印が付き、他のセッションを失効できる", async () => {
    const calls = open({ "DELETE /api/auth/sessions/s2": () => NO_CONTENT });
    const list = await screen.findByRole("table", { name: "セッションの一覧" });
    const rows = within(list).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("現在のセッション");
    expect(within(rows[1] as HTMLElement).queryByRole("button", { name: "失効" })).toBeNull();
    expect(rows[2]).not.toHaveTextContent("現在のセッション");

    await userEvent.click(within(rows[2] as HTMLElement).getByRole("button", { name: "失効" }));
    await waitFor(() => expect(callsTo(calls, "DELETE", "/api/auth/sessions/s2")).toHaveLength(1));
  });

  it("認証の記録は、サーバーが返した新しい順のまま並ぶ", async () => {
    open();
    const list = await screen.findByRole("table", { name: "認証の記録" });
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("解錠");
    expect(rows[0]).not.toHaveTextContent("失敗");
    expect(rows[1]).toHaveTextContent("解錠の失敗");
    expect(rows[2]).toHaveTextContent("登録");
    expect(rows[0]).toHaveTextContent("Mac Safari");
    expect(rows[0]).toHaveTextContent("localhost");
  });

  it("回復キーの再発行は、再認証をして、新しいキーを表示し、保管したと確認する", async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: "pk1" } as never);
    const gate = reauthGate();
    const calls = open({
      ...reauthRoutes(gate),
      "POST /api/auth/recovery/regenerate": () =>
        gate.guard(() => ok({ recoveryCode: "RG11-RG22" }, 201)),
      "POST /api/auth/recovery/acknowledge": () => NO_CONTENT,
    });
    await userEvent.click(await screen.findByRole("button", { name: "回復キーを作り直す" }));
    const panel = await screen.findByRole("region", { name: "回復キーの保管" });
    expect(within(panel).getByRole("textbox", { name: "回復キー" })).toHaveValue("RG11-RG22");
    expect(callsTo(calls, "POST", "/api/auth/reauth/verify")).toHaveLength(1);
    expect(callsTo(calls, "POST", "/api/auth/recovery/regenerate")).toHaveLength(2);
    expect(within(panel).getByRole("button", { name: "続ける" })).toBeDisabled();
    await userEvent.click(
      within(panel).getByRole("checkbox", { name: "回復キーを安全な場所に保管しました" }),
    );
    await userEvent.click(within(panel).getByRole("button", { name: "続ける" }));

    await waitFor(() => expect(screen.queryByText("RG11-RG22")).not.toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "回復キーの保管" })).not.toBeInTheDocument();
    expect(callsTo(calls, "POST", "/api/auth/recovery/acknowledge")).toHaveLength(1);
  });

  it("再認証に失敗したら、操作はやり直さず文言を出す", async () => {
    vi.mocked(startAuthentication).mockRejectedValue(new Error("NotAllowedError"));
    const calls = open({
      "POST /api/auth/reauth/options": () => ok({ challenge: "ra1" }),
      "POST /api/auth/recovery/regenerate": () =>
        apiError(403, "REAUTH_REQUIRED", "再認証が必要です"),
    });
    await userEvent.click(await screen.findByRole("button", { name: "回復キーを作り直す" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("パスキーの確認に失敗しました");
    expect(callsTo(calls, "POST", "/api/auth/recovery/regenerate")).toHaveLength(1);
  });

  it("施錠のボタンで sign-out を呼ぶ", async () => {
    const calls = open({ "POST /api/auth/sign-out": () => NO_CONTENT });
    await userEvent.click(await screen.findByRole("button", { name: "施錠" }));
    await waitFor(() => expect(callsTo(calls, "POST", "/api/auth/sign-out")).toHaveLength(1));
  });
});
