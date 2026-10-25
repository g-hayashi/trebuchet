# Data Model: 明細の取込と AI 仕訳

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Date**: 2026-10-25

事業体の DB（tenant）に 10 表を足す（`packages/db/src/schema/tenant.ts`）。マイグレーションは `packages/db/drizzle/tenant/0007_statements.sql`（`drizzle-kit generate --name statements --config drizzle.tenant.config.ts`、生成後に各表の `);` を `) STRICT;` に置き換える）と `0008_statements_integrity.sql`（`--custom --name statements_integrity`。§3 のトリガー・部分 UNIQUE）。registry に 1 表（`0003_ai_settings.sql`）。金額は円の整数（明細の金額は符号つき: 入金が正、出金が負）、日付は `YYYY-MM-DD`、日時は ISO 8601（UTC）、主キーは UUIDv7、確信度は 0〜100 の整数。

## 1. 表（tenant）

### 1.1 `statement_accounts`（FR-003。R4）

| 列 | 型 | 制約 |
|---|---|---|
| id | text | PK |
| name | text | NOT NULL、UNIQUE（MF ME の保有金融機関の名前） |
| usage | text | `business`・`mixed`・`private` |
| kind | text | `bank`・`card`・`cash`・`other`（AI に送る口座の種類） |
| account_id | text | FK accounts。`usage = private` なら NULL、それ以外は NOT NULL（CHECK） |
| sub_account_id | text | FK sub_accounts、NULL 可 |
| created_at, updated_at | text | |

### 1.2 `statement_batches`（FR-002, FR-007。R14）

| 列 | 型 | 制約 |
|---|---|---|
| id | text | PK |
| origin | text | `paste`・`mfme_fetch` |
| input_sha256 | text | NOT NULL（貼り付けのテキスト、または取得した行の正規化の JSON） |
| period_from, period_to | text | 明細の日付の範囲 |
| count_new, count_existing, count_unreadable | integer | ≥ 0 |
| created_at | text | |

### 1.3 `statements`（FR-004〜FR-006。R2・R3・R15）

| 列 | 型 | 制約 |
|---|---|---|
| id | text | PK |
| batch_id | text | FK statement_batches、NOT NULL |
| statement_account_id | text | FK statement_accounts、NOT NULL |
| stable_key | text | NOT NULL、UNIQUE（INV-40） |
| external_id | text | NULL 可（自動取得で読めた取引の ID）。部分 UNIQUE（`external_id IS NOT NULL`） |
| date | text | NOT NULL |
| amount | integer | NOT NULL、≠ 0 は求めない（0 円は候補を作らない。Edge Cases）、絶対値 < 1e12 |
| content | text | NOT NULL（元の内容） |
| normalized_content | text | NOT NULL（R9） |
| category_major, category_minor | text | NULL 可（MF ME の大項目・中項目） |
| memo | text | NULL 可（MF ME のメモ。AI には送らない） |
| transfer_flag | integer | 0・1（MF ME の振替の印） |
| changed_json | text | NULL 可（`external_id` が同じで内容が違う取込があったときの新しい内容。FR-005） |
| changed_ack_at | text | NULL 可（「確認した」の日時。H5） |
| excluded_at, excluded_reason | text | NULL 可（FR-017） |
| created_at | text | |

更新できるのは `changed_json`・`changed_ack_at`（「確認した」の日時。NULL 可）・`excluded_at`・`excluded_reason` だけ（トリガー）。削除しない。新しい内容の取込で `changed_json` を書き換えるとき `changed_ack_at` を NULL に戻す。

### 1.4 `statement_candidates`（FR-012, FR-013。R8）

| 列 | 型 | 制約 |
|---|---|---|
| statement_id | text | PK、FK statements |
| method | text | `match`・`transfer`・`rule`・`local_ai`・`external_ai`・`none` |
| purpose | text | `business`・`private`、`none` のとき NULL |
| confidence | integer | 0〜100、`none` のとき NULL |
| reason | text | 根拠（`rule` は「過去の同じ内容の明細 n 件と一致」など） |
| draft_json | text | 仕訳の案（001 の `JournalDraft` の形）、`match` は `{ journalId, lineId }`、`none` は NULL |
| rule_id | text | `rule` のとき FK inference_rules |
| model | text | AI のとき接続先のモデル名 |
| created_at | text | |

候補は作り直しで置き換える（履歴は評価の `eval_runs` と監査が持つ）。

