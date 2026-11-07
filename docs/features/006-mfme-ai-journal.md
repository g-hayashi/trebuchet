# 明細の取込と AI 仕訳（006）

仕様: `specs/006-mfme-ai-journal/`。推定の順序、AI の呼び出し、送る情報のマスク、候補の保存と承認、評価: [ADR 0009](../adr/0009-ai-journal-suggestions.md)。

| 層 | 場所 |
|---|---|
| 入出力の型（明細・口座・候補・ルール・評価、AI の出力 `AiSuggestion`） | `packages/schema/src/statements.ts`、`ai.ts` |
| 業務ルール（表の読み取り（007 で `paste.ts` を置き換えた。[007](007-generic-statement-import.md)）、安定したキー、正規化、仕訳の形、振替、既存の仕訳との照合、ルール、マスクと送信の内容、プロンプト、評価、状態の導出） | `packages/domain/src/statements/`（`table.ts`、`columns.ts`、`keys.ts`、`normalize.ts`、`journal-shape.ts`、`transfer.ts`、`match-existing.ts`、`rules.ts`、`mask.ts`、`prompt.ts`、`evals.ts`、`status.ts`） |
| ユースケース | `packages/domain/src/usecases/statements.ts`、`statement-candidates.ts`、`statement-approval.ts`、`inference.ts`、`inference-rules.ts`（評価のユースケース `evals.ts` は 011 で消した） |
| 永続化（取込の回・明細・候補・結びつき・ルール・操作の記録、registry の AI 設定） | `packages/db/src/statement-repository.ts`、`ai-settings-repository.ts` |
| HTTP | `apps/server/src/routes/statements.ts`、`ai-settings.ts` |
| server の部品 | `apps/server/src/lib/`（`ai-client.ts`、`ai-runtime.ts`、`fm-server.ts`） |
| 画面 | `apps/web/src/features/statements/`、`features/ai-settings/`、`apps/web/src/routes/e/$entityId/statements/`、`apps/web/src/routes/settings/ai.tsx` |
| E2E・性能 | `apps/web/e2e/statements.spec.ts`、`scripts/bench-statements.ts` |

- **AI へ送る情報は `buildAiPayload`（`mask.ts`）を通したものだけ**（006/R11、INV-45。010 の証憑の画像は例外。専用の `ReceiptReader` を通す。[010](010-receipts.md)）。端末内も外部も、評価も同じ `createAiSuggester`（`usecases/inference.ts`）を共有する。口座の名前・メモ・取引先の一覧は送らない。AI の出力は `AiSuggestion`（Zod）で検証し、形に合わない・一覧にないコードは「候補なし」にする（INV-46）。
- **`inferWithAi` は 読む → AI を呼ぶ（UnitOfWork の外）→ 書く の 3 段**（006/R8）。AI の呼び出し（遅い、外部に出る）をトランザクションの中に入れない。取込と承認は 1 つの `StatementUnitOfWork` の中で書く（INV-47）。
- **端末内のモデルは `fm serve`**（モデル名 `system`。`stream` は送らない（`stream: false` には応答しない。省くと SSE で返り、`ai-client.ts` が読み分ける）。ポート `TREBUCHET_FM_PORT`、既定 18790。明細・仕訳の推定には `response_format` を送らない（`responseFormat: false`。json_schema つきだと応答しない。2026-11-04）。最初の推定で起動し、server の終了で止める（006/R10）。外部の AI の API キーはキーチェーン（004 と同じ `SecretStore`）に置く。`ai_settings` は registry の表で、バックアップに含めない（006/R12）。
- **端末内の AI は非推奨で、既定は無効**（2026-11-07 利用者の判断。全項目一致が 0% で、外部の AI を既定の使い方にする）。`ai_settings.local_enabled` の既定と `DEFAULT_AI_SETTINGS.localEnabled` は 0／false（registry の `0004_ai_local_default_off`）。外部の AI は接続先・モデルの入力が要るので既定で有効にしない。設定の画面に「非推奨」と理由を示す。有効にすれば今までどおり使える。端末内を無効にすると列の案（007。端末内だけ）も出ない。
- **AI の設定の必須項目の検査**（外部を有効にするのに URL・モデル・API キーがそろっていなければ 422 `AI_NOT_CONFIGURED`）は `apps/server/src/routes/ai-settings.ts` にある。帳簿の業務ルールではなく、端末の設定値の検査なので server に置く。
- **銀行の自動連携は実装しない**（2026-11-02 利用者の判断。API でも画面からの取得でも作らない。MF ME の画面からの取得は 2026-10-26 に取りやめ済み）。取込は貼り付けとファイル（007）。`apps/server` は Playwright に依存しない。
- **アプリの中の評価（実行・履歴の保存・表示。表 `eval_runs`、`lib/jobs.ts`、`JOB_RUNNING`）は 011 で消した**（011/R10）。評価はスクリプト `pnpm eval:statements`（CI に含まれない。規則は[011](011-ui-overhaul.md)）。採点の純関数 `statements/evals.ts` は残る。server の差し替えは `createApp({ ai: { fetch, secrets, settings, fm } })`。
- **テストは `fm`・外部の AI を呼ばない**。偽の `SuggestionProvider`（domain）と偽の `fetch`（server）を使う。
- **明細の承認だけが仕訳を作る**（INV-41）。仕訳の `source` は `statement`（通常どおり訂正・取消できる）。明細の状態は保存せず、結びつき・除外・仕訳の状態から導く（006/R15）。
- **実環境の確認（貼り付けの形、`fm serve`）の結果は、値・口座名・摘要を書かない**。形だけを記録する（quickstart §3）。

