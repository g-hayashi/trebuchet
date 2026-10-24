import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { BackupStatus } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { BACKUP_PASSPHRASE_KEY } from "../src/lib/keychain.ts";
import { type BackupEnv, HOUR, makeBackupEnv } from "./backup-helpers.ts";
import {
  createTestEntity,
  createTestSession,
  errorOf,
  TEST_HOST,
  TEST_ORIGIN,
  testHeaders,
} from "./helpers.ts";

// T012: バックアップの HTTP（contracts/http-api.md「バックアップ」。inspect は除く）

let tmp: TempDataDir;
let env: BackupEnv;
let app: ReturnType<typeof createApp>;
let cookie: string;
beforeEach(async () => {
  tmp = useTempDataDir("server");
  await createTestEntity("事業 A");
  env = makeBackupEnv(tmp, { passphrase: null });
  app = createApp({
    clock: env.clock.clock,
    backup: { runner: env.runner, secrets: env.secrets, store: env.backups },
  });
  cookie = (await createTestSession({ now: env.clock.clock.now() })).cookie;
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
});

const GOOD = "correct horse battery staple";

/** 時計を進める。セッションの無操作の期限で 401 にならないよう、進めた時刻のセッションに替える */
async function advance(ms: number) {
  env.clock.advance(ms);
  cookie = (await createTestSession({ now: env.clock.clock.now() })).cookie;
}

