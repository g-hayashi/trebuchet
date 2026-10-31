import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  clearDataKey,
  dataDir,
  isUnlocked,
  openRegistry,
  registryFile,
  setDataKey,
  withDataKey,
} from "@trebuchet/db";
import type { AuthStore } from "@trebuchet/domain";

/**
 * vault（008 の D3。写す元: invest-copilot `vault.ts`）。解錠済みの DK は db の `setDataKey` が持つ
 * （メモリーだけ。再起動で消える）。解錠 = `setDataKey`、施錠 = `clearDataKey` とセッションの全削除。
 * 背景の処理（バックアップ・定期仕訳）は `subscribe` で解錠・施錠を受け取る（D7）。
 * DK・鍵をログに出さない（INV-51）
 */
export type VaultListener = (unlocked: boolean) => void;

export type Vault = {
  isUnlocked(): boolean;
  /**
   * 解錠する。`dk` の写しを渡すので、呼び出し側は自分のバッファを 0 で埋めてよい。
   * 解錠中に同じ DK なら何もしない。別の DK なら例外（今の DK を保つ）。
   * 施錠中は解錠して registry を開けることを確かめ、開けなければ（鍵が合わない）施錠に戻して例外
   */
  unlock(dk: Uint8Array): void;
  /** 施錠する。DK を消し（開いた registry・事業体の DB を閉じる）、セッションを全部消す（D3） */
  lock(): Promise<void>;
  /** 解錠中の DK を fn に渡す（包み直し）。fn の外へ持ち出さない。施錠中は VaultLockedError */
  withDataKey<T>(fn: (dk: Uint8Array) => T): T;
  /** 解錠（true）・施錠（false）の変わり目を知らせる。戻り値で解除する */
  subscribe(listener: VaultListener): () => void;
};

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createVault(deps: { store: () => AuthStore }): Vault {
  const listeners = new Set<VaultListener>();

  function notify(unlocked: boolean): void {
    for (const listener of listeners) {
      try {
        listener(unlocked);
      } catch (e) {
        console.error("vault: 知らせの処理に失敗", e instanceof Error ? e.name : "unknown");
      }
    }
  }

  return {
    isUnlocked,

    unlock(dk) {
      if (isUnlocked()) {
        if (!withDataKey((current) => sameKey(current, dk))) {
          throw new Error("vault is unlocked with another data key");
        }
        return;
      }
      setDataKey(Buffer.from(dk));
      try {
        // 鍵が合わなければ SQLITE_NOTADB。ファイルがなければ（初回の設定）この DK で空から作る
        openRegistry();
      } catch (e) {
        clearDataKey();
        throw e;
      }
      notify(true);
    },

    async lock() {
      const wasUnlocked = isUnlocked();
      clearDataKey();
      try {
        await deps.store().deleteAllSessions();
      } finally {
        if (wasUnlocked) notify(false);
      }
    },

    withDataKey,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 初回の設定の前に、前の DK で暗号化した registry（-wal・-shm を含む）と事業体の DB を
 * `<データ場所>/discarded-<時刻>/` に移す（D4.1 の「空から作る」。消さずに残す）。
 * 施錠中に呼ぶ（開いたハンドルがない）。移したディレクトリを返す。移すものがなければ null
 */
export function setAsideDataFiles(now: string): string | null {
  const registry = registryFile();
  const targets = [registry, `${registry}-wal`, `${registry}-shm`, join(dataDir(), "tenants")];
  const existing = targets.filter((path) => existsSync(path));
  if (existing.length === 0) return null;
  const dir = join(dataDir(), `discarded-${now.replace(/[-:.]/g, "")}`);
  mkdirSync(dir, { recursive: true });
  for (const path of existing) {
    renameSync(path, join(dir, path.slice(dataDir().length + 1)));
  }
  return dir;
}
