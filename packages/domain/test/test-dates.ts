/**
 * テストの「今」の時刻と日付の正本（日付の境目から離れた値）。
 * db のテストは `@trebuchet/db/testing` の再エクスポートから使う。
 * server のテストは時刻を JST の日付の境目から離す別の定数を持つ（`apps/server/test/invoicing-helpers.ts`）。
 */
export const NOW = "2026-10-31T09:00:00.000Z";
export const TODAY = "2026-10-31";
/** 定期仕訳のテストが使う月初の時刻（2026-10-01） */
export const MONTH_START_NOW = "2026-10-01T00:00:00.000Z";
