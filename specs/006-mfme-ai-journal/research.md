# Research: 明細の取込と AI 仕訳

**Feature**: [spec.md](./spec.md) | **Date**: 2026-10-25

既存の構成で、方針に関わる事実（コードで確かめた）:

- 仕訳の出所の正本は `packages/schema/src/journals.ts` の `JOURNAL_SOURCES`（`manual`・`import_freee`・`invoice`・`payment`・`recurring`）。DB の検査は `0006_invoicing_integrity.sql` の手書きのトリガー `journals_source_insert`・`journals_source_update`（値を SQL に直書き）
- `createJournal(deps, draft, { source? })`。`JOURNAL_LINKED` で守るのは `invoice`・`payment` だけ（`isLinkedSource`）。`recurring` は通常どおり訂正・取消できる
- 002 の取込は「プレビュー → 確定（`expected` の照合）」の2段。冪等は参照の表の部分 UNIQUE（`revoked_at IS NULL`）
- `SecretStore`（`get`・`set`・`delete`）とキーチェーンの実装（`apps/server/src/lib/keychain.ts`。`security -i` の標準入力）がある
- 端末に結びつく設定 `app_settings`（registry）は key の CHECK が 7 値に固定。バックアップから除外される
- 科目のコード: 普通預金 `1020`、未払金 `2020`、事業主借 `3010`、事業主貸 `3090`（`seed/accounts.individual.ts`）。`findAccountByCode`（005 の `journal-drafts.ts`）で引く
- `journal_lines` は `id` を持つ（明細と仕訳の行を結びつけられる）
- 子プロセスは keychain の `spawn` だけ。Playwright は web の devDependency だけ
- `fm`（Apple Foundation Models CLI）は `/usr/bin/fm`。`fm serve` が Chat Completions 互換の API（`POST /v1/chat/completions`、`GET /health`）を出し、`fm available` で使えるかを確かめられる。`fm respond --schema` で構造化の出力もできる
- 最新の番号: tenant のマイグレーション 0006、registry 0002、INV-39、ADR 0008

## R1. 層の配置

- **Decision**: AGENTS.md の 002〜005 の表に合わせる
  - schema: `packages/schema/src/statements.ts`（明細・口座・候補・ルール・評価の入出力）、`ai.ts`（AI の出力の Zod 定義 `AiSuggestion`）
  - domain: `packages/domain/src/statements/`（`paste.ts`・`keys.ts`・`normalize.ts`・`journal-shape.ts`・`transfer.ts`・`match-existing.ts`・`rules.ts`・`mask.ts`・`prompt.ts`・`evals.ts`・`status.ts`）、ユースケース `usecases/statements.ts`・`usecases/inference.ts`
  - db: `packages/db/src/statement-repository.ts`（`DrizzleStatementStore`・`DrizzleStatementUnitOfWork`）、registry の `ai-settings-repository.ts`
  - server: `routes/statements.ts`、`lib/ai-client.ts`（OpenAI 互換の呼び出し）、`lib/fm-server.ts`（`fm serve` の起動と停止）、`lib/mfme/`（`fetcher.ts`・`dom.ts`。Playwright）、`lib/jobs.ts`（取得・評価の進行）
  - web: `features/statements/`、`routes/e/$entityId/statements/`、`routes/settings/ai.tsx`
- **Rationale**: 依存の向きを変えない。判定と計算は純関数（Constitution VII）。外部とのやりとり（AI、ブラウザ、子プロセス）は server に閉じる
- **Alternatives considered**: AI の呼び出しを domain のポートにする案 → 推定の順序と候補の組み立ては domain に置き、呼び出しだけを `SuggestionProvider` のポートにする（domain のテストは偽物で済む）

## R2. 貼り付けの形式

