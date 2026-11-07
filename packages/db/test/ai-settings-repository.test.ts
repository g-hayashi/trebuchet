import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleAiSettingsStore } from "../src/ai-settings-repository.ts";
import { closeAll, openRegistry } from "../src/tenant-store.ts";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 006 の data-model §2.1（registry の ai_settings）、research R12。API キーはこの表に持たない

let tmp: TempDataDir;
let store: DrizzleAiSettingsStore;
beforeEach(() => {
  tmp = useTempDataDir("ai-settings-repository");
  store = new DrizzleAiSettingsStore(openRegistry());
});
afterEach(() => {
  closeAll();
  tmp.cleanup();
});

const AT = "2026-10-25T09:00:00.000Z";

describe("DrizzleAiSettingsStore", () => {
  it("行がなければ既定（端末内は無効（非推奨）、外部は無効、接続先・モデルは null）", () => {
    expect(store.get()).toEqual({
      localEnabled: false,
      externalEnabled: false,
      externalBaseUrl: null,
      externalModel: null,
      receiptImagesEnabled: false,
    });
  });

  it("保存した値を読み戻せ、2 回目の保存は同じ 1 行を更新する", () => {
    store.save(
      {
        localEnabled: false,
        externalEnabled: true,
        externalBaseUrl: "https://api.example.com",
        externalModel: "model-a",
        receiptImagesEnabled: true,
      },
      AT,
    );
    expect(store.get()).toEqual({
      localEnabled: false,
      externalEnabled: true,
      externalBaseUrl: "https://api.example.com",
      externalModel: "model-a",
      receiptImagesEnabled: true,
    });

    store.save(
      {
        localEnabled: true,
        externalEnabled: false,
        externalBaseUrl: null,
        externalModel: null,
        receiptImagesEnabled: false,
      },
      "2026-10-26T09:00:00.000Z",
    );
    expect(store.get().externalBaseUrl).toBeNull();
    const rows = openRegistry().$client.prepare("SELECT id, updated_at FROM ai_settings").all();
    expect(rows).toEqual([{ id: 1, updated_at: "2026-10-26T09:00:00.000Z" }]);
  });

  it("外部を有効にして接続先かモデルがなければ、表の CHECK で拒否する（API キーの列はない）", () => {
    expect(() =>
      store.save(
        {
          localEnabled: true,
          externalEnabled: true,
          externalBaseUrl: "https://api.example.com",
          externalModel: null,
          receiptImagesEnabled: false,
        },
        AT,
      ),
    ).toThrow();
    // 証憑の画像の送信は外部の AI が有効のときだけ（表の CHECK。検査は server にもある。010 R15）
    expect(() =>
      store.save(
        {
          localEnabled: true,
          externalEnabled: false,
          externalBaseUrl: null,
          externalModel: null,
          receiptImagesEnabled: true,
        },
        AT,
      ),
    ).toThrow();
    const columns = openRegistry()
      .$client.prepare("SELECT name FROM pragma_table_info('ai_settings')")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name).join(",")).not.toMatch(/key|secret|token/i);
  });
});
