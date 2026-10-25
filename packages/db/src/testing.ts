import { randomUUIDv7 } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import {
  type Account,
  createEntity,
  type EntityKind,
  type EntityProfile,
  type IdGenerator,
} from "@trebuchet/domain";
import { NOW } from "@trebuchet/domain/testing";
import { DrizzleMasterRepository } from "./master-repository.ts";
import { DrizzleRegistryRepository } from "./registry-repository.ts";
import { closeAll, openRegistry, openTenant, TMP_ROOT } from "./tenant-store.ts";

/** テストの「今」の時刻と日付。正本は `packages/domain/test/test-dates.ts` */
export { NOW, TODAY } from "@trebuchet/domain/testing";
export { TMP_ROOT };

export type TempDataDir = {
  dir: string;
  cleanup(): void;
};

/**
 * `.tmp/<uuid>/` を作り、TREBUCHET_DATA_DIR に設定する。
 * cleanup() で開いている DB を閉じ、ディレクトリを削除して環境変数を戻す。
 */
export function useTempDataDir(prefix = "db"): TempDataDir {
  const previous = process.env.TREBUCHET_DATA_DIR;
  const dir = `${TMP_ROOT}${prefix}-${randomUUIDv7()}`;
  mkdirSync(dir, { recursive: true });
  process.env.TREBUCHET_DATA_DIR = dir;
  return {
    dir,
    cleanup() {
      closeAll();
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
      ids: options.ids ?? { next: () => randomUUIDv7() },
      clock: { now: () => options.now ?? NOW },
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

/** 名前から勘定科目の ID を引く。なければ例外 */
export function accountIdOf(masters: { listAccounts(): Account[] }, name: string): string {
  const account = masters.listAccounts().find((a) => a.name === name);
  if (account === undefined) throw new Error(`科目がない: ${name}`);
  return account.id;
}