- **Decision**: MF ME の「入出金」の表をブラウザでコピーした、タブ区切りのテキストを読む。列は見出しの名前で対応づける（`日付`・`内容`・`金額（円）`・`保有金融機関`・`大項目`・`中項目`・`メモ`・`振替`。`計算対象`・`削除` などは読まない）。見出しの行がなければ、この順の既定の並びとみなす。日付は `MM/DD(曜)` で年を持たないため、貼り付けの画面で「対象の年」を選ぶ（既定は今日の年）。読めない行（合計、空行、別の画面の文字）は理由つきで返し、読めた行だけを取り込める。必須の列（日付・内容・金額・保有金融機関）がそろわなければ `STATEMENT_PASTE_UNREADABLE` で何も加えない
- **Rationale**: 無料版は CSV を書き出せない（spec の Clarifications）。1回の貼り付けに複数の口座（保有金融機関）が混ざるので、口座は行ごとに読む。`振替` の印と `大項目`・`中項目` は推定の手がかりになる
- **未確定**: 実際の列の名前・並び・金額の書式（`-1,234` など）は、利用者が実データで確かめる（quickstart §3。実データはリポジトリに書かない）。違っていれば `paste.ts` の対応表と合成のフィクスチャ（`packages/domain/test/fixtures/mfme/`）を直す。列の対応は 1 か所（`paste.ts` の `MFME_COLUMNS`）に置く
- **Alternatives considered**: HTML（リッチテキスト）として貼り付けを受ける → ブラウザごとに形が違い、web で読む必要が出る。テキストで足りる

## R3. 安定したキーと重複

- **Decision**: 明細のキー = `sha256(口座の名前 | 日付 | 金額 | 正規化した内容 | n)`。`n` は同じ口座・日付・金額・内容の行の中での出現の順（0 から）。取込元（貼り付け・自動取得）によらず同じ式にするので、同じ取引を両方から取り込んでも1件になる。自動取得で MF ME の取引の ID が読めたら `external_id` に持ち、同じ `external_id` で内容が違えば「変更あり」（FR-005）。キーが違っても口座・金額・内容が同じで日付が 3 日以内、または口座・日付・内容が同じで金額が違う明細は「重複の疑い」（FR-006）
- **Rationale**: 貼り付けは ID を持たない（spec FR-005 の注）。出現の順で、同じ日の同じ店で同じ額を2回払った場合も2件に分けられる
- **制約**: 1日の途中までだけを貼り付けると `n` がずれうる。プレビューの「重複の疑い」で利用者が除外する（Edge Cases）

## R4. 取込元の口座と用途

- **Decision**: `statement_accounts` に、保有金融機関の名前（一意）・用途（`business`・`mixed`・`private`）・帳簿の科目と補助科目を持つ。`business`・`mixed` は帳簿の科目が必須、`private` は科目を持たない（帳簿の外の口座）。`mixed` と `business` の違いは推定の既定（`business` は事業、`mixed` は判定に任せる）だけ
- **Rationale**: 私用の口座の取引は帳簿に口座がなく、事業分は事業主借、私用分は除外になる（R5）。用途の変更は未処理の明細の候補だけを作り直す（spec Edge Cases）

## R5. 用途と判定から仕訳の形を決める（FR-016）

- **Decision**: 純関数 `journalShape(statement, account, judgment, counter)`。`a` = 明細の口座の科目（補助科目つき）、`c` = 相手の科目、`X` = 金額の絶対値

  | 口座の用途 | 向き | 判定 | 仕訳 |
  |---|---|---|---|
  | business・mixed | 出金 | 事業 | 借 `c` / 貸 `a` |
  | business・mixed | 出金 | 私用 | 借 事業主貸 / 貸 `a` |
  | business・mixed | 入金 | 事業 | 借 `a` / 貸 `c` |
  | business・mixed | 入金 | 私用 | 借 `a` / 貸 事業主借 |
  | private | 出金 | 事業 | 借 `c` / 貸 事業主借 |
  | private | 入金 | 事業 | 借 事業主貸 / 貸 `c` |
  | private | どちらも | 私用 | 除外（仕訳なし） |

  カードの返金（未払金の口座への入金）は、表の「入金・事業」で `c` を元の経費の科目にする（経費の取消）。金額は整数のまま、税額は 001 の `computeInclusiveTax`
- **Rationale**: 帳簿の口座の残高を明細と合わせ、私用の資金の出入りは事業主貸・事業主借に寄せる（青色申告の慣行）
- 事業主貸・事業主借・未払金・普通預金はコードで引く（定数 `STATEMENT_ACCOUNT_CODES`。005/R10 と同じ方針）

## R6. 振替（カードの引落・口座間の移動。FR-019）

