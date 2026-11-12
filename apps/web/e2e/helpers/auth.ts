import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { WEB_ORIGIN } from "../env.ts";
import { VirtualAuthenticator } from "./virtual-authenticator.ts";

/**
 * 帳簿の解錠まわりの画面操作（008 D11）。
 * ロケーターはロールで探し、`exact: true` で、認証の画面の `main` の中に絞る。
 *
 * E2E の実行は1つのデータ場所（1つの server）を共有する。設定は最初の1回しかできないので、
 * 最初に動いたテストが設定し、回復キーを `e2e-vault-state.json` に残す。後のテストは、
 * 空の仮想の認証器を付けて、引き継いだ回復キーで解錠し、新しいパスキーを登録してから始める
 * （パスキーを書き出して戻すやり方は使えない。戻したパスキーは PRF を持たない）。
 * 回復キーは登録のたびに入れ替わるので、そのつど引き継ぎ直す
 */

/** CSRF の検査（Origin が必要）を通すため、`page.request` の書き込みの要求に付ける */
export const ORIGIN_HEADERS = { Origin: WEB_ORIGIN };

const shell = (page: Page): Locator => page.getByRole("main");
const lockedHeading = (page: Page) =>
  shell(page).getByRole("heading", { name: "帳簿は施錠されています", exact: true, level: 2 });
const setupHeading = (page: Page) =>
  shell(page).getByRole("heading", { name: "初回の設定", exact: true, level: 2 });
/** 解錠後の画面にだけある（設定へのリンク） */
export const settingsLink = (page: Page) => page.getByRole("link", { name: "設定", exact: true });

type VaultState = { recoveryKey: string };

function statePath(): string {
  const dir = process.env.TREBUCHET_E2E_DATA_DIR;
  if (!dir) {
    throw new Error("TREBUCHET_E2E_DATA_DIR が未設定です（playwright.config.ts が設定する）");
  }
  return join(dir, "e2e-vault-state.json");
}

export async function readVaultState(): Promise<VaultState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as VaultState;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export async function writeVaultState(state: VaultState): Promise<void> {
  await mkdir(join(statePath(), ".."), { recursive: true });
  await writeFile(statePath(), JSON.stringify(state), "utf8");
}

/** 回復キーの保管の画面から、キーを読み、「保管した」にチェックして「続ける」を押す。読んだキーを返す */
async function acknowledgeRecoveryKey(page: Page): Promise<string> {
  const panel = shell(page).getByRole("region", { name: "回復キーの保管", exact: true });
  await expect(panel).toBeVisible();
  const recoveryKey = await panel
    .getByRole("textbox", { name: "回復キー", exact: true })
    .inputValue();
  expect(recoveryKey).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);

  const proceed = panel.getByRole("button", { name: "続ける", exact: true });
  await expect(proceed).toBeDisabled();
  await panel
    .getByRole("checkbox", { name: "回復キーを安全な場所に保管しました", exact: true })
    .check();
  await proceed.click();
  await expect(panel).toBeHidden();
  return recoveryKey;
}

/**
 * 初回の設定の画面で、パスキーを作り、回復キーを保管して帳簿の画面まで進む。保管した回復キーを返す。
 * vite の proxy が Host を書き換えると、設定が 421 HOST_NOT_ALLOWED になる（004 R6）。
 * 応答の状態を確かめて、その再発を捕まえる
 */
async function completeSetup(page: Page): Promise<string> {
  await expect(setupHeading(page)).toBeVisible();
  const verified = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/register/verify") &&
      r.request().method() === "POST" &&
      r.status() !== 200, // 200 は PRF の出力を得るための追加の認証（prf_required）
  );
  await shell(page).getByRole("button", { name: "パスキーを作成", exact: true }).click();
  expect(
    (await verified).status(),
    "設定の verify が 201 で通る（421 なら proxy が Host を書き換えている）",
  ).toBe(201);
  const recoveryKey = await acknowledgeRecoveryKey(page);
  await expect(settingsLink(page)).toBeVisible();
  return recoveryKey;
}

