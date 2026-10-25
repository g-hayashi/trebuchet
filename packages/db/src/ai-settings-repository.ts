import { aiSettings } from "./schema/registry.ts";
import type { RegistryDb } from "./tenant-store.ts";

/** AI の接続の設定（006 R12。端末の設定）。API キーはキーチェーンに置き、ここに持たない */
export type AiSettingsRecord = {
  localEnabled: boolean;
  externalEnabled: boolean;
  externalBaseUrl: string | null;
  externalModel: string | null;
};

export const DEFAULT_AI_SETTINGS: AiSettingsRecord = {
  localEnabled: true,
  externalEnabled: false,
  externalBaseUrl: null,
  externalModel: null,
};

/** registry の `ai_settings`（1 行。行がなければ既定の値） */
export class DrizzleAiSettingsStore {
  private readonly db: RegistryDb;

  constructor(db: RegistryDb) {
    this.db = db;
  }

  get(): AiSettingsRecord {
    const row = this.db.select().from(aiSettings).get();
    if (row === undefined) return { ...DEFAULT_AI_SETTINGS };
    return {
      localEnabled: row.localEnabled === 1,
      externalEnabled: row.externalEnabled === 1,
      externalBaseUrl: row.externalBaseUrl,
      externalModel: row.externalModel,
    };
  }

  save(settings: AiSettingsRecord, at: string): void {
    const values = {
      localEnabled: settings.localEnabled ? 1 : 0,
      externalEnabled: settings.externalEnabled ? 1 : 0,
      externalBaseUrl: settings.externalBaseUrl,
      externalModel: settings.externalModel,
      updatedAt: at,
    };
    this.db
      .insert(aiSettings)
      .values({ id: 1, ...values })
      .onConflictDoUpdate({ target: aiSettings.id, set: values })
      .run();
  }
}