- **Decision**: 帳簿の2つの口座の間の移動は、借 受け側 / 貸 出し側 の1仕訳。カードの引落は 借 未払金（カードの補助科目）/ 貸 普通預金。対になる明細（反対の口座に、同じ金額で逆向き、日付が 7 日以内）が取り込み済みなら、両方を同じ仕訳の別々の行に結びつける。対がなければ、どのカードの引落かをルール（R9）か `振替` の印と内容で推定する。片方が `private` の口座なら R5 の表（事業主貸・事業主借）になる
- **Rationale**: 引落は銀行とカードの両方の明細に現れうるが、仕訳は1件（spec US2-8）

## R7. 既存の仕訳との照合（FR-021a）

- **Decision**: 候補の作成の最初に、明細の口座の科目・補助科目に、同じ向き・同じ金額の行を持つ有効な仕訳で、日付の差が 7 日以内、まだ明細に結びついていない行を探す。見つかれば「既存の仕訳と結びつける」候補（方法 `match`、確信度は日付の差で下げる）。承認すると `statement_links` に `kind = matched` で結ぶだけで、仕訳は作らない。1つの行に結びつく明細は高々1件（部分 UNIQUE）
- **Rationale**: 定期仕訳（005）・請求の入金（005）・手入力で登録済みの取引を二重に計上しない

## R8. 推定の順序と候補の保存

- **Decision**: 順序は 既存の仕訳 → 振替の対 → ルール → 端末内の AI → 外部の AI（FR-013, FR-027）。前の段で候補ができれば後の段を呼ばない。ただし端末内の AI の確信度が `external_threshold`（既定 60）より低く、外部の AI が有効なら外部を呼ぶ。端末内の AI を呼べないときは、外部が有効ならルールに一致しない明細を外部へ送る。候補は `statement_candidates` に保存し（AI の呼び出しは遅く、評価にも使う）、口座の対応・ルールの変更、または利用者の「作り直す」で作り直す。AI の推定は明細 10 件ずつの要求（`POST /statements/infer`）を web が繰り返して進捗を出す（サーバーに長い処理を持たせない）
- **Rationale**: SC-006（500 件で 5 秒）は AI を除いた時間。AI の呼び出しは1件ずつ（`fm` の文脈は短い）

## R9. 推定のルール（US3）

- **Decision**:
  - 内容の正規化 `normalizeContent`: NFKC → 大文字 → 空白を除く → 3 桁以上の数字の並びを `#` に置き換える
  - ルールのキー = （正規化した内容, 取込元の口座 | すべての口座）。同じ口座のルールを優先する
  - ルールが持つもの: 相手の科目・補助科目・税区分・取引先・判定（事業／私用）・摘要の型、適用回数 `hits`、上書きされた回数 `overrides`、状態（`active`・`paused`）
  - 確信度 = `min(95, 50 + 10 × hits) − 20 × overrides`（0 未満は 0）。整数
  - 承認のたびに、承認した内容でルールを作るか直す。候補と違う内容で承認したら `overrides` を増やし、ルールを承認の内容に置き換える。変更は `inference_rule_history`（追記のみ）に残す
  - 初期作成（FR-023）: 有効な仕訳（`manual`・`import_freee`）で、現金・預金・未払金の行が1つと相手の行が1つのものを、行の摘要を内容とみなして集め、同じ正規化の内容で2件以上あり、最も多い組み合わせが 3/4 以上を占めるものだけをルールにする（口座は「すべて」）
- **Rationale**: 単純な完全一致で、説明できる根拠（「過去の同じ内容の明細 5 件と一致」）を出せる。部分一致・類似度は誤りの説明が難しいので AI に任せる
- **Alternatives considered**: 正規表現のルールを利用者が書く → YAGNI。編集はできるが、作るのは承認から

## R10. AI の呼び出し（FR-025〜FR-027）

