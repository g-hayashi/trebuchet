import {
  RECEIPT_MAX_BYTES,
  type ReceiptChannel,
  type ReceiptCreateOptions,
  type ReceiptDetail,
  type ReceiptFileView,
  type ReceiptMediaType,
  type ReceiptQuery,
  type ReceiptReadingView,
  type ReceiptSummary,
  YEN_LIMIT,
} from "@trebuchet/schema";
import { auditEntry } from "../audit.ts";
import { isValidDate } from "../dates.ts";
import type {
  Clock,
  IdGenerator,
  ReceiptFileStore,
  ReceiptProbe,
  ReceiptStore,
  ReceiptUnitOfWork,
  TenantTx,
} from "../ports.ts";
import { detectReceiptFormat } from "../receipts/format.ts";
import { linkStateOf, receiptValuesOf } from "../receipts/history.ts";
import { normalizeReceiptText } from "../receipts/search.ts";
import { receiptWarnings } from "../receipts/warnings.ts";
import { TAX_PARAMETERS } from "../seed/tax-parameters.ts";
import {
  domainError,
  err,
  type JournalRef,
  ok,
  type ReceiptFileRow,
  type ReceiptLinkRow,
  type ReceiptReadingRow,
  type ReceiptRow,
  type Result,
  validationError,
} from "../types.ts";

// 証憑の追加・一覧・詳細・ファイルの取り出し（010 US1。contracts/domain-module.md §3、R10、FR-001〜005・007）

export type ReceiptDeps = {
  uow: ReceiptUnitOfWork;
  files: ReceiptFileStore;
  clock: Clock;
  ids: IdGenerator;
  /**
   * ISO 8601（UTC）の日時を `Asia/Tokyo` の `YYYY-MM-DD` にする。server が `todayOf(clock)` と同じ変換で作る。
   * 受領日の判定（入力期間の警告）と候補の基準日に使う（domain は `Date`・`Intl` を使わない。I2）
   */
  dateOf: (iso: string) => string;
};

type ReadTx = Pick<TenantTx<{ receipts: ReceiptStore }>, "ledger" | "receipts">;

const PARTNER_MAX = 100;
const MEMO_MAX = 500;

// ---- 値の検査 ----

type CheckedValues = {
  transactionDate: string | null;
  amount: number | null;
  partnerName: string | null;
  memo: string | null;
};

function checkValues(options: ReceiptCreateOptions): Result<CheckedValues> {
  const fail = (field: string, message: string) => err(validationError(message, { field }));
  const { transactionDate = null, amount = null, memo = null } = options;
  if (transactionDate !== null && !isValidDate(transactionDate)) {
    return fail("transactionDate", "取引年月日が正しくありません");
  }
  if (amount !== null && !(Number.isInteger(amount) && amount > 0 && amount < YEN_LIMIT)) {
    return fail("amount", "金額は 1 円以上 1 兆円未満の整数で入力してください");
  }
  const partnerName =
    options.partnerName === undefined ? null : (options.partnerName?.trim() ?? null);
  if (partnerName !== null && (partnerName.length === 0 || partnerName.length > PARTNER_MAX)) {
    return fail("partnerName", `取引先は 1〜${PARTNER_MAX} 文字で入力してください`);
  }
  if (memo !== null && memo.length > MEMO_MAX) {
    return fail("memo", `メモは ${MEMO_MAX} 文字以内で入力してください`);
  }
  return ok({ transactionDate, amount, partnerName, memo });
}

// ---- 表示用の組み立て ----

const fileView = (f: ReceiptFileRow): ReceiptFileView => ({
  sha256: f.sha256,
  fileVersion: f.fileVersion,
  mediaType: f.mediaType,
  sizeBytes: f.sizeBytes,
  originalName: f.originalName,
  width: f.width,
  height: f.height,
  fullColor: f.fullColor,
  addedAt: f.addedAt,
  channel: f.channel,
});

/** 詳細の `readings` の 1 件。`reason` は読み取りの応答だけが持つ（保存しないので null） */
const readingView = (r: ReceiptReadingRow): ReceiptReadingView => ({
  id: r.id,
  readAt: r.readAt,
  model: r.model,
  status: r.status,
  errorCode: r.errorCode,
  candidates: {
    transactionDate: r.candDate,
    amount: r.candAmount,
    partnerName: r.candPartner,
    accountCode: r.candAccountCode,
    taxCategory: r.candTaxCategory,
  },
  confidence: r.confidence,
  reason: null,
});