/** パスキーで解錠する。画面は解錠の画面にいること */
export async function unlockWithPasskey(page: Page): Promise<void> {
  await expect(lockedHeading(page)).toBeVisible();
  await shell(page).getByRole("button", { name: "パスキーで解錠", exact: true }).click();
  await expect(settingsLink(page)).toBeVisible();
}

/** 回復キーを入れて確認する。成功・失敗の判定は呼び出し側で行う（画面は解錠の画面にいること） */
export async function submitRecoveryKey(page: Page, recoveryKey: string): Promise<void> {
  await expect(lockedHeading(page)).toBeVisible();
  const box = shell(page).getByRole("textbox", { name: "回復キー", exact: true });
  if (!(await box.isVisible())) {
    await shell(page).getByRole("button", { name: "回復キーで解錠", exact: true }).click();
  }
  await box.fill(recoveryKey);
  await shell(page).getByRole("button", { name: "回復キーを確認", exact: true }).click();
}

/**
 * 回復キーで解錠し、新しいパスキーを登録して、帳簿の画面まで進む。新しい回復キーを返す。
 * 既存のパスキーは登録の除外に入るので、空の認証器に取り替えてから登録する（実際の別の端末の再現）。
 * `whileRecovering` は、回復の一時のセッションの間（「新しいパスキーを登録」が出てから、登録する前）に呼ぶ確認
 */
export async function recoverWithKey(
  page: Page,
  authenticator: VirtualAuthenticator,
  recoveryKey: string,
  whileRecovering?: () => Promise<void>,
): Promise<string> {
  await submitRecoveryKey(page, recoveryKey);
  const register = shell(page).getByRole("button", { name: "新しいパスキーを登録", exact: true });
  await expect(register).toBeVisible();
  await whileRecovering?.();
  await authenticator.replace();
  await register.click();
  const next = await acknowledgeRecoveryKey(page);
  expect(next, "登録で回復キーが入れ替わる").not.toBe(recoveryKey);
  await expect(settingsLink(page)).toBeVisible();
  return next;
}

/** 設定のセキュリティの「施錠してサインアウト」を押し、確認のダイアログで確定して、解錠の画面に戻る */
export async function lockVault(page: Page): Promise<void> {
  const name = "施錠してサインアウト";
  await page.goto("/settings/security");
  await expect(page.getByRole("heading", { name: "セキュリティ", exact: true })).toBeVisible();
  await shell(page).getByRole("button", { name, exact: true }).click();
  await page
    .getByRole("dialog", { name, exact: true })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(lockedHeading(page)).toBeVisible();
}

/**
 * 各テストの先頭で呼ぶ。空の仮想の認証器（PRF つき）を付け、未設定なら設定し、施錠中なら
 * 引き継いだ回復キーで解錠して新しいパスキーを登録する。新しい回復キーは引き継ぎ直す。
 * 認証を外す設定は作らず、本物の経路を仮想の認証器で通す（R15）。
 * 戻り値の `setupNow` は、このテストが初回の設定をしたかどうか
 */
export async function enterVault(
  page: Page,
): Promise<{ authenticator: VirtualAuthenticator; setupNow: boolean }> {
  const authenticator = await VirtualAuthenticator.attach(page);
  const status = (await (await page.request.get("/api/auth/status")).json()) as {
    registered: boolean;
    signedIn: boolean;
  };
  await page.goto("/");

  if (!status.registered) {
    await writeVaultState({ recoveryKey: await completeSetup(page) });
    return { authenticator, setupNow: true };
  }
  if (!status.signedIn) {
    const state = await readVaultState();
    if (!state) {
      throw new Error(
        "設定済みなのに、引き継いだ回復キーがない（E2E のデータ場所を再利用していないか）",
      );
    }
    await writeVaultState({
      recoveryKey: await recoverWithKey(page, authenticator, state.recoveryKey),
    });
  }
  return { authenticator, setupNow: false };
}