- **Decision**: 端末内と外部の両方を、OpenAI 互換の Chat Completions（`POST {baseUrl}/v1/chat/completions`）で呼ぶ。依存は足さず `fetch` で呼ぶ
  - 端末内: server が最初の推定のときに `fm available` で確かめ、使えれば `fm serve --host 127.0.0.1 --port <TREBUCHET_FM_PORT、既定 18790>` を子プロセスで起動し、`/health` を待つ。server の終了で止める。使えなければ（Intel の Mac、Apple Intelligence が無効など）端末内の段を飛ばす
  - 外部: 接続先の URL・モデルは端末の設定（R12）、API キーはキーチェーン（キー `trebuchet-ai-api-key`）。URL は `https://` か `http://localhost`・`127.0.0.1` だけ
  - 要求: system に「勘定科目の一覧（コードと名前。相手になりうる科目だけ）、税区分のコード、出力の形」、user に明細1件（R11 の形）。`response_format: { type: "json_schema" }` を付けるが、付けられない接続先もあるので、出力は必ず `AiSuggestion`（Zod）で検証する: `{ accountCode, taxCategory, purpose: "business" | "private", confidence: 0〜100 の整数, reason: 200 字以内 }`。形に合わない・一覧にないコードは捨てて「候補なし」（INV-46）
  - 取引先は AI に推定させない（ルールだけ）。時間切れは端末内 30 秒、外部 60 秒
- **Rationale**: `fm serve` が同じ形の API を出すので、呼び出しの実装が1つで済む（利用者の指定「外部は OpenAI ベースの呼び出し」と一致）。`fm respond` を明細ごとに起動するよりモデルの読み込みが1回で済む
- **未確定**: `fm serve` が `response_format` を受けるか。quickstart §3 で確かめ、受けなければ指示文で JSON を求める（検証は同じ）

## R11. 送る情報とマスク（FR-028, SC-005）

- **Decision**: 送る情報は許可した項目だけで組み立てる（`buildAiPayload`）: 日付、金額、向き、マスクした内容、MF ME の大項目・中項目、口座の種類（銀行・カード・現金）と用途。口座の名前・メモ・明細の ID・取引先の一覧は送らない。内容のマスク `maskContent`: 4 桁以上の数字の並び → `####`、メールアドレス・電話番号の形 → `[連絡先]`、内容が振込・振替（`振込`・`ﾌﾘｺﾐ`・`フリコミ`・`振替`）で始まるときは、その後ろ（名義）を `[名義]` に置き換える。端末内の AI にも同じ形を送る（1つの関数で済む）
- **Rationale**: 憲法 III（口座番号・カード番号・個人の識別情報をマスク）。名義は振込に現れやすい個人名
- 検証: INV-45（任意の明細・口座の名前から作った送信の内容に、4 桁以上の数字・口座の名前・メモが含まれない）

## R12. AI の設定の置き場所

- **Decision**: 端末に結びつく接続の設定は registry の新しい表 `ai_settings`（1 行: `local_enabled`・`external_enabled`・`external_base_url`・`external_model`）。`app_settings` の key の CHECK を直すより表を足す方が移行が単純。バックアップから除外する（`EXCLUDED_REGISTRY_TABLES` に足す）。しきい値（まとめて承認 `bulk_threshold` 既定 80、外部へ送る `external_threshold` 既定 60）は事業体の `statement_settings`
- **Rationale**: API キー・接続先は端末のもので、復元先の Mac に持ち込まない（004 の方針と同じ）

## R13. MF ME からの取得（US4）

- **Decision**: `playwright`（実行時）を `apps/server` の dependencies に足す（2026-10-25 に利用者が承認）。ブラウザは Playwright の Chromium（`pnpm exec playwright install chromium`）。保存しない文脈（`browser.newContext()`。クッキー・パスワードを残さない。FR-009）で、見えるウィンドウを開き、ログインの画面へ移る。利用者がログインと2段階認証を済ませ、ホームの URL に着くのを最大 5 分待つ。その後、対象の月ごとに入出金の画面へ移り、表の行を読む（`lib/mfme/dom.ts`）。読んだ行は R2 の貼り付けと同じ型（`PastedRow`）にして、同じプレビューへ渡す。進行は `lib/jobs.ts` の in-memory のジョブ（同時に1つ）で、web が状態を取りにくる。失敗（形が違う、時間切れ、ウィンドウを閉じた）では何も加えない
- **未確定**: 画面の DOM（行・列の要素、取引の ID の有無、月の移り方）は後で解析する（利用者の指示）。セレクターは `dom.ts` の1か所に置き、合成の HTML（`page.setContent`）でテストする。解析の結果で `external_id` が取れるかを決める
- **Rationale**: 画面のボタンから使え（spec US4）、取り込みの経路は貼り付けと同じにする