function toSummary(
  deps: ReceiptDeps,
  receipt: ReceiptRow,
  currentFile: ReceiptFileRow,
  link: ReceiptLinkRow | undefined,
  journal: JournalRef | undefined,
): ReceiptSummary {
  const linkState = linkStateOf(link, journal?.status);
  return {
    id: receipt.id,
    receivedAt: receipt.receivedAt,
    channel: receipt.channel,
    category: receipt.category,
    transactionDate: receipt.transactionDate,
    amount: receipt.amount,
    partnerName: receipt.partnerName,
    mediaType: currentFile.mediaType,
    deleted: receipt.deletedAt !== null,
    linkState,
    journal: journal === undefined ? null : { ...journal },
    warnings: receiptWarnings({
      receipt,
      currentFile,
      linkState,
      receivedDate: deps.dateOf(receipt.receivedAt),
      taxParameters: TAX_PARAMETERS,
    }),
  };
}

const journalRefOf = (tx: ReadTx, link: ReceiptLinkRow | undefined): JournalRef | undefined => {
  if (link === undefined) return undefined;
  const journal = tx.ledger.getJournal(link.journalId);
  return journal === undefined
    ? undefined
    : { id: journal.id, journalNo: journal.journalNo, date: journal.date, status: journal.status };
};

/** 証憑の詳細（版・読み取り・結びつき・警告）。`uow.run` の中で呼ぶ */
function buildDetail(tx: ReadTx, deps: ReceiptDeps, receipt: ReceiptRow): ReceiptDetail {
  const files = tx.receipts.listFiles(receipt.id);
  const currentFile = files.find((f) => f.sha256 === receipt.currentSha256);
  if (currentFile === undefined) throw new Error(`current file not found: ${receipt.id}`);
  const link = tx.receipts.getActiveLink(receipt.id);
  const journal = journalRefOf(tx, link);
  return {
    ...toSummary(deps, receipt, currentFile, link, journal),
    memo: receipt.memo,
    version: receipt.version,
    currentFile: fileView(currentFile),
    files: files.map(fileView),
    readings: tx.receipts.listReadings(receipt.id).map(readingView),
    deletedAt: receipt.deletedAt,
    deletedReason: receipt.deletedReason,
  };
}

const notFound = () => domainError("RECEIPT_NOT_FOUND", "証憑が見つかりません");

// ---- 追加 ----

export type AddReceiptInput = {
  bytes: Uint8Array;
  originalName: string;
  channel: ReceiptChannel;
  options: ReceiptCreateOptions;
  /** 呼び出し側（server）が `ReceiptImageTool.probe` で調べた寸法と色。調べられなければ null */
  probe: ReceiptProbe | null;
};

/**
 * 証憑を追加する（FR-001〜005、research R10）。**同期の区間**（`await` を挟まない）:
 * 形式 → 大きさ → 値の検査 → `digest` → 重複 → `put` → `uow.run`（証憑・版 1・履歴 `create`）。
 * 失敗したら、この呼び出しが `put` したファイルだけ `discard` する（INV-62）
 */
