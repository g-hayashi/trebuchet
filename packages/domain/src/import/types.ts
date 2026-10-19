import type { Side, TaxCategoryCode } from "../types.ts";

// 取込の記録と対応表（specs/002-freee-import/data-model.md §2）。ImportStore（ports.ts）が読み書きする

/** 科目の対応表の1行。sourceName は NFKC で正規化した freee の勘定科目名 */
export type AccountMapping = {
  sourceName: string;
  accountId: string;
  subAccountId?: string | undefined;
  /** 補助科目がまだないとき、取込で作る名前（subAccountId と同時には入らない） */
  subAccountName?: string | undefined;
};

/** 税区分の対応表の1行。sourceName は NFKC で正規化した freee の税区分名 */
export type TaxMapping = {
  sourceName: string;
  taxCategory: TaxCategoryCode;
};

export type ImportBatchStatus = "active" | "voided";

/** 取込の回（import_batches） */
export type ImportBatch = {
  id: string;
  source: "freee_journal";
  fileName: string;
  /** 小文字16進64文字 */
  fileSha256: string;
  importedAt: string;
  /** 取り込んだ仕訳の最小日・最大日 */
  periodFrom: string;
  periodTo: string;
  fiscalYears: number[];
  /** 登録した仕訳の数（>= 1） */
  countNew: number;
  countAlready: number;
  countExcluded: number;
  countRejected: number;
  countWarnings: number;
  status: ImportBatchStatus;
  voidedAt: string | null;
  voidReason: string | null;
};

/** 取込元の仕訳の識別（import_journal_refs）。帳簿の仕訳1件に1行 */
export type ImportRef = {
  journalId: string;
  batchId: string;
  freeeJournalId: string;
  /** 表示用（freee の仕訳番号） */
  freeeJournalNo: string | null;
  freeeDate: string;
  /** 取込のときの freee の内容の正準 JSON（research R9） */
  snapshotJson: string;
  /** 取込の取消で設定する */
  revokedAt: string | null;
};

/** 手入力の仕訳との重複の判定に使う要約（research R16） */
export type JournalSignature = {
  journalId: string;
  journalNo: number;
  date: string;
  lines: { side: Side; accountId: string; amount: number }[];
};