## R14. 取込の確定（FR-002, FR-007）

- **Decision**: 002 と同じ2段。`POST /statements/imports/preview`（入力: 貼り付けのテキストと対象の年、または取得のジョブの ID）→ `POST /statements/imports`（同じ入力 ＋ `expected: { inputSha256, countNew }`）。確定の中でプレビューを作り直し、入力のハッシュか新規の件数が違えば `STATEMENT_PLAN_CHANGED`。1つの `StatementUnitOfWork` で、取込の回・明細を書く（全部か無か。INV-47）
- 未対応の口座（`statement_accounts` にない保有金融機関）があれば `STATEMENT_ACCOUNT_UNMAPPED`（`details.names`）

## R15. 状態は導出する

- **Decision**: 明細の状態は保存せず、結びつきと除外から導く（`statementStatus`）: 有効な結びつきの仕訳（訂正されていれば、`corrects` をたどった先の有効な仕訳）がある → `registered`、`excluded_at` がある → `excluded`、ほか → `unprocessed`。`changed`（変更あり）は `external_id` の内容の差の印で、ほかの状態と並ぶ
- **Rationale**: 001 の取消で明細が未処理に戻る（FR-021）のを、トリガーなしで満たす。訂正では登録済みのまま（INV-44）
- 結びつき `statement_links` は追記のみ。取り消すときは `revoked_at`（除外の取消・結びつきの付け直し）

## R16. 仕訳の出所 `statement`

- **Decision**: `JOURNAL_SOURCES` に `statement` を足し、`0008_statements_integrity.sql` でトリガー `journals_source_insert`・`journals_source_update` を DROP して新しい値の一覧で作り直す。`statement` の仕訳は通常どおり訂正・取消できる（`isLinkedSource` に入れない）
- **Rationale**: 005/R15 と同じ手順。SQLite はトリガーの ALTER がない

## R17. 評価（US5, FR-029, SC-004）

- **Decision**: 評価用のデータ = 登録済みの明細（`statement_links` の `created`・`matched`）と、その仕訳の相手の科目・税区分・取引先・判定（正解）。時点で分ける: 基準日より前の明細の承認からルールを作り、基準日以後の明細を推定して比べる（既定の基準日は今年の 1 月 1 日。SC-004 の「前年 → 当年」）。比べる項目ごとの一致率と、方法（ルール・端末内・外部・なし）ごとの件数・一致率を `eval_runs` に保存し、前回と並べる。AI を含めるかは実行のときに選ぶ（外部は設定で有効なときだけ）。実行は `lib/jobs.ts` のジョブ
- **Rationale**: 憲法 IV（AI の変更は Evals で比べる）。結果は帳簿の中に置き、リポジトリに書かない
- **Alternatives considered**: スクリプト（`pnpm eval:ai`）→ spec US5 は画面から実行する。CI では合成のデータで評価の関数だけをテストする

## R18. 監査

- **Decision**: 取込の回・除外とその取消・結びつき・ルールの変更・口座の対応の変更を `statement_audit_log`（追記のみ、`auditEntry`）に残す。仕訳の登録は 001 の `audit_log`
- **Rationale**: 憲法 II。ルールの履歴（`inference_rule_history`）は推定の根拠の再現に使い、監査の記録とは別に持つ

## R19. テスト

- **Decision**: 合成の貼り付けのテキスト（`packages/domain/test/fixtures/mfme/paste-*.txt`、作り方は同じ場所の `README.md`）と合成の HTML（`apps/server/test/fixtures/mfme/*.html`）。AI は偽の `SuggestionProvider`（domain）と偽の HTTP（server。`fetch` を差し替える）。`fm` と外部の AI、Playwright のブラウザの起動は CI で呼ばない（`dom.ts` のテストは `page.setContent` を使うので利用者の端末か、Chromium のある環境だけ。`describe.skipIf`）。性質テストは INV-40〜47
- 実データの確認（貼り付けの形、DOM、`fm serve`）は quickstart §3 で利用者が行い、結果の値を書かない

## R20. ADR

- **Decision**: ADR 0009「AI による仕訳の推定」（推定の順序、OpenAI 互換の呼び出しと `fm serve`、送る情報のマスク、候補の保存と承認、評価）を Polish で書く
