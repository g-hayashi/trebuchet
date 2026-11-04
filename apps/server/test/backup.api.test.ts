import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_DATA_KEY, type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { BackupStatus } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { type BackupEnv, HOUR, makeBackupEnv } from "./backup-helpers.ts";
import {
  createTestEntity,
  createTestSession,
  errorOf,
  TEST_HOST,
  TEST_ORIGIN,
  testHeaders,
} from "./helpers.ts";

// バックアップの HTTP（contracts/http-api.md「バックアップ」。inspect は backup-inspect.test.ts）。
// 008 の D9: パスフレーズ・同意・`PUT /passphrase` はなくした（鍵は DK から作る）

let tmp: TempDataDir;
let env: BackupEnv;
let app: ReturnType<typeof createApp>;
let cookie: string;
beforeEach(async () => {
  tmp = useTempDataDir("server");
  await createTestEntity("事業 A");
  env = makeBackupEnv(tmp);
  app = createApp({
    clock: env.clock.clock,
    backup: { runner: env.runner, store: env.backups },
  });
  cookie = (await createTestSession({ now: env.clock.clock.now() })).cookie;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.finish();
});

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

const settings = (over: Record<string, unknown> = {}) => ({ folder: env.folder, ...over });

/** 実行中の最初のバックアップが終わるのを待つ */
async function idle() {
  await env.runner.idle();
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
      configured: true,
      folder: env.defaultFolder,
      folderSource: "default",
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
    expect(s.folderSource).toBe("configured");
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

  it("「パスフレーズが使えない」の知らせはない（キーチェーンを見ない。STALE が優先で出る）", async () => {
    await configured();
    await advance(72 * HOUR);
    expect((await status()).alert).toEqual({ reason: "STALE" });
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
  it("置き場所だけで設定でき、最初のバックアップが始まる（パスフレーズ・同意は要らない）", async () => {
    const res = await call("PUT", "/settings", { folder: env.folder });
    expect(res.status).toBe(200);
    await idle();
    expect((await status()).lastRun?.status).toBe("succeeded");
  });

  it("置き場所がない・空は 400（スキーマ）", async () => {
    for (const body of [{}, { folder: "" }]) {
      const res = await call("PUT", "/settings", body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
  });

  it("古い形（passphrase など）の項目は無視し、保存しない", async () => {
    const res = await call(
      "PUT",
      "/settings",
      settings({
        passphrase: "legacy-passphrase-value",
        passphraseConfirm: "legacy-passphrase-value",
        acknowledged: true,
      }),
    );
    expect(res.status).toBe(200);
    await idle();
    expect((await status()).folder).toBe(env.folder);
  });

  it("存在しないフォルダ・ファイル・相対パスは 422 BACKUP_FOLDER_NOT_FOUND。何も保存しない", async () => {
    const file = join(tmp.dir, "a-file");
    writeFileSync(file, "x");
    for (const folder of [join(tmp.dir, "nothing"), file, "relative/dir"]) {
      const res = await call("PUT", "/settings", settings({ folder }));
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("BACKUP_FOLDER_NOT_FOUND");
    }
    expect((await status()).folderSource).toBe("default");
  });

  it("成功したら置き場所を保存し、force_write を立てる（最初の書き込みの成功で消える）", async () => {
    const res = await call("PUT", "/settings", settings());
    expect(res.status).toBe(200);
    expect(await env.auth().getSetting("backup_folder")).toBe(env.folder);
    await idle();
    expect(await env.auth().getSetting("backup_force_write")).toBe("0");
  });
});

describe("PUT /backup/passphrase（なくした）", () => {
  it("ルートがなく 404 になる", async () => {
    const res = await call("PUT", "/passphrase", { passphrase: "x".repeat(14) });
    expect(res.status).toBe(404);
  });
});

describe("POST /backup/run", () => {
  it("未設定でも既定の場所を作って手動で書き込む", async () => {
    const res = await call("POST", "/run");
    expect(res.status).toBe(202);
    await idle();
    expect((await status()).lastRun?.status).toBe("succeeded");
    expect(readdirSync(env.defaultFolder)).toHaveLength(1);
  });

  it("既定の場所を作れなければ失敗を記録し LAST_RUN_FAILED を返す", async () => {
    writeFileSync(env.defaultFolder, "blocked");
    expect((await call("POST", "/run")).status).toBe(202);
    await idle();
    const s = await status();
    expect(s.lastRun?.status).toBe("failed");
    expect(s.lastRun?.errorCode).toBe("WRITE_FAILED");
    expect(s.alert).toEqual({ reason: "LAST_RUN_FAILED" });
    expect(readFileSync(env.defaultFolder, "utf8")).toBe("blocked");
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
  it("CSV は limit を無視して最大表示件数を超える全件を新しい順に出し、秘密の列を除く", async () => {
    const secret = "synthetic-secret-token-key";
    for (let i = 0; i < 201; i += 1) {
      await env.backups().recordRun({
        id: `run-${i}`,
        startedAt: env.clock.clock.now(),
        finishedAt: env.clock.clock.now(),
        trigger: "manual",
        status: i === 200 ? "failed" : "succeeded",
        errorCode: secret,
        fileName: `/synthetic/${secret}.tbk`,
        sizeBytes: i,
        contentSha256: secret,
        summary: [{ id: secret, name: secret, fiscalYears: [] }],
      });
    }
    for (const limit of ["1", "invalid", "0"]) {
      const res = await call("GET", `/runs?format=csv&limit=${limit}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="backup-runs.csv"');
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const csv = Buffer.from(await res.arrayBuffer()).toString("utf8");
      expect(csv).toMatch(/^\uFEFF開始日時,終了日時,種類,結果,サイズ（バイト）\r\n/);
      expect(csv.split("\r\n")).toHaveLength(203);
      expect(csv.split("\r\n")[1]).toBe(
        `${env.clock.clock.now()},${env.clock.clock.now()},manual,failed,200`,
      );
      expect(csv).not.toContain(secret);
      expect(csv).not.toMatch(/errorCode|fileName|contentSha256|summary/);
    }
    expect(((await (await call("GET", "/runs")).json()) as { runs: unknown[] }).runs).toHaveLength(
      50,
    );
  });

  it("CSV は空なら見出しだけを返す", async () => {
    const res = await call("GET", "/runs?format=csv");
    expect(Buffer.from(await res.arrayBuffer()).toString("utf8")).toBe(
      "\uFEFF開始日時,終了日時,種類,結果,サイズ（バイト）\r\n",
    );
    const unsigned = await app.request("/api/backup/runs?format=csv", {
      headers: { Host: TEST_HOST, Origin: TEST_ORIGIN },
    });
    expect(unsigned.status).toBe(401);
    const recovery = await createTestSession({ now: env.clock.clock.now(), kind: "recovery" });
    const recoveryCsv = await app.request("/api/backup/runs?format=csv", {
      headers: { Host: TEST_HOST, Origin: TEST_ORIGIN, Cookie: recovery.cookie },
    });
    expect(recoveryCsv.status).toBe(401);
    const wrongHost = await app.request("/api/backup/runs?format=csv", {
      headers: { Host: "untrusted.invalid", Origin: TEST_ORIGIN, Cookie: cookie },
    });
    expect(wrongHost.status).toBe(421);
  });

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
      ["POST", "/run"],
      ["GET", "/runs"],
    ] as const) {
      const res = await app.request(`/api/backup${path}`, { method, headers });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("鍵を出さない（INV-51）", () => {
  it("レスポンス・ログ・backup_runs・app_settings・データ場所のファイルに DK・回復キーが含まれない", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const bodies: string[] = [];
    const record = async (res: Response) => {
      bodies.push(await res.clone().text());
      return res;
    };

    await record(await call("PUT", "/settings", settings()));
    await idle();
    env.clock.advance(1000);
    await record(await call("GET", "/status"));
    await record(await call("GET", "/runs"));
    await record(await call("POST", "/run"));
    await idle();
    await record(await call("GET", "/status"));
    await record(await call("GET", "/runs"));

    const hex = Buffer.from(TEST_DATA_KEY).toString("hex");
    const b64 = Buffer.from(TEST_DATA_KEY).toString("base64");
    const recovery = env.recovery.text;
    const strings = [hex, b64, recovery, recovery.replaceAll("-", "")];
    for (const text of bodies) for (const s of strings) expect(text).not.toContain(s);
    const logged = JSON.stringify(logs.map((l) => l.mock.calls));
    for (const s of strings) expect(logged).not.toContain(s);

    // DB の表と、置き場所のファイル（データ場所の DB は暗号化・包みで、平文の鍵を持たない）
    const rows = JSON.stringify(await env.backups().listRuns(100));
    for (const s of strings) expect(rows).not.toContain(s);
    for (const key of ["backup_folder", "backup_force_write", "mac_id"] as const) {
      const value = (await env.auth().getSetting(key)) ?? "";
      for (const s of strings) expect(value).not.toContain(s);
    }
    const needles = [Buffer.from(TEST_DATA_KEY), ...strings.map((s) => Buffer.from(s))];
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
  it("バックアップのルートが app.routes にある（passphrase のルートはない）", () => {
    const keys = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const key of [
      "GET /api/backup/status",
      "PUT /api/backup/settings",
      "POST /api/backup/run",
      "GET /api/backup/runs",
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
    expect(keys.has("PUT /api/backup/passphrase")).toBe(false);
  });
});
