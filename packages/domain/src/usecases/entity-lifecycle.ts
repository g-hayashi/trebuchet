import type { EntitySummary, Result } from "../types.ts";
import { domainError, err, ok } from "../types.ts";

export type EntityStatus = "active" | "archived" | "deleting";
export type ManagedEntity = EntitySummary & { status: EntityStatus };
export interface EntityLifecycleStore {
  getManagedEntity(id: string): ManagedEntity | undefined;
  setEntityStatus(id: string, status: EntityStatus): void;
  purgeEntityData(id: string): void;
}

/** 削除中は復元を拒否する。ファイル削除に失敗しても非表示のまま再試行できる。 */
export function manageEntity(
  store: EntityLifecycleStore,
  id: string,
  action: "archive" | "restore" | "purge",
  confirmationName?: string,
): Result<null> {
  const entity = store.getManagedEntity(id);
  if (!entity) return err(domainError("ENTITY_NOT_FOUND", "事業体が見つかりません"));
  if (action === "purge") {
    if (entity.status === "active") {
      return err(domainError("VALIDATION", "完全に削除する前に事業体を非表示にしてください"));
    }
    if (confirmationName !== entity.name) {
      return err(domainError("VALIDATION", "確認の名称が一致しません"));
    }
    store.setEntityStatus(entity.id, "deleting");
    store.purgeEntityData(entity.id);
  } else {
    if (entity.status === "deleting") {
      return err(domainError("VALIDATION", "削除処理中です。完全削除を再試行してください"));
    }
    store.setEntityStatus(entity.id, action === "archive" ? "archived" : "active");
  }
  return ok(null);
}
