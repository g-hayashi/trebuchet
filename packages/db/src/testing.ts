import { randomUUIDv7 } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import {
  type Account,
  type Clock,
  createEntity,
  type EntityKind,
  type EntityProfile,
  type IdGenerator,
} from "@trebuchet/domain";
import { NOW } from "@trebuchet/domain/testing";
import { DrizzleMasterRepository } from "./master-repository.ts";
import { DrizzleRegistryRepository } from "./registry-repository.ts";
import {
  clearDataKey,
  closeAll,
  openRegistry,
  openTenant,
  setDataKey,
  TMP_ROOT,
} from "./tenant-store.ts";

/** テストの「今」の時刻と日付。正本は `packages/domain/test/test-dates.ts` */
/** Result の取り出し。正本は `packages/domain/test/result.ts` */
export { codeOf, errorOf, must, NOW, TODAY, unwrap } from "@trebuchet/domain/testing";
export { TMP_ROOT };

/** 毎回新しい UUIDv7 を返す ID 生成器 */
export function testIds(): IdGenerator {
  return { next: () => randomUUIDv7() };
}

/** 固定の時刻を返す時計（既定は NOW） */
export function testClock(now: string = NOW): Clock {
  return { now: () => now };
}

export type TempDataDir = {
  dir: string;
  cleanup(): void;
};

/**
 * テスト用の固定の DK（008 の D2）。`setDataKey` は渡したバッファを施錠時に 0 で埋めるので、
 * 渡すときは `Buffer.from(TEST_DATA_KEY)` の写しにする
 */
export const TEST_DATA_KEY: Readonly<Uint8Array> = Buffer.alloc(32, 0x5a);

/**
 * `.tmp/<uuid>/` を作り、TREBUCHET_DATA_DIR に設定し、テスト用の DK で解錠する。
 * cleanup() で開いている DB を閉じて施錠し、ディレクトリを削除して環境変数を戻す。
 */
export function useTempDataDir(prefix = "db"): TempDataDir {
  const previous = process.env.TREBUCHET_DATA_DIR;
  const dir = `${TMP_ROOT}${prefix}-${randomUUIDv7()}`;
  mkdirSync(dir, { recursive: true });
  process.env.TREBUCHET_DATA_DIR = dir;
  setDataKey(Buffer.from(TEST_DATA_KEY));
  return {
    dir,
    cleanup() {
      closeAll();
      clearDataKey();
      rmSync(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.TREBUCHET_DATA_DIR;
      else process.env.TREBUCHET_DATA_DIR = previous;
    },
  };
}

export type TestEntityOptions = {
  name?: string;
  kind?: EntityKind;
  fiscalStartMonth?: number;
  firstFiscalYear?: number;
  /** 作成時刻の時計の値（既定は NOW） */
  now?: string;
  ids?: IdGenerator;
};

/**
 * 事業体を作る（registry への登録とテナント DB の初期化）。失敗したら例外を投げる。
 * 呼ぶ前に `useTempDataDir` でデータの置き場所を切り替えておくこと。
 * 既定は 2026 年度から始まる個人事業。
 */
export function createTestEntity(options: TestEntityOptions = {}): EntityProfile {
  const created = createEntity(
    {
      registry: new DrizzleRegistryRepository(openRegistry()),
      openTenant: (entityId) => new DrizzleMasterRepository(openTenant(entityId)),
      ids: options.ids ?? testIds(),
      clock: testClock(options.now ?? NOW),
    },
    {
      name: options.name ?? "個人事業",
      kind: options.kind ?? "individual",
      fiscalStartMonth: options.fiscalStartMonth ?? 1,
      firstFiscalYear: options.firstFiscalYear ?? 2026,
    },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

/** 内容から明細の ID を引く。なければ例外 */
export function statementIdOf(
  store: { listStatements(): readonly { id: string; content: string }[] },
  content: string,
): string {
  const s = store.listStatements().find((x) => x.content === content);
  if (s === undefined) throw new Error(`明細がない: ${content}`);
  return s.id;
}

/** 名前から勘定科目の ID を引く。なければ例外 */
export function accountIdOf(masters: { listAccounts(): Account[] }, name: string): string {
  const account = masters.listAccounts().find((a) => a.name === name);
  if (account === undefined) throw new Error(`科目がない: ${name}`);
  return account.id;
}
