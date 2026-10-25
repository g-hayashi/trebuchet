import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthStatus } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "@/features/auth/AuthGate";
import { entitiesQuery } from "@/features/entities/api";
import { Route } from "@/routes/settings/security";
import { type ApiCall, apiError, DEFAULT_AUTH_STATUS, mockApi, ok } from "../mock-api";
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

/** AuthGate の中身。サインイン済みのときだけ描画され、帳簿の API を呼ぶ */
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

describe("AuthGate: 登録", () => {
  it("未登録なら登録の画面。回復コードは「控えた」を押すまで先に進めず、押すと acknowledge を呼ぶ", async () => {
    const state = authState({ registered: false, signedIn: false, recoveryAcknowledged: null });
    vi.mocked(startRegistration).mockResolvedValue({ id: "cred1" } as never);
    const calls = mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "POST /api/auth/register/options": () => ok({ challenge: "c1" }),
      "POST /api/auth/register/verify": () => {
        state.set({ registered: true, signedIn: true, recoveryAcknowledged: false });
        return ok({ recoveryCode: "AAAA-BBBB-CCCC" }, 201);
      },
      "POST /api/auth/recovery/acknowledge": () => {
        state.set({ recoveryAcknowledged: true });
        return NO_CONTENT;
      },
      "GET /api/entities": () => ok({ entities: [] }),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "パスキーを登録" }));
    expect(await screen.findByText("AAAA-BBBB-CCCC")).toBeInTheDocument();
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "c1" } });
    expect(callsTo(calls, "POST", "/api/auth/register/verify")[0]?.body).toEqual({
      response: { id: "cred1" },
    });

    // 帳簿の画面には進めない
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
    const next = screen.getByRole("button", { name: "続ける" });
    expect(next).toBeDisabled();
    expect(callsTo(calls, "POST", "/api/auth/recovery/acknowledge")).toHaveLength(0);

    await userEvent.click(screen.getByRole("checkbox", { name: /控えた/ }));
    await userEvent.click(screen.getByRole("button", { name: "続ける" }));

    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    expect(callsTo(calls, "POST", "/api/auth/recovery/acknowledge")).toHaveLength(1);
    // 確認した後は、作り直しの案内も出ない
    expect(screen.queryByText(/作り直/)).not.toBeInTheDocument();
  });

  it("ts.net の rpId で未登録なら、登録の操作は出ず、localhost で開く案内が出る", async () => {
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
      await screen.findByText(/Mac のローカルの名前（localhost）で開いて登録してください/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "パスキーを登録" })).not.toBeInTheDocument();
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
  });

  it("登録の検証に失敗したら、文言を出してやり直せる", async () => {
    vi.mocked(startRegistration).mockRejectedValue(new Error("NotAllowedError"));
    mockApi({
      "GET /api/auth/status": () =>
        ok({
          ...DEFAULT_AUTH_STATUS,
          registered: false,
          signedIn: false,
          recoveryAcknowledged: null,
        }),
      "POST /api/auth/register/options": () => ok({ challenge: "c1" }),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "パスキーを登録" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("パスキーの確認に失敗しました");
    expect(screen.getByRole("button", { name: "パスキーを登録" })).toBeEnabled();
  });
});

describe("AuthGate: サインイン", () => {
  it("未サインインならサインインの画面。成功すると帳簿の画面", async () => {
    const state = authState({ signedIn: false, recoveryAcknowledged: null });
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred1" } as never);
    const calls = mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "POST /api/auth/sign-in/options": () => ok({ challenge: "s1" }),
      "POST /api/auth/sign-in/verify": () => {
        state.set({ signedIn: true, recoveryAcknowledged: true });
        return ok({ ok: true });
      },
      "GET /api/entities": () => ok({ entities: [] }),
    });
    renderGate();

    expect(await screen.findByRole("button", { name: "パスキーでサインイン" })).toBeInTheDocument();
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
    expect(callsTo(calls, "GET", "/api/entities")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "パスキーでサインイン" }));

    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "s1" } });
    expect(callsTo(calls, "POST", "/api/auth/sign-in/verify")[0]?.body).toEqual({
      response: { id: "cred1" },
    });
  });

  it("API が 401 を返したら、サインインの画面に戻る", async () => {
    const state = authState({});
    mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "GET /api/entities": () => {
        state.set({ signedIn: false, recoveryAcknowledged: null });
        return apiError(401, "UNAUTHENTICATED", "サインインが必要です");
      },
    });
    renderGate();

    expect(await screen.findByRole("button", { name: "パスキーでサインイン" })).toBeInTheDocument();
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
  });

  it("サインインの検証に失敗したら、文言を出す", async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: "x" } as never);
    mockApi({
      "GET /api/auth/status": () =>
        ok({ ...DEFAULT_AUTH_STATUS, signedIn: false, recoveryAcknowledged: null }),
      "POST /api/auth/sign-in/options": () => ok({ challenge: "s1" }),
      "POST /api/auth/sign-in/verify": () =>
        apiError(400, "WEBAUTHN_FAILED", "パスキーの確認に失敗しました"),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "パスキーでサインイン" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("パスキーの確認に失敗しました");
  });
});