export function addReceipt(deps: ReceiptDeps, input: AddReceiptInput): Result<ReceiptDetail> {
  const { bytes, originalName, channel, options, probe } = input;
  const mediaType = detectReceiptFormat(bytes);
  if (mediaType === undefined) {
    return err(
      domainError(
        "RECEIPT_FORMAT_UNSUPPORTED",
        "対応していない形式です（JPEG・PNG・PDF・HEIC に対応しています）",
      ),
    );
  }
  if (bytes.length > RECEIPT_MAX_BYTES) {
    return err(
      domainError("FILE_TOO_LARGE", "ファイルが大きすぎます", { maxBytes: RECEIPT_MAX_BYTES }),
    );
  }
  const checked = checkValues(options);
  if (!checked.ok) return checked;

  const sha256 = deps.files.digest(bytes);
  const duplicate = deps.uow.run((tx) => {
    const existing = tx.receipts.findFileBySha(sha256);
    if (existing === undefined) return ok(undefined);
    const owner = tx.receipts.getReceipt(existing.receiptId);
    return err(
      domainError("RECEIPT_DUPLICATE", "同じ内容の証憑がすでにあります", {
        receiptId: existing.receiptId,
        deleted: owner?.deletedAt != null,
      }),
    );
  });
  if (!duplicate.ok) return duplicate;

  // 前の異常終了で残った同じ内容のファイルは使い回す（このとき失敗しても消さない）
  const created = !deps.files.has(sha256);
  if (created) deps.files.put(sha256, bytes);
  try {
    const result = deps.uow.run((tx) => {
      const now = deps.clock.now();
      const receipt: ReceiptRow = {
        id: deps.ids.next(),
        receivedAt: now,
        channel,
        category: options.category,
        currentSha256: sha256,
        transactionDate: checked.value.transactionDate,
        amount: checked.value.amount,
        partnerName: checked.value.partnerName,
        partnerKey:
          checked.value.partnerName === null
            ? null
            : normalizeReceiptText(checked.value.partnerName),
        memo: checked.value.memo,
        deletedAt: null,
        deletedReason: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      tx.receipts.insertReceipt(receipt);
      tx.receipts.insertFile({
        sha256,
        receiptId: receipt.id,
        fileVersion: 1,
        mediaType,
        sizeBytes: bytes.length,
        originalName,
        width: probe?.width ?? null,
        height: probe?.height ?? null,
        fullColor: probe?.fullColor ?? null,
        addedAt: now,
        channel,
      });
      tx.receipts.appendAudit(
        auditEntry(deps, {
          targetType: "receipt",
          targetId: receipt.id,
          action: "create",
          before: null,
          after: { ...receiptValuesOf(receipt), sha256 },
          at: now,
        }),
      );
      return ok(buildDetail(tx, deps, receipt));
    });
    if (!result.ok && created) deps.files.discard(sha256);
    return result;
  } catch (e) {
    if (created) deps.files.discard(sha256);
    throw e;
  }
}

// ---- 一覧・詳細 ----

/** 検索（`ReceiptStore.search`）の結果に、結びつきの状態と警告を付ける */
export function listReceipts(
  deps: ReceiptDeps,
  query: ReceiptQuery,
): Result<{ receipts: ReceiptSummary[]; nextCursor: string | null }> {
  return deps.uow.run((tx) => {
    const page = tx.receipts.search(query);
    return ok({
      receipts: page.rows.map((row) =>
        toSummary(deps, row.receipt, row.currentFile, row.link, row.journal),
      ),
      nextCursor: page.nextCursor,
    });
  });
}

/** 詳細（版・読み取り・警告）。削除済みも返す（表示・取り出し・履歴は削除の後もできる） */
export function getReceipt(deps: ReceiptDeps, receiptId: string): Result<ReceiptDetail> {
  return deps.uow.run((tx) => {
    const receipt = tx.receipts.getReceipt(receiptId);
    if (receipt === undefined) return err(notFound());
    return ok(buildDetail(tx, deps, receipt));
  });
}

// ---- ファイルの取り出し ----

/** db の `ReceiptFileUnreadableError`（欠け・改ざん・誤った鍵・ハッシュの不一致）。domain は名前で見分ける */
const isUnreadable = (e: unknown): boolean =>
  e instanceof Error && e.name === "ReceiptFileUnreadableError";

/**
 * その証憑の版（`sha256`）を復号して返す。差し替え前の版・削除済みの証憑も取り出せる。
 * 表示用の変換（HEIC → JPEG など）は server（`ReceiptImageTool.toDisplay`）
 */
export function readReceiptFile(
  deps: ReceiptDeps,
  receiptId: string,
  sha256: string,
): Result<{ bytes: Uint8Array; mediaType: ReceiptMediaType; originalName: string }> {
  const found = deps.uow.run((tx) => {
    if (tx.receipts.getReceipt(receiptId) === undefined) return err(notFound());
    const file = tx.receipts.findFileBySha(sha256);
    if (file === undefined || file.receiptId !== receiptId) return err(notFound());
    return ok(file);
  });
  if (!found.ok) return found;
  try {
    const bytes = deps.files.read(sha256);
    return ok({
      bytes,
      mediaType: found.value.mediaType,
      originalName: found.value.originalName,
    });
  } catch (e) {
    if (isUnreadable(e)) {
      return err(domainError("RECEIPT_FILE_UNREADABLE", "証憑のファイルを読めません"));
    }
    throw e;
  }
}
