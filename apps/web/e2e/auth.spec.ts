import { expect, type Page, test } from "@playwright/test";
import {
  acknowledgeRecoveryCode,
  attachAuthenticator,
  readAuthState,
  registerFirstPasskey,
  signInWithPasskey,
  writeAuthState,
} from "./helpers/auth.ts";

const signInHeading = (page: Page) =>
  page.getByRole("heading", { name: "サインイン", exact: true });

async function signOut(page: Page) {
  await page.goto("/settings/security");
  await expect(page.getByRole("heading", { name: "セキュリティ" })).toBeVisible();
  await page.getByRole("button", { name: "サインアウト" }).click();
  await expect(signInHeading(page)).toBeVisible();
}

// E2E の実行は1つのデータ場所を共有し、他のファイルも同じ認証の状態を使う。
// 初回の登録は、このファイルが最初に動いたときだけここで通る（順序に依存しない作り）。
// 最後は、新しいパスキーと回復コードを状態に残すので、後のテストはそれでサインインできる
test("パスキーの登録から、サインアウト・サインイン、回復コードでの再登録まで（FR-001〜008）", async ({
  page,
  request,
}) => {
  await test.step("サインインしていない要求は 401 で拒否され、公開の手続きだけが通る（FR-003）", async () => {
    // request は cookie を持たない新しい文脈。画面と同じ入口（vite の proxy）を通す
    const health = await request.get("/api/health");
    expect(health.status()).toBe(200);
    const list = await request.get("/api/entities");
    expect(list.status()).toBe(401);
    expect(await list.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    const status = await request.get("/api/auth/status");
    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({ signedIn: false, rpId: "localhost" });
  });

  const authenticator = await attachAuthenticator(page);
  const registered = (
    (await (await page.request.get("/api/auth/status")).json()) as {
      registered: boolean;
    }
  ).registered;
  let recoveryCode: string;

  await page.goto("/");
  if (registered) {
    test.info().annotations.push({
      type: "note",
      description: "他のテストが先に登録したので、初回の登録の手順は確かめていない",
    });
    const state = await readAuthState();
    if (!state) throw new Error("登録済みなのに、保存したパスキーがない");
    recoveryCode = state.recoveryCode;
    await test.step("パスキーでサインインする", async () => {
      await expect(signInHeading(page)).toBeVisible();
      await signInWithPasskey(page, authenticator);
    });
  } else {
    await test.step("最初のパスキーを登録し、回復コードを控えて続ける（FR-001・002）", async () => {
      // 登録の画面（ここでは帳簿の画面に入れない）
      await expect(page.getByRole("heading", { name: "パスキーの登録" })).toBeVisible();
      await expect(page.getByRole("link", { name: "設定", exact: true })).toBeHidden();
      recoveryCode = await registerFirstPasskey(page, authenticator);
      await expect(page.getByRole("link", { name: "設定", exact: true })).toBeVisible();
    });
  }

  await test.step("設定の画面にパスキーが1件以上並ぶ（FR-005）", async () => {
    await page.goto("/settings/security");
    const list = page.getByRole("table", { name: "パスキーの一覧" });
    await expect(list.getByRole("cell", { name: "localhost", exact: true }).first()).toBeVisible();
  });

  await test.step("サインアウトすると、サインインの画面に戻り、API は 401（FR-004）", async () => {
    await signOut(page);
    expect((await page.request.get("/api/entities")).status()).toBe(401);
  });

  await test.step("認証器のパスキーでサインインし直す（FR-003）", async () => {
    await signInWithPasskey(page, authenticator);
    expect((await page.request.get("/api/entities")).status()).toBe(200);
  });

  await test.step("認証の記録に、サインインの出来事が残る（FR-008）", async () => {
    await page.goto("/settings/security");
    await expect(page.getByRole("heading", { name: "セキュリティ" })).toBeVisible();
    await expect
      .poll(async () => {
        const res = await page.request.get("/api/auth/events");
        const body = (await res.json()) as { events: { kind: string }[] };
        return body.events.some((e) => e.kind === "sign_in");
      })
      .toBe(true);
  });

  let newCode = "";
  await test.step("回復コードでサインインし、新しいパスキーを登録する（FR-006）", async () => {
    await signOut(page);
    await page.getByRole("button", { name: "回復コードを使う" }).click();
    await page.getByLabel("回復コード", { exact: true }).fill(recoveryCode);
    await page.getByRole("button", { name: "確認する" }).click();
    await expect(page.getByText("回復コードを確認しました。")).toBeVisible();
    // 一時セッションでは、帳簿の API はまだ使えない
    expect((await page.request.get("/api/entities")).status()).toBe(401);

    // 既存のパスキーは登録の除外に入るので、パスキーを持たない別の認証器に取り替える
    await authenticator.replace();
    await page.getByRole("button", { name: "新しいパスキーを登録" }).click();
    newCode = await acknowledgeRecoveryCode(page);
    expect(newCode).not.toBe(recoveryCode);
    await expect(page.getByRole("link", { name: "設定", exact: true })).toBeVisible();
    expect((await page.request.get("/api/entities")).status()).toBe(200);
    // 後のテストが、新しいパスキーと新しい回復コードを使えるようにする
    await writeAuthState({ credentials: await authenticator.credentials(), recoveryCode: newCode });
  });

  await test.step("古い回復コードは使えない（FR-006）", async () => {
    await signOut(page);
    await page.getByRole("button", { name: "回復コードを使う" }).click();
    await page.getByLabel("回復コード", { exact: true }).fill(recoveryCode);
    await page.getByRole("button", { name: "確認する" }).click();
    await expect(page.getByRole("alert")).toContainText("回復コードが違います");
    await page.getByRole("button", { name: "サインインに戻る" }).click();
  });

  await test.step("新しいパスキーでサインインできる", async () => {
    await signInWithPasskey(page, authenticator);
  });
});
