import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { type StoredCredential, VirtualAuthenticator } from "./virtual-authenticator.ts";

/**
 * テストをまたいで引き継ぐ認証の状態。E2E の実行は1つのデータ場所（1つのサーバー）を共有するので、
 * 最初に登録したテストが、パスキーと回復コードをここに残し、後のテストがサインインに使う。
 * どのテストが最初に動いても、どの順に動いても成り立つ
 */
export type AuthState = { credentials: StoredCredential[]; recoveryCode: string };

/** CSRF の検査（Origin が必要）を通すため、`page.request` の書き込みの要求に付ける */
export const ORIGIN_HEADERS = { Origin: "http://localhost:5173" };

function statePath(): string {
  const dir = process.env.TREBUCHET_E2E_DATA_DIR;
  if (!dir)
    throw new Error("TREBUCHET_E2E_DATA_DIR が未設定です（playwright.config.ts が設定する）");
  return join(dir, "e2e-auth-state.json");
}

export async function readAuthState(): Promise<AuthState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as AuthState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export async function writeAuthState(state: AuthState): Promise<void> {
  await mkdir(join(statePath(), ".."), { recursive: true });
  await writeFile(statePath(), JSON.stringify(state), "utf8");
}

type AuthStatus = { registered: boolean; signedIn: boolean };

/** 画面に出た回復コードを読み、「控えた」にチェックして「続ける」を押す。読んだコードを返す */
export async function acknowledgeRecoveryCode(page: Page): Promise<string> {
  const codeBox = page.getByTestId("recovery-code");
  await expect(codeBox).toBeVisible();
  const code = ((await codeBox.textContent()) ?? "").trim();
  expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{1,4})+$/);

  const next = page.getByRole("button", { name: "続ける" });
  await expect(next).toBeDisabled();
  await page.getByLabel("回復コードを控えた").check();
  await next.click();
  await expect(codeBox).toBeHidden();
  return code;
}

/** 認証器を付け、保存してあるパスキーがあれば戻す。ページを開く前に呼ぶ */
export async function attachAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const authenticator = await VirtualAuthenticator.attach(page);
  const state = await readAuthState();
  if (state) await authenticator.addCredentials(state.credentials);
  return authenticator;
}

/**
 * 最初の登録（回復コードを控えて「続ける」）をする。画面は未登録の状態（登録の画面）にいること。
 * vite の proxy が Host を書き換えると、登録が 421 HOST_NOT_ALLOWED になる（004 R6）。
 * 応答の状態と RP ID を確かめて、その再発を捕まえる
 */
export async function registerFirstPasskey(
  page: Page,
  authenticator: VirtualAuthenticator,
): Promise<string> {
  await expect(page.getByRole("heading", { name: "パスキーの登録" })).toBeVisible();
  const verified = page.waitForResponse(
    (r) => r.url().endsWith("/api/auth/register/verify") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "パスキーを登録" }).click();
  const response = await verified;
  expect(
    response.status(),
    "登録の verify が 201 で通る（421 なら proxy が Host を書き換えている）",
  ).toBe(201);

  const recoveryCode = await acknowledgeRecoveryCode(page);
  await writeAuthState({ credentials: await authenticator.credentials(), recoveryCode });
  return recoveryCode;
}

/** パスキーでサインインする。画面はサインインの画面にいること。署名回数が進むので、状態を保存し直す */
export async function signInWithPasskey(
  page: Page,
  authenticator: VirtualAuthenticator,
): Promise<void> {
  await page.getByRole("button", { name: "パスキーでサインイン" }).click();
  await expect(page.getByRole("link", { name: "設定", exact: true })).toBeVisible();
  const state = await readAuthState();
  if (state) await writeAuthState({ ...state, credentials: await authenticator.credentials() });
}

/**
 * 「最初に登録、登録済みならサインイン」の共通の手順。各テストの先頭で呼ぶ。
 * 認証を外す設定は作らず、本物の経路を仮想の認証器で通す（R15）。
 * 戻り値の `registeredNow` は、このテストが初回の登録をしたかどうか
 */
export async function ensureSignedIn(
  page: Page,
): Promise<{ authenticator: VirtualAuthenticator; registeredNow: boolean }> {
  const authenticator = await attachAuthenticator(page);
  const status = (await (await page.request.get("/api/auth/status")).json()) as AuthStatus;
  await page.goto("/");

  if (!status.registered) {
    await registerFirstPasskey(page, authenticator);
    await expect(page.getByRole("link", { name: "設定", exact: true })).toBeVisible();
    return { authenticator, registeredNow: true };
  }
  if (!status.signedIn) {
    if (!(await readAuthState())) {
      throw new Error(
        "登録済みなのに、保存したパスキーがない（E2E のデータ場所を再利用していないか）",
      );
    }
    await signInWithPasskey(page, authenticator);
  }
  return { authenticator, registeredNow: false };
}
