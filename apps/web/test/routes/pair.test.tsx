import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/pair";
import { routeTree } from "@/routeTree.gen";
import { type ApiCall, apiError, DEFAULT_AUTH_STATUS, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

// 004 US4（T018）: スマホ（ts.net の名前）でのペアリングの登録。サインインなしで開く

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(startRegistration).mockReset();
  vi.mocked(startAuthentication).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const callsTo = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);
const REGISTER = "このスマホのパスキーを登録";
const INVALID = "ペアリングの URL が無効か期限切れです。Mac でもう一度発行してください";

function open(url: string, extra: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi(extra);
  const view = renderRoute(Route, { path: "/pair", url });
  return { calls, ...view };
}

describe("/pair", () => {
  it("token つきで options を呼び、PRF の出力が返らなければ認証をもう一度行って、同じ token で verify する", async () => {
    vi.mocked(startRegistration).mockResolvedValue({ id: "cred1" } as never);
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred1" } as never);
    let verifyCount = 0;
    const { calls, router } = open("/pair?token=tok123", {
      "POST /api/auth/pairing/register/options": () => ok({ challenge: "c1" }),
      "POST /api/auth/pairing/register/verify": () => {
        verifyCount += 1;
        return verifyCount === 1
          ? ok({ status: "prf_required", options: { challenge: "p2" } })
          : ok({ passkey: { id: "cred1", name: "パスキー" } }, 201);
      },
    });
    await userEvent.click(await screen.findByRole("button", { name: REGISTER }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(callsTo(calls, "POST", "/api/auth/pairing/register/options")[0]?.body).toEqual({
      token: "tok123",
    });
    expect(callsTo(calls, "POST", "/api/auth/pairing/register/verify").map((c) => c.body)).toEqual([
      { token: "tok123", response: { id: "cred1" } },
      { token: "tok123", response: { id: "cred1" } },
    ]);
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "c1" } });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "p2" } });
  });

  it("token がなければ、API を呼ばず無効の文言を出す", async () => {
    const { calls } = open("/pair");
    expect(await screen.findByText(INVALID)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: REGISTER })).not.toBeInTheDocument();
    expect(callsTo(calls, "POST", "/api/auth/pairing/register/options")).toHaveLength(0);
  });

  it("PAIRING_TOKEN_INVALID は無効か期限切れの文言", async () => {
    open("/pair?token=old", {
      "POST /api/auth/pairing/register/options": () =>
        apiError(401, "PAIRING_TOKEN_INVALID", "無効です"),
    });
    await userEvent.click(await screen.findByRole("button", { name: REGISTER }));
    expect(await screen.findByRole("alert")).toHaveTextContent(INVALID);
  });

  it("LOCKED は Mac で解錠する案内", async () => {
    open("/pair?token=tok123", {
      "POST /api/auth/pairing/register/options": () => apiError(401, "LOCKED", "施錠中です"),
    });
    await userEvent.click(await screen.findByRole("button", { name: REGISTER }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Mac でアプリを解錠してください");
  });

  it("PRF_UNSUPPORTED は、この端末が未対応の旨（トークンは残るので押し直せる）", async () => {
    vi.mocked(startRegistration).mockResolvedValue({ id: "cred1" } as never);
    open("/pair?token=tok123", {
      "POST /api/auth/pairing/register/options": () => ok({ challenge: "c1" }),
      "POST /api/auth/pairing/register/verify": () =>
        apiError(400, "PRF_UNSUPPORTED", "PRF に対応していません"),
    });
    await userEvent.click(await screen.findByRole("button", { name: REGISTER }));
    expect(await screen.findByRole("alert")).toHaveTextContent("この端末");
    expect(screen.getByRole("alert")).toHaveTextContent("PRF");
    expect(screen.getByRole("button", { name: REGISTER })).toBeEnabled();
  });

  it("サインインしていなくても（施錠中でも）サインインの画面にならず、/pair が開く", async () => {
    mockApi({
      "GET /api/auth/status": () =>
        ok({ ...DEFAULT_AUTH_STATUS, signedIn: false, recoveryAcknowledged: null }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const router = createRouter({
      routeTree,
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: ["/pair?token=tok123"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("button", { name: REGISTER })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "パスキーで解錠" })).not.toBeInTheDocument();
  });
});