async function call(method: string, path: string, body?: unknown) {
  const headers = {
    Host: TEST_HOST,
    Origin: TEST_ORIGIN,
    Cookie: cookie,
    "Content-Type": "application/json",
  };
  return app.request(`/api/backup${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const settings = (over: Record<string, unknown> = {}) => ({
  folder: env.folder,
  passphrase: GOOD,
  passphraseConfirm: GOOD,
  acknowledged: true,
  ...over,
});

/** 実行中の最初のバックアップが終わるのを待つ */
async function idle() {
  await vi.waitFor(() => expect(env.runner.isRunning()).toBe(false));
}

const status = async (): Promise<BackupStatus> =>
  (await (await call("GET", "/status")).json()) as BackupStatus;

async function configured() {
  const res = await call("PUT", "/settings", settings());
  expect(res.status).toBe(200);
  await idle();
  env.clock.advance(1000);
}

describe("GET /backup/status", () => {
  it("未設定", async () => {
    const res = await call("GET", "/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      folder: null,
      lastSuccess: null,
      lastCheck: null,
      lastRun: null,
      alert: null,
      running: false,
    });
  });

  it("設定の直後に最初のバックアップが manual で始まり、終わると lastSuccess・lastCheck・lastRun が入る", async () => {
    const res = await call("PUT", "/settings", settings());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { runId: string | null }).runId).toEqual(expect.any(String));
    await idle();
    const s = await status();
    expect(s.configured).toBe(true);
    expect(s.folder).toBe(env.folder);
    expect(s.lastRun?.trigger).toBe("manual");
    expect(s.lastRun?.status).toBe("succeeded");
    expect(s.lastSuccess).toBe(s.lastRun?.finishedAt);
    expect(s.lastCheck).toBe(s.lastRun?.finishedAt);
    expect(s.alert).toBeNull();
    expect(readdirSync(env.folder)).toHaveLength(1);
  });

  it("最後の確認から 48 時間たつと STALE", async () => {
    await configured();
    await advance(48 * HOUR);
    expect((await status()).alert).toEqual({ reason: "STALE" });
  });

  it("直近の実行が失敗なら LAST_RUN_FAILED", async () => {
    await configured();
    rmSync(env.folder, { recursive: true });
    const run = await call("POST", "/run");
    expect(run.status).toBe(202);
    await idle();
    const s = await status();
    expect(s.lastRun?.status).toBe("failed");
    expect(s.lastRun?.errorCode).toBe("FOLDER_NOT_FOUND");
    expect(s.alert).toEqual({ reason: "LAST_RUN_FAILED" });
  });

  it("パスフレーズが使えなければ PASSPHRASE_NEEDED（STALE・失敗より優先）", async () => {
    await configured();
    await env.secrets.delete(BACKUP_PASSPHRASE_KEY);
    await advance(72 * HOUR);
    expect((await status()).alert).toEqual({ reason: "PASSPHRASE_NEEDED" });
  });

  it("running は実行中だけ true", async () => {
    await configured();
    const started = await call("POST", "/run");
    expect(started.status).toBe(202);
    expect((await status()).running).toBe(true);
    await idle();
    expect((await status()).running).toBe(false);
  });
});

describe("PUT /backup/settings", () => {
  it("設定の 11 文字は 422 PASSPHRASE_TOO_SHORT（スキーマの 400 より先）", async () => {
    const short = "a".repeat(11);
    const res = await call(
      "PUT",
      "/settings",
      settings({ passphrase: short, passphraseConfirm: short }),
    );
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("PASSPHRASE_TOO_SHORT");
    // 他の入力が不正でも、長さを先に見る
    const res2 = await call("PUT", "/settings", { folder: env.folder, passphrase: short });
    expect(res2.status).toBe(422);
    expect((await errorOf(res2)).code).toBe("PASSPHRASE_TOO_SHORT");
  });

  it("12 文字ちょうどは受け付ける", async () => {
    const twelve = "a".repeat(12);
    const res = await call(
      "PUT",
      "/settings",
      settings({ passphrase: twelve, passphraseConfirm: twelve }),
    );
    expect(res.status).toBe(200);
    await idle();
  });

  it("確認用と違えば 422 PASSPHRASE_MISMATCH", async () => {
    const res = await call("PUT", "/settings", settings({ passphraseConfirm: `${GOOD}x` }));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("PASSPHRASE_MISMATCH");
  });

  it("acknowledged が false なら 400（スキーマ）", async () => {
    const res = await call("PUT", "/settings", settings({ acknowledged: false }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("存在しないフォルダ・ファイル・相対パスは 422 BACKUP_FOLDER_NOT_FOUND。何も保存しない", async () => {
    const file = join(tmp.dir, "a-file");
    writeFileSync(file, "x");
    for (const folder of [join(tmp.dir, "nothing"), file, "relative/dir"]) {
      const res = await call("PUT", "/settings", settings({ folder }));
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("BACKUP_FOLDER_NOT_FOUND");
    }
    expect(await env.secrets.get(BACKUP_PASSPHRASE_KEY)).toBeUndefined();
    expect((await status()).configured).toBe(false);
  });

  it("成功したらパスフレーズをキーチェーン（SecretStore）に保存し、設定の印と force_write を立てる", async () => {
    const res = await call("PUT", "/settings", settings());
    expect(res.status).toBe(200);
    expect(await env.secrets.get(BACKUP_PASSPHRASE_KEY)).toBe(GOOD);
    expect(await env.auth().getSetting("backup_passphrase_set")).toBe("1");
    await idle();
    // 最初の書き込みの成功で force_write は消える
    expect(await env.auth().getSetting("backup_force_write")).toBe("0");
  });
});

describe("PUT /backup/passphrase", () => {
  const NEW = "another long passphrase 2";
  const change = (over: Record<string, unknown> = {}) => ({
    current: GOOD,
    passphrase: NEW,
    passphraseConfirm: NEW,
    ...over,
  });

  it("12 文字未満は 422 PASSPHRASE_TOO_SHORT、不一致は 422 PASSPHRASE_MISMATCH", async () => {
    await configured();
    const short = await call(
      "PUT",
      "/passphrase",
      change({ passphrase: "short", passphraseConfirm: "short" }),
    );
    expect(short.status).toBe(422);
    expect((await errorOf(short)).code).toBe("PASSPHRASE_TOO_SHORT");
    const mismatch = await call("PUT", "/passphrase", change({ passphraseConfirm: `${NEW}x` }));
    expect(mismatch.status).toBe(422);
    expect((await errorOf(mismatch)).code).toBe("PASSPHRASE_MISMATCH");
  });

  it("current が違う・省略なら 422 PASSPHRASE_WRONG（値は変わらない）", async () => {
    await configured();
    for (const body of [
      change({ current: "wrong-current-passphrase" }),
      change({ current: undefined }),
    ]) {
      const res = await call("PUT", "/passphrase", body);
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("PASSPHRASE_WRONG");
    }
    expect(await env.secrets.get(BACKUP_PASSPHRASE_KEY)).toBe(GOOD);
  });

  it("current が合えば変更でき、force_write を立てて manual で書き直す（内容が同じでも）", async () => {
    await configured();
    const before = await status();
    const res = await call("PUT", "/passphrase", change());
    expect(res.status).toBe(200);
    expect(await env.secrets.get(BACKUP_PASSPHRASE_KEY)).toBe(NEW);
    await idle();
    const s = await status();
    expect(s.lastRun?.trigger).toBe("manual");
    expect(s.lastRun?.status).toBe("succeeded");
    expect(s.lastRun?.fileName).not.toBe(before.lastRun?.fileName);
    expect(await env.auth().getSetting("backup_force_write")).toBe("0");

    // 変えた直後の force_write は、自動の skip も止める（立っている間は書く）
    await env.auth().setSetting("backup_force_write", "1", env.clock.clock.now());
    env.clock.advance(1000);
    const auto = await env.runner.start("auto");
    if (!auto.ok) throw new Error("start failed");
    expect((await auto.value.done).status).toBe("succeeded");
  });

  it("SecretStore が空なら current なしで変更できる。値があれば current なしは PASSPHRASE_WRONG", async () => {
    await configured();
    await env.secrets.delete(BACKUP_PASSPHRASE_KEY);
    const res = await call("PUT", "/passphrase", change({ current: undefined }));
    expect(res.status).toBe(200);
    expect(await env.secrets.get(BACKUP_PASSPHRASE_KEY)).toBe(NEW);
    await idle();
    const again = await call("PUT", "/passphrase", change({ current: undefined }));
    expect(again.status).toBe(422);
    expect((await errorOf(again)).code).toBe("PASSPHRASE_WRONG");
  });

  it("置き場所が未設定なら 409 BACKUP_NOT_CONFIGURED", async () => {
    const res = await call("PUT", "/passphrase", change({ current: undefined }));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("BACKUP_NOT_CONFIGURED");
  });
});

describe("POST /backup/run", () => {
  it("未設定は 409 BACKUP_NOT_CONFIGURED", async () => {
    const res = await call("POST", "/run");
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("BACKUP_NOT_CONFIGURED");
  });

  it("202 で runId をすぐ返し、実行中の再要求は 409 BACKUP_RUNNING", async () => {
    await configured();
    const first = await call("POST", "/run");
    expect(first.status).toBe(202);
    const { runId } = (await first.json()) as { runId: string };
    const second = await call("POST", "/run");
    expect(second.status).toBe(409);
    expect((await errorOf(second)).code).toBe("BACKUP_RUNNING");
    await idle();
    expect((await env.backups().getLastRun())?.id).toBe(runId);
  });

  it("実行中も帳簿の API が使える", async () => {
    await configured();
    await call("POST", "/run");
    const res = await app.request("/api/entities", { headers: await testHeaders() });
    expect(res.status).toBe(200);
    await idle();
  });

  it("内容が同じでも必ずファイルを書く", async () => {
    await configured();
    await advance(25 * HOUR);
    await call("POST", "/run");
    await idle();
    expect((await status()).lastRun?.status).toBe("succeeded");
    expect(readdirSync(env.folder)).toHaveLength(2);
  });
});

describe("GET /backup/runs", () => {
  it("新しい順に { runs } を返し、limit で切る。不正な limit は 400", async () => {
    await configured();
    for (let i = 0; i < 2; i += 1) {
      env.clock.advance(1000);
      await call("POST", "/run");
      await idle();
    }
    const all = (await (await call("GET", "/runs")).json()) as {
      runs: { id: string; finishedAt: string }[];
    };
    expect(all.runs).toHaveLength(3);
    expect((all.runs[0]?.finishedAt ?? "") >= (all.runs[2]?.finishedAt ?? "")).toBe(true);
    const two = (await (await call("GET", "/runs?limit=2")).json()) as { runs: unknown[] };
    expect(two.runs).toHaveLength(2);
    for (const bad of ["0", "abc", "1000"]) {
      expect((await call("GET", `/runs?limit=${bad}`)).status).toBe(400);
    }
  });
});

describe("認証", () => {
  it("サインインなしは全エンドポイントが 401", async () => {
    const headers = { Host: "localhost:5173", Origin: "http://localhost:5173" };
    for (const [method, path] of [
      ["GET", "/status"],
      ["PUT", "/settings"],
      ["PUT", "/passphrase"],
      ["POST", "/run"],
      ["GET", "/runs"],
    ] as const) {
      const res = await app.request(`/api/backup${path}`, { method, headers });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("パスフレーズを出さない（FR-015）", () => {
  it("レスポンス・ログ・backup_runs・app_settings・データ場所のファイルに含まれない", async () => {
    const secret = "unique-passphrase-7c3e91aa-qwerty";
    const next = "unique-passphrase-2b8f64cd-asdfgh";
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const bodies: string[] = [];
    const record = async (res: Response) => {
      bodies.push(await res.clone().text());
      return res;
    };

    await record(
      await call("PUT", "/settings", settings({ passphrase: secret, passphraseConfirm: secret })),
    );
    await idle();
    env.clock.advance(1000);
    await record(await call("GET", "/status"));
    await record(await call("GET", "/runs"));
    // 失敗の応答（不一致・誤り）にも載らない
    await record(
      await call("PUT", "/passphrase", {
        current: "x".repeat(14),
        passphrase: next,
        passphraseConfirm: next,
      }),
    );
    await record(
      await call("PUT", "/passphrase", {
        current: secret,
        passphrase: next,
        passphraseConfirm: `${next}!`,
      }),
    );
    await record(
      await call("PUT", "/passphrase", {
        current: secret,
        passphrase: next,
        passphraseConfirm: next,
      }),
    );
    await idle();
    await record(await call("GET", "/status"));
    await record(await call("GET", "/runs"));

    for (const text of bodies) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(next);
    }
    expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain("unique-passphrase");

    // DB の表と、データ場所・置き場所のファイル
    const rows = JSON.stringify(await env.backups().listRuns(100));
    expect(rows).not.toContain("unique-passphrase");
    for (const key of [
      "backup_folder",
      "backup_passphrase_set",
      "backup_force_write",
      "mac_id",
    ] as const) {
      expect((await env.auth().getSetting(key)) ?? "").not.toContain("unique-passphrase");
    }
    const needles = [Buffer.from(secret), Buffer.from(next)];
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk(tmp.dir)) {
      const bytes = readFileSync(file);
      for (const needle of needles) expect(bytes.includes(needle), file).toBe(false);
    }
  });
});

describe("INV-29 の網羅", () => {
  it("バックアップのルートが app.routes にある", () => {
    const keys = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const key of [
      "GET /api/backup/status",
      "PUT /api/backup/settings",
      "PUT /api/backup/passphrase",
      "POST /api/backup/run",
      "GET /api/backup/runs",
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
  });
});
