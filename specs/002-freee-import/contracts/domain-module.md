# Contract: ドメイン層のモジュール（002 の追加分）

001 の [domain-module.md](../../001-ledger-core/contracts/domain-module.md) に追加する。置き場所は `packages/domain/src/import/freee/`。すべて純関数で、I/O はしない（`TextDecoder` はグローバルの標準 API のため使ってよい）。

## 関数

| 関数 | 入力 | 出力 | 不変条件・要件 |
|---|---|---|---|
| `decodeText(bytes)` | `Uint8Array` | `{ text, encoding }`（UTF-8 を厳密に試し、だめなら Shift_JIS） | R1 |
| `parseCsv(text)` | 文字列 | `string[][]` | INV-17（`toCsv` との往復） |
| `readFreeeFile(bytes)` | | `Result<FreeeFile, { code: "IMPORT_UNKNOWN_FORMAT", missingColumns }>` | FR-001, R3 |
| `normalizeName(s)` | | NFKC ＋ 前後の空白の除去 | R4 |
| `groupFreeeJournals(file)` | 仕訳帳の `FreeeFile` | `{ journals: FreeeJournal[], rejected: { freeeJournalId, code }[] }` | FR-002, R4 |
| `parseFreeeLedger(file)` | 元帳の `FreeeFile` | `FreeeLedgerAccount[]` | R6, R7 |
| `isPriorYearClosing(journal, periods)` | | boolean | R5 |
| `proposeMappings(names, saved, accounts, subAccounts, taxCategories)` | ファイルに出てくる名前 | `MappingProposal` | FR-007〜009, R13 |
| `planImport(input)` | freee の仕訳、対応表、科目・補助科目・取引先・タグ、会計期間、税率、消費税の設定、既存の参照、手入力の仕訳の要約、`ImportOptions` | `ImportPreview`（ハッシュ・ファイル名以外） | FR-003〜006, FR-013, FR-015, FR-016, FR-029, FR-030, INV-13 |
| `canonicalSnapshot(journal)` | | 正準 JSON の文字列 | R9 |
| `proposeOpeningBalances(input)` | 元帳、対応表、科目、会計期間、登録済みの期首残高、前年度の残高（任意） | `OpeningProposal` | FR-019〜020a, INV-16 |
| `carryForward(balances, accounts)` | 前年度の期末の残高 | 翌年度の期首残高の行 | FR-020a, R6 |
| `reconcile(input)` | 元帳、対応表、科目、帳簿の残高（001 の `computeBalances`）、取込の判定の履歴 | `ReconciliationRow[]` | FR-021〜023, INV-14 |

`planImport` は 001 の `validateJournal` を各仕訳に必ず適用する。新しく作る補助科目・取引先・タグは、仮の ID で `JournalDraft` を組み立てて検証し、確定のときに本当の ID に置き換える。

## ユースケース（`usecases/import-freee.ts`）

| 関数 | 依存 | 説明 |
|---|---|---|
| `previewFreeeImport(deps, { bytes, fileName, sha256, options })` | `ImportUnitOfWork`（読み取りのみ） | `readFreeeFile` → `groupFreeeJournals` → `planImport` |
| `commitFreeeImport(deps, { bytes, fileName, sha256, options, expected })` | `ImportUnitOfWork`、`IdGenerator`、`Clock` | 1トランザクションの中でプレビューを作り直し、`expected` と比べてから、マスタの作成 → 仕訳の登録（採番, R15）→ 監査ログ → 参照 → 取込の記録（INV-11） |
| `voidImportBatch(deps, { batchId, reason, confirmCorrected })` | 同上 | 締め済みの確認 → 訂正済みの確認 → 有効な仕訳の取消（理由つき）→ 参照の `revoked_at` → 取込の回の `voided`（INV-15） |
| `saveImportMappings(deps, input)` | `ImportUnitOfWork` | 対応先の科目・補助科目の検証、保存 |
| `proposeFreeeOpening(deps, { bytes, fiscalYear })` | `ImportUnitOfWork`、`ReportRepository` | 前年度の残高を `computeBalances` で求めて `proposeOpeningBalances` に渡す |
| `reconcileFreee(deps, { bytes, fiscalYear })` | 同上 | |

## ポート（packages/db が実装）

```ts
interface ImportStore {
  listAccountMappings(): AccountMapping[]
  upsertAccountMappings(rows: AccountMapping[], updatedAt: string): void
  listTaxMappings(): TaxMapping[]
  upsertTaxMappings(rows: TaxMapping[], updatedAt: string): void
  activeRefsByFreeeIds(ids: string[]): ImportRef[]
  activeRefsInRange(from: string, to: string): ImportRef[]
  insertBatch(batch: ImportBatch): void
  insertRefs(refs: ImportRef[]): void
  listBatches(): ImportBatch[]
  getBatch(id: string): ImportBatch | undefined
  journalsOfBatch(id: string): { journal: Journal; ref: ImportRef }[]
  voidBatch(id: string, reason: string, at: string): void          // revoked_at の設定を含む
  manualJournalSignatures(from: string, to: string): JournalSignature[]   // R16
}

interface ImportUnitOfWork {
  transaction<T>(fn: (tx: { ledger: LedgerRepository; masters: MasterRepository; imports: ImportStore }) => T): T
}
```