describe("AuthGate: 回復", () => {
  const signedOut = {
    ...DEFAULT_AUTH_STATUS,
    signedIn: false,
    recoveryAcknowledged: null,
  };

  it("回復コード → 新しいパスキー（失敗してもやり直せる）→ 新しいコードの表示 → 控えた → 帳簿の画面", async () => {
    const state = authState(signedOut);
    vi.mocked(startRegistration)
      .mockRejectedValueOnce(new Error("NotAllowedError"))
      .mockResolvedValueOnce({ id: "cred2" } as never);
    const calls = mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "POST /api/auth/recovery/verify": () => ok({ ok: true }),
      "POST /api/auth/recovery/register/options": () => ok({ challenge: "r1" }),
      "POST /api/auth/recovery/register/verify": () => {
        state.set({ signedIn: true, recoveryAcknowledged: false });
        return ok({ recoveryCode: "NEW1-NEW2-NEW3" }, 201);
      },
      "POST /api/auth/recovery/acknowledge": () => {
        state.set({ recoveryAcknowledged: true });
        return NO_CONTENT;
      },
      "GET /api/entities": () => ok({ entities: [] }),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "回復コードを使う" }));
    await userEvent.type(screen.getByLabelText("回復コード"), "OLD1-OLD2-OLD3");
    await userEvent.click(screen.getByRole("button", { name: "確認する" }));
    expect(callsTo(calls, "POST", "/api/auth/recovery/verify")[0]?.body).toEqual({
      code: "OLD1-OLD2-OLD3",
    });

    // 1回目の登録は失敗。回復コードの入力には戻らず、そのままやり直せる
    await userEvent.click(await screen.findByRole("button", { name: "新しいパスキーを登録" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("パスキーの確認に失敗しました");
    await userEvent.click(screen.getByRole("button", { name: "新しいパスキーを登録" }));

    expect(await screen.findByText("NEW1-NEW2-NEW3")).toBeInTheDocument();
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
    expect(callsTo(calls, "POST", "/api/auth/recovery/verify")).toHaveLength(1);
    await userEvent.click(screen.getByRole("checkbox", { name: /控えた/ }));
    await userEvent.click(screen.getByRole("button", { name: "続ける" }));
    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    expect(callsTo(calls, "POST", "/api/auth/recovery/acknowledge")).toHaveLength(1);
  });

  it("RECOVERY_INVALID と RECOVERY_LOCKED（retryAfter は秒。分で表示する）の文言", async () => {
    let attempt = 0;
    mockApi({
      "GET /api/auth/status": () => ok(signedOut),
      "POST /api/auth/recovery/verify": () =>
        attempt++ === 0
          ? apiError(400, "RECOVERY_INVALID", "回復コードが違います")
          : apiError(429, "RECOVERY_LOCKED", "しばらく試せません", { retryAfter: 840 }),
    });
    renderGate();

    await userEvent.click(await screen.findByRole("button", { name: "回復コードを使う" }));
    await userEvent.type(screen.getByLabelText("回復コード"), "WRONG");
    await userEvent.click(screen.getByRole("button", { name: "確認する" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("回復コードが違います");

    await userEvent.click(screen.getByRole("button", { name: "確認する" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("14分後"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("回復コードが違います");
  });
});

describe("AuthGate: 回復コードの作り直しの案内", () => {
  it("recoveryAcknowledged が false なら案内が出る。作り直して「控えた」を確認すると出なくなる", async () => {
    const state = authState({ recoveryAcknowledged: false });
    const calls = mockApi({
      "GET /api/auth/status": () => ok(state.get()),
      "POST /api/auth/recovery/regenerate": () => ok({ recoveryCode: "RE11-RE22-RE33" }, 201),
      "POST /api/auth/recovery/acknowledge": () => {
        state.set({ recoveryAcknowledged: true });
        return NO_CONTENT;
      },
      "GET /api/entities": () => ok({ entities: [] }),
    });
    renderGate();

    // 帳簿の画面の上に案内が出る
    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    const notice = screen.getByRole("region", { name: "回復コードの確認" });
    await userEvent.click(within(notice).getByRole("button", { name: "回復コードを作り直す" }));

    expect(await screen.findByText("RE11-RE22-RE33")).toBeInTheDocument();
    // 控えたと確認するまでは、帳簿の画面に戻らない
    expect(screen.queryByText("帳簿の画面")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /控えた/ }));
    await userEvent.click(screen.getByRole("button", { name: "続ける" }));

    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    expect(callsTo(calls, "POST", "/api/auth/recovery/acknowledge")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "回復コードの確認" })).not.toBeInTheDocument();
  });

  it("確認済みなら案内は出ない", async () => {
    mockApi({ "GET /api/entities": () => ok({ entities: [] }) });
    renderGate();
    expect(await screen.findByText("帳簿の画面")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "回復コードの確認" })).not.toBeInTheDocument();
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

  it("パスキーの追加", async () => {
    vi.mocked(startRegistration).mockResolvedValue({ id: "cred3" } as never);
    const calls = open({
      "POST /api/auth/passkeys/options": () => ok({ challenge: "p1" }),
      "POST /api/auth/passkeys/verify": () => ok({ passkey: passkeys[0] }, 201),
    });
    await screen.findByRole("table", { name: "パスキーの一覧" });
    await userEvent.type(screen.getByLabelText("追加するパスキーの名前"), "予備");
    await userEvent.click(screen.getByRole("button", { name: "パスキーを追加" }));

    await waitFor(() =>
      expect(callsTo(calls, "POST", "/api/auth/passkeys/verify")).toHaveLength(1),
    );
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "p1" } });
    expect(callsTo(calls, "POST", "/api/auth/passkeys/verify")[0]?.body).toEqual({
      response: { id: "cred3" },
      name: "予備",
    });
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
    expect(rows[0]).toHaveTextContent("サインイン");
    expect(rows[0]).not.toHaveTextContent("失敗");
    expect(rows[1]).toHaveTextContent("サインインの失敗");
    expect(rows[2]).toHaveTextContent("登録");
    expect(rows[0]).toHaveTextContent("Mac Safari");
    expect(rows[0]).toHaveTextContent("localhost");
  });

  it("回復コードの再発行は、新しいコードを表示し、控えたと確認する", async () => {
    const calls = open({
      "POST /api/auth/recovery/regenerate": () => ok({ recoveryCode: "RG11-RG22-RG33" }, 201),
      "POST /api/auth/recovery/acknowledge": () => NO_CONTENT,
    });
    await userEvent.click(await screen.findByRole("button", { name: "回復コードを作り直す" }));
    expect(await screen.findByText("RG11-RG22-RG33")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "続ける" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /控えた/ }));
    await userEvent.click(screen.getByRole("button", { name: "続ける" }));

    await waitFor(() => expect(screen.queryByText("RG11-RG22-RG33")).not.toBeInTheDocument());
    expect(callsTo(calls, "POST", "/api/auth/recovery/acknowledge")).toHaveLength(1);
  });

  it("サインアウトで sign-out を呼ぶ", async () => {
    const calls = open({ "POST /api/auth/sign-out": () => NO_CONTENT });
    await userEvent.click(await screen.findByRole("button", { name: "サインアウト" }));
    await waitFor(() => expect(callsTo(calls, "POST", "/api/auth/sign-out")).toHaveLength(1));
  });
});
