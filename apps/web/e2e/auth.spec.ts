import { expect, test } from "@playwright/test";
import {
  enterVault,
  lockVault,
  readVaultState,
  recoverWithKey,
  settingsLink,
  submitRecoveryKey,
  unlockWithPasskey,
  writeVaultState,
} from "./helpers/auth.ts";
import { createEntityViaApi } from "./helpers/entity.ts";

// E2E の実行は1つのデータ場所を共有し、他のファイルも同じ帳簿を使う。
// 初回の設定は、このファイルが最初に動いたときだけここで通る（順序に依存しない作り）。
// 最後は、新しい回復キーを引き継ぎ（`e2e-vault-state.json`）、後のテストはそれで解錠して始める
test("初回の設定から、施錠・パスキーでの解錠・回復キーでの解錠・古い回復キーの失効まで（008）", async ({
  page,
  request,
}) => {
  await test.step("解錠していない要求は 401 で拒否され、公開の手続きだけが通る", async () => {
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

  let authenticator: Awaited<ReturnType<typeof enterVault>>["authenticator"];
  await test.step("初回ならパスキーを作って回復キーを保管する。設定済みなら引き継いだ回復キーで解錠する", async () => {
    const entered = await enterVault(page);
    authenticator = entered.authenticator;
    if (!entered.setupNow) {
      test.info().annotations.push({
        type: "note",
        description: "他のテストが先に設定したので、初回の設定の手順は確かめていない",
      });
    }
    expect(await authenticator.credentialCount()).toBe(1);
  });

  await test.step("設定の画面にパスキーが1件以上並ぶ", async () => {
    await page.goto("/settings/security");
    const list = page.getByRole("table", { name: "パスキーの一覧", exact: true });
    await expect(list.getByRole("cell", { name: "localhost", exact: true }).first()).toBeVisible();
  });

  const entityName = `解錠の確認 ${Date.now()}`;
  const entityNames = async () =>
    (
      (await (await page.request.get("/api/entities")).json()) as { entities: { name: string }[] }
    ).entities.map((e) => e.name);

  await test.step("帳簿を操作する（事業体を作る）", async () => {
    await createEntityViaApi(page, { name: entityName, firstFiscalYear: 2026 });
    expect(await entityNames()).toContain(entityName);
  });

  await test.step("施錠すると、解錠の画面に戻り、帳簿の API は 401", async () => {
    await lockVault(page);
    expect((await page.request.get("/api/entities")).status()).toBe(401);
  });

  await test.step("パスキーで解錠すると、施錠の前の帳簿が読める", async () => {
    await unlockWithPasskey(page);
    expect(await entityNames()).toContain(entityName);
  });

  const state = await readVaultState();
  if (!state) throw new Error("引き継いだ回復キーがない");
  const oldKey = state.recoveryKey;
  let newKey = "";

  await test.step("施錠し、回復キーで解錠する。新しいパスキーを登録するまで帳簿は読めない", async () => {
    await lockVault(page);
    // 既存のパスキーは登録の除外に入るので、recoverWithKey がパスキーを持たない別の認証器に取り替えて登録する
    newKey = await recoverWithKey(page, authenticator, oldKey, async () => {
      // 回復用の一時セッションでは、帳簿の API はまだ使えない
      expect((await page.request.get("/api/entities")).status()).toBe(401);
    });
    // 後のテストが、新しい回復キーで始められるようにする
    await writeVaultState({ recoveryKey: newKey });
    await expect(settingsLink(page)).toBeVisible();
    // 回復キーで開けても、データの鍵は同じ（施錠の前の帳簿が読める）
    expect(await entityNames()).toContain(entityName);
  });

  await test.step("古い回復キーは使えない", async () => {
    await lockVault(page);
    await submitRecoveryKey(page, oldKey);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("回復キーが違います");
    await page
      .getByRole("main")
      .getByRole("button", { name: "パスキーでの解錠に戻る", exact: true })
      .click();
  });

  await test.step("新しいパスキーで解錠できる", async () => {
    await unlockWithPasskey(page);
    expect(await entityNames()).toContain(entityName);
  });
});
