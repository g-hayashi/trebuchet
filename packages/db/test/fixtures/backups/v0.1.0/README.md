# 見本のバックアップ v0.1.0

v0.1.0 のアプリで `pnpm backup:fixture`（`scripts/make-backup-fixture.ts`）が作った見本。
`packages/db/test/backup-fixtures.test.ts` が、毎回今の版で復元して `expected.json` と照合する。

- **書き換えない・消さない**。互換を壊す変更はテストが赤で止める。直すのは今の版のコード（マイグレーション・復元）の側
- 帳簿は合成（架空の取引先・摘要）。実データを含まない
- 鍵はテスト専用: DK は `TEST_DATA_KEY`（`packages/db/src/testing.ts`）、回復キーは `expected.json` の `recoveryKey`
- アプリの版（マイグレーションの数）: registry 6、tenant 23
- 作成日時: 2026-11-16T03:00:00.000Z

- デモ事業（サンプル）: 仕訳 58 件、会計年度 2026
- 見本の事業（合成）: 仕訳 20 件、会計年度 2025・2026

| ファイル | 中身 |
|---|---|
| `backup.tbk` | バックアップ（ヘッダーの `release` は 0.1.0） |
| `trebuchet-receipts/` | 証憑の写し（.tbk の外。復元の既定の置き場所） |
| `expected.json` | 照合する値（仕訳の件数と内容のハッシュ、会計年度ごとの試算表、表ごとの行数） |