### 1.5 `statement_links`（FR-020, FR-021, FR-021a。R6・R7・R15）

| 列 | 型 | 制約 |
|---|---|---|
| id | text | PK |
| statement_id | text | FK statements、NOT NULL |
| journal_id | text | FK journals、NOT NULL |
| journal_line_id | text | FK journal_lines、NOT NULL（明細の口座の行。私用の口座の明細は相手の事業主貸・事業主借の行） |
| kind | text | `created`・`matched` |
| created_at | text | |
| revoked_at, revoked_reason | text | NULL 可 |

部分 UNIQUE: `(statement_id) WHERE revoked_at IS NULL`、`(journal_line_id) WHERE revoked_at IS NULL`（INV-43）。更新できるのは `revoked_*` だけ。承認のときに、その明細の有効な結びつきの仕訳が取消済み（訂正されていない）なら、先に `revoked_at` を書いてから新しい結びつきを作る（同じ UnitOfWork）。既存の仕訳との結びつき（`matched`）は利用者が外せる（`revoked_reason` 必須）。

### 1.6 `inference_rules`（FR-022〜FR-024。R9）

| 列 | 型 | 制約 |
|---|---|---|
| id | text | PK |
| normalized_content | text | NOT NULL |
| statement_account_id | text | FK、NULL = すべての口座。UNIQUE（`normalized_content`, `ifnull(statement_account_id, '')`） |
| counter_account_id | text | FK accounts、NOT NULL |
| counter_sub_account_id, partner_id | text | NULL 可 |
| tax_category | text | `TaxCategoryCode` |
| purpose | text | `business`・`private` |
| description_template | text | NULL 可（摘要。NULL なら明細の内容） |
| hits, overrides | integer | ≥ 0 |
| status | text | `active`・`paused` |
| origin | text | `approval`・`seed`（初期作成） |
| created_at, updated_at | text | |

### 1.7 `inference_rule_history`（FR-022。追記のみ）

`id`、`rule_id`、`action`（`create`・`update`・`pause`・`resume`・`edit`）、`before_json`、`after_json`、`statement_id`（承認が起点のとき）、`at`。

### 1.8 `statement_settings`（1 行。R12）

`bulk_threshold`（0〜100、既定 80）、`external_threshold`（0〜100、既定 60）、`updated_at`。

### 1.9 `eval_runs`（FR-029。R17）

`id`、`split_date`、`include_ai`（0・1）、`sample_count`、`result_json`（項目ごとの一致率、方法ごとの件数・一致率。率は千分率の整数）、`models_json`（使ったモデル名）、`created_at`。

### 1.10 `statement_audit_log`（R18。追記のみ）

001 の `audit_log` と同じ列の形（`auditEntry<対象, 操作>`）。対象は `statement_batch`・`statement`・`statement_link`・`statement_account`・`inference_rule`・`statement_settings`。

## 2. 表（registry）

### 2.1 `ai_settings`（1 行。R12。バックアップから除外）

`local_enabled`（0・1、既定 1）、`external_enabled`（0・1、既定 0）、`external_base_url`、`external_model`（NULL 可。`external_enabled = 1` なら NOT NULL を CHECK）、`updated_at`。API キーはキーチェーン（`trebuchet-ai-api-key`）で、表に置かない。

## 3. 既存の表の変更とトリガー（`0008_statements_integrity.sql`）

- `journals_source_insert`・`journals_source_update` を DROP して、`statement` を含む値で作り直す（R16）
- `statements`: 削除の禁止、`changed_json`・`excluded_*` 以外の更新の禁止
- `statement_links`・`inference_rule_history`・`statement_audit_log`・`statement_batches`: 削除の禁止。`statement_links` は `revoked_*` 以外の更新の禁止、ほかの3表は更新の禁止
- `statement_links` の部分 UNIQUE 2 つ（§1.5）
- `journal_line_id` の行が `journal_id` の仕訳のものであることを INSERT のトリガーで検査

## 4. 状態遷移

- **明細**（導出。R15）: `unprocessed` →（承認で仕訳を作る／既存の仕訳に結ぶ）→ `registered` →（仕訳を 001 で取り消す）→ `unprocessed`。`registered` の仕訳を 001 で訂正しても `registered`。`unprocessed` →（除外）→ `excluded` →（除外の取消）→ `unprocessed`。`changed` は並ぶ印で、`changed_json` があり `changed_ack_at` が NULL のとき立つ。利用者が「確認した」で `changed_ack_at` を書き（監査にも記録）、印を消す
- **ルール**: `active` ⇄ `paused`。承認で `hits`・`overrides` と内容が変わる

