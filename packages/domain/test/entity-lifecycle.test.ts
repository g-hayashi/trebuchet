import { expect, it } from "vitest";
import {
  type EntityLifecycleStore,
  type ManagedEntity,
  manageEntity,
} from "../src/usecases/entity-lifecycle.ts";

it("ファイル削除失敗後は deleting を保持し、復元を拒否し、完全削除を再試行できる", () => {
  let entity: ManagedEntity | undefined = {
    id: "synthetic",
    name: "合成事業",
    kind: "individual",
    createdAt: "2026-01-01T00:00:00Z",
    status: "archived",
  };
  let fail = true;
  const store: EntityLifecycleStore = {
    getManagedEntity: () => entity,
    setEntityStatus: (_id, status) => {
      if (entity) entity = { ...entity, status };
    },
    purgeEntityData: () => {
      if (fail) throw new Error("synthetic disk failure");
      entity = undefined;
    },
  };
  expect(() => manageEntity(store, "synthetic", "purge", "合成事業")).toThrow(
    "synthetic disk failure",
  );
  expect(entity?.status).toBe("deleting");
  expect(manageEntity(store, "synthetic", "restore").ok).toBe(false);
  expect(manageEntity(store, "synthetic", "archive").ok).toBe(false);
  fail = false;
  expect(manageEntity(store, "synthetic", "purge", "合成事業").ok).toBe(true);
  expect(entity).toBeUndefined();
});
