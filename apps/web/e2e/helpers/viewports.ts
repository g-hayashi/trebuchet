/** E2E・撮影の画面の大きさ */

/** スマホの幅（FR-058。`mobile.spec.ts` の検査、manual の撮影、宣伝動画のスマホの枠） */
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** マニュアルの撮影のデスクトップ（`manual.playwright.config.ts`） */
export const MANUAL_DESKTOP_VIEWPORT = { width: 1280, height: 900 };

/** 宣伝動画の録画（`promo.playwright.config.ts`、`promo.capture.ts`） */
export const PROMO_VIEWPORT = { width: 1280, height: 720 };