## 5. 不変条件（INV-1〜39 に追加。fast-check で検証。R19）

- **INV-40**: 事業体の中で `stable_key` は重複しない。同じ入力（貼り付けのテキストと年、または取得の行）を何回取り込んでも、2 回目以降に加わる明細は 0 件。行の順を入れ替えても加わる明細の集合は同じ
- **INV-41**: 明細の取込・候補の作成・除外・除外の取消・ルールの変更のどんな列の後も、仕訳帳と試算表は変わらない（承認だけが仕訳を作る。SC-003）
- **INV-42**: `created` の結びつきの仕訳は、R5 の表どおりの形で、明細の口座の行（`journal_line_id`）の金額 = |明細の金額|、向きは入金なら借方・出金なら貸方（`private` の口座は相手の事業主貸・事業主借の行で同じ規則）。貸借は一致する
- **INV-43**: 有効な結びつきは、明細ごとに高々 1 件、仕訳の行ごとに高々 1 件。振替の対は同じ仕訳の別々の行に結びつく
- **INV-44**: 明細の状態は、結びつき・除外・仕訳の状態だけで決まる。仕訳の取消で `unprocessed` に戻り、訂正では `registered` のまま
- **INV-45**: 任意の明細・口座の名前・メモから作った AI への送信の内容（`buildAiPayload`）のうち、マスクした内容の項目に4 桁以上の数字の並びと振込の名義が含まれず、送信の内容のどこにも口座の名前・メモが含まれない（日付・金額の項目は数字の検査の対象外）（SC-005）
- **INV-46**: AI の出力から作る候補は、`AiSuggestion` の検証を通り、科目のコードが相手になりうる有効な科目、税区分が既知のコードのものだけ。それ以外は `none`
- **INV-47**: 取込（回と明細）と承認（仕訳と結びつき、ルールの更新）は全部か無か。任意の段階の失敗の後、明細が `registered` ⇔ 有効な結びつきの仕訳がある

## 6. ドメインの関数とポート（tasks で参照する名前）

- 純関数: `parseMfmePaste(text, year)`（`{ rows: PastedRow[], unreadable: { line, reason }[] }`。R2）、`stableKey(row, occurrence)`・`assignKeys(rows)`（R3）、`normalizeContent`（R9）、`journalShape({ statement, account, purpose, counter, accounts })`（R5）、`findTransferPair`（R6）、`matchExistingJournal(statement, account, journals, linkedLineIds)`（R7）、`ruleFor(statement, rules)`・`ruleConfidence(rule)`・`learnRule(rule | null, approval)`・`seedRules(journals, accounts)`（R9）、`maskContent`・`buildAiPayload(statement, account)`（R11）、`buildPrompt(payload, accounts, taxCategories)`・`parseSuggestion(raw, accounts)`（R10）、`statementStatus(statement, links, journals)`（R15）、`planStatementImport(rows, existing, accounts)`（新規・取込済み・変更あり・重複の疑い・未対応の口座。R3・R14）、`evaluate(samples, splitDate, infer)`（R17）
- ポート（`ports.ts`）: `StatementStore`（同期。口座・回・明細・候補・結びつき・ルール・履歴・設定・評価の読み書き、`appendStatementAudit`）、`StatementUnitOfWork`（`{ ledger, masters, statements }`）、`SuggestionProvider`（非同期。`suggest(payload, context): Promise<Result<AiSuggestionRaw>>`、`available(): Promise<boolean>`。端末内・外部の2つを渡す）
- ユースケース: `saveStatementAccount`、`previewStatementImport`、`commitStatementImport`、`buildCandidates(deps, statementIds)`（match → transfer → rule。同期）、`inferWithAi(deps, statementIds)`（非同期。R8）、`approveCandidate(deps, statementId, edited?)`（仕訳の登録または結びつけ ＋ ルールの学習を1つの UnitOfWork で）、`approveBulk(deps, threshold)`、`excludeStatement`・`unexcludeStatement`、`acknowledgeChange`、`seedRulesFromJournals`、`updateRule`・`pauseRule`・`resumeRule`、`runEvaluation`
- 001 の変更: `JOURNAL_SOURCES` に `statement`（R16）。`createJournal` は変えない（`options.source` を使う）
