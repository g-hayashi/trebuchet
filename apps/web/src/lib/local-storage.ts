/**
 * ブラウザに覚える値（`localStorage`）のキーと、読み書きの関数。
 * キーの文字列は保存済みの値を読むために変えない。保存できない環境（プライベートモードなど）でも例外にしない
 */
export const storageKeys = {
  /** 最後に開いた事業体の ID（011 R4） */
  lastEntityId: "trebuchet:lastEntityId",
  /** 証憑の追加で最後に選んだ区分（事業体ごと） */
  receiptCategory: (entityId: string) => `trebuchet.receiptCategory.${entityId}`,
  /** 前回使った入金先の科目（事業体ごと。011 FR-035） */
  depositAccount: (entityId: string) => `trebuchet.depositAccount.${entityId}`,
} as const;

/** 値を読む。ないとき・読めないときは null */
export function getStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 値を保存する。保存できなくても例外にしない */
export function setStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても操作は続ける
  }
}

/** 値を消す。消せなくても例外にしない */
export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // 消せなくても操作は続ける
  }
}
