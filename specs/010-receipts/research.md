# Research: 証憑（領収書・レシート）の保存・読み取り・仕訳との紐づけ

**Feature**: [spec.md](./spec.md) | **Date**: 2026-11-02

既存のコードの参照は 2026-11-02 の `010-receipts` ブランチ（`bb6d65b`）による。番号は 010 の中だけで通す（他の機能は `008/D9`、`006/R11` の形で指す）。電子帳簿保存法の出典は国税庁の一次資料（各節に URL）。法令の文言は一問一答の引用で確かめ、取扱通達の本文は一問一答が引く番号（4-17・4-18・4-26・4-30）で示す（通達の本文そのものは開いていない）。

## R1. 電子帳簿保存法の要件と、この機能の位置づけ

- **出典**:
  - 国税庁「電子帳簿保存法一問一答【スキャナ保存関係】」令和8年7月 https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_03.pdf （以下「スキャナ一問一答」）
  - 国税庁「電子帳簿保存法一問一答【電子取引関係】」令和8年7月 https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/pdf/0026007-006_05.pdf （以下「電子取引一問一答」）
  - 一問一答の一覧 https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/4-3.htm 、規程のサンプル https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/0021006-031.htm
- **確かめたこと**（2026-11-02。PDF の本文のテキストで照合）:
  - **(a) タイムスタンプなしのスキャナ保存**: 代わりにできるのは「訂正削除履歴の残る（あるいは訂正削除できない）システム」で、かつ**入力期間内に入力したことを確認できる**場合だけ（スキャナ問31、規則2⑥二柱書）。その確認は「他者が提供するクラウドサーバ…がＮＴＰサーバと同期するなどにより…保存日時の証明が客観的に担保されている場合」（スキャナ問21、取扱通達4-26）。**自社システムについては「時刻証明機能を他社へ提供しているベンダー企業以外は自社システムによりタイムスタンプ付与の代替要件を満たすことはできない」**（スキャナ問32）。
  - **(b) 入力期間**: 早期入力方式は「速やかに」= おおむね7営業日以内（スキャナ問22、取扱通達4-17）。業務処理サイクル方式は「最長では、国税関係書類の受領等から２か月とおおむね７営業日以内」で、２か月は暦の上の２か月（4/21 受領なら 6/20 から おおむね7営業日）。業務処理サイクル方式は受領から入力までの事務の処理に関する規程を定めている場合に限る（スキャナ問11・問23、規則2⑥一ロ、取扱通達4-18）。期間を過ぎたものは紙のまま保存する（スキャナ問24）。
  - **(c) 解像度・階調**: 200dpi 以上、赤・緑・青それぞれ 256 階調以上（一般書類はグレースケール可）（スキャナ問10）。スマホ・デジカメは「読み取った書類の大きさと画素数を基に判断」し、A4 なら縦 2,338 × 横 1,654 画素（約 387 万画素）。縦横比が違う機器は縦横それぞれを満たす（スキャナ問26）。72dpi の表示は解像度を示さない（同）。令和5年度改正で解像度・階調・大きさの情報の**保存**は不要になったが、200dpi の要件は残る（スキャナ問27）。
  - **(d) 書類の区分**: 重要書類 = 決算関係書類以外の国税関係書類で、一般書類（資金や物の流れに直結しない書類。告示で列挙: 契約申込書、口座振替依頼書、検収書、注文書・見積書など）を除くもの（スキャナ問10・問47）。**領収書・レシートは重要書類**。
  - **(e) 検索**: ①取引年月日その他の日付・取引金額・取引先を条件に設定できる ②日付・金額は範囲指定 ③二以上の項目の組み合わせ（スキャナ問41、規則2⑥五）。ダウンロードの求めに応じられれば②③は不要、①は必要（スキャナ問41・問45）。**スキャナ保存に売上高による免除はない**。電子取引は、基準期間の売上高 5,000 万円以下でダウンロードの求めに応じられれば検索の要件は不要（電子取引問19）。金額は帳簿の処理（税込/税抜）に合わせるのが基本だが、書類の金額でもよい（スキャナ問43）。金額のない書類は空欄でよいが、空欄を条件に検索できること（スキャナ問44）。
  - **(f) 帳簿との相互関連性**: 重要書類（と過去分重要書類）に限る（スキャナ問10・問21 注）。保存時点で帳簿がなければ決算終了後遅滞なく満たせばよい（スキャナ問21 注）。電子取引には相互関連性の要件はない（電子取引問18 の表）。
  - **(g) 電子取引**: 真実性は 4 つのどれか: 一 タイムスタンプ付きの授受、二 授受後速やかに（規程があれば業務サイクル後速やかに）タイムスタンプ、三 訂正削除の記録が残る・できないシステムで**授受及び保存**、四 **訂正削除の防止に関する事務処理規程を定め、備付け、運用**（電子取引問18、規則4①）。メールで受け取ったものを訂正削除の記録が残るシステムに「保存だけ」しても三には当たらず、四の規程が要る（電子取引問43）。**自社開発のプログラムを使うなら「電子計算機処理システムの概要を記載した書類」の備付けも要る**（電子取引問18、規則2②一イ）。規程のひな形: 法人の例 https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/word/0021006-031_d.docx 、**個人の例 https://www.nta.go.jp/law/joho-zeikaishaku/sonota/jirei/word/0021006-031_e.docx** （電子取引問33 に法人の例の全文）。
  - ヴァージョン管理の 4 条件（スキャナ問33）: ①読み取ったデータは必ず初版として保存 ②更新は最新の版だけ ③削除は論理的に行い、全ての版と訂正前の内容を確認できる ④削除したデータも検索できる。
- **Decision**:
  1. **スキャナ保存（紙の書類を撮影したもの）は、この機能だけでは紙の代わりにならない**。自作のローカルのアプリは問32 により「入力期間内の保存の確認」でタイムスタンプに代えられず、spec の前提（タイムスタンプなしで、訂正削除の履歴と規程で満たす）は成り立たない。この機能では、撮影した証憑を「紙の原本を保存したうえでの写し」（法4③後段の電子データ）として扱い、**紙の原本は捨てない**運用を事務処理規程（R19）と画面の案内に書く。spec への差し戻し（plan の「spec への差し戻し」D1）として利用者の判断を求める
  2. **電子取引（PDF・画像のデータで受け取ったもの）は、規則4①四（事務処理規程）で真実性を満たす**。アプリの追記のみの履歴（R7）は規程の運用を裏づける。可視性（見読、検索、システム概要書）はアプリと文書で満たす
  3. スキャナ保存の要件（入力期間、解像度、階調、相互関連性）は、将来タイムスタンプを足したときにそのまま効くよう、判定と表示は spec のとおり作る（FR-022。ただし保存を拒まない警告のまま）
  4. 証憑の区分は spec の 2 つ（`paper_scan` / `electronic`）のまま。重要書類・一般書類は分けず、紙を撮影したものはすべて重要書類として扱う（領収書・レシートは重要書類。一般書類のグレースケール可や適時入力は使わない）
- **Rationale**: 一次資料の明文（問32）に反する前提で作ると、利用者が紙を捨てて要件違反（紙のまま保存すべきもの、問24）になる。紙を保存する運用なら、アプリ側の要件は電子取引の分と使い勝手だけになる
- **Alternatives**（利用者の判断。plan の Q1）:
  - **(B) 総務大臣が認定する時刻認証業務のタイムスタンプを付ける**（RFC 3161。送るのはハッシュだけ）: 有料の契約、外部への送信、応答（ASN.1/CMS）の検証が要る。検証の実装は依存の追加（例 `pkijs`）か自前の DER の読み取りになり、利用者の承認が要る。この機能では作らず、後の機能の候補にする
  - **(C) 他社のクラウドの証憑の保存サービスを使う**: Constitution III（ローカルファースト）に反する
  - **前提のまま進める**: 問32 に反する。採らない

## R2. 入力期間の判定

- **Decision**: 区分が `paper_scan` の証憑だけ、**業務処理サイクル方式の最長**で期限を求め、受領日時（アプリが受け取った日時）が期限を過ぎていれば警告 `INPUT_PERIOD_EXCEEDED` を出す（保存は拒まない、FR-022）
  - 起算日 = 取引年月日（紙の領収書・レシートは受け取った日 ≈ 取引の日。受領日を別に入れる欄は作らない）
  - 期限 = `addBusinessDays(addDays(addMonthsToDate(取引年月日, M), -1), N)`。M = `RECEIPT_INPUT_CYCLE_MONTHS`（2）、N = `RECEIPT_INPUT_GRACE_BUSINESS_DAYS`（7）。問23 の例（4/21 受領 → 2 か月は 6/20 まで）に合わせ、M か月後の前日を周期の末日とし、そこから N 営業日。`addMonthsToDate`（日付に月を足し、日は月末に丸める）と `addBusinessDays` は `packages/domain/src/dates.ts` に足す（今の `addMonths` は `YYYY-MM` 用）。営業日は土日を除く（祝日は除かない＝期限が早めに出る。「おおむね」の範囲として保守的）
  - 判定: 受領日時の日付 > 期限 なら警告。取引年月日が未入力なら判定しない。**比べるのは受領日時（アプリへの保存の日時）で、取引年月日を後から入れた日ではない**（A1）
  - **タイムゾーンは `Asia/Tokyo` に固定**する。受領日時（UTC の ISO 8601）から日付を取る `dateOf(iso): string` は domain に直接書かず（`Date`・`Intl` を使わない）、`ReceiptDeps.dateOf` として server が作って渡す（`todayOf(clock)` と同じ `Asia/Tokyo` の変換。contracts/domain-module.md §3）。純関数 `receiptWarnings` は日付に直した `receivedDate` を受け取る（D: §2）。日付の境目（UTC 15:00）を挟むテストを T012・T016 に置く
  - 差し替え（R7）の後も、最初の受領日時で判定する（問30 の再読み取りの扱いは、タイムスタンプを使わないこの機能では判定に入れない）
- **値の置き場所**: M・N は Constitution VI に従い `tax_parameters` に適用期間・出典つきで持つ（R20 の 4 つの key）。`effective_from` は 2024-01-01（令和5年度改正後の要件の適用。スキャナ問66）、出典はスキャナ一問一答の URL
- **Rationale**: 業務処理サイクル方式は規程が要るが、事務処理規程（R19）に周期を書けば使える。早期入力方式（7 営業日）だと、外出先で撮って後から Mac で入力する使い方の大半が警告になる。祝日の表を持たないのは YAGNI（警告だけで、保存は拒まない）
- **Alternatives**: 早期入力方式で判定 → 警告が多すぎる。事業体ごとに方式を選ぶ設定 → 今は利用者が 1 人で、R1 の結論では紙を保存するため法的な効果がない。祝日の表を持つ → 内閣府の祝日の表の取込が要る

## R3. 解像度・階調の目安

- **Decision**: 区分が `paper_scan` の画像（JPEG・HEIC・PNG）だけ、追加・差し替えのときに画素数と色を調べ（R12 の `probe`）、次の警告を出す（保存は拒まない）
  - `RESOLUTION_BELOW_GUIDE`: 長辺 < `RECEIPT_SCAN_MIN_LONG_PX`（2,338）または短辺 < `RECEIPT_SCAN_MIN_SHORT_PX`（1,654）。A4 の書類を 200dpi で読み取る目安（スキャナ問26）。メッセージに「A4 の書類の目安。小さな書類なら 200dpi を満たすこともある」と書く
  - `NOT_FULL_COLOR`: 色空間が RGB でない、または 1 色あたり 8 ビット未満（スキャナ問26 の「Bits Per Sample 8 8 8」）
  - 調べられない（PDF、変換器が使えない）ときは警告を出さず、`width`・`height`・`fullColor` を NULL にする
- **Rationale**: アプリは紙の大きさを知らないので、一次資料が示す唯一の数値（A4）を目安にする。利用者の端末（iPhone 12MP 以上）の撮影はこれを満たす。spec の FR-022 は解像度だけだが、重要書類は 24 ビットのカラーが要件なので階調も同じ調べで出す（plan の差し戻し D3）
- **Alternatives**: 画像の DPI のメタデータで判定 → スマホは 72dpi と記録する（問26）ので使えない。レシートの大きさ（幅 80mm）を前提にする → 紙の大きさの前提が書類で違う

## R4. 検索の要件と実装

- **Decision**: `GET /receipts` の条件（data-model §2.3）: 取引年月日の範囲、金額の範囲、取引先（部分一致）、区分、未入力（取引年月日・金額・取引先のどれかが NULL）、結びつき（`none` / `linked` / `journal_voided`）、削除済みを含める。すべて AND で組み合わせる。並びは受領日時の新しい順、カーソルで 100 件ずつ
  - 取引先の比較は `partner_key`（`normalizeReceiptText`: NFKC → 大文字 → 空白を除く。006 の `normalizeContent` から数字の `#` 置換を除いたもの）に対する `LIKE '%…%' ESCAPE '\'`（`%`・`_`・`\` を逃がす）。全角・半角、大文字・小文字を区別しない（US1 シナリオ3）
  - 金額は書類に書かれた税込の金額（スキャナ問43 の「受領した書類の金額」）。0 円・空欄の書類は金額を NULL にし、「未入力」で探せる（問44）
  - 削除済みは既定で除き、`includeDeleted=true` で含める（スキャナ問33 ④）
- **索引**: `receipts(deleted_at, transaction_date)`、`receipts(amount)`。取引先の部分一致は索引を使えないが、5,000 行の走査は数ミリ秒（SC-002 の 1 秒に十分）
- **Rationale**: 規則2⑥五の①〜③をそのまま満たす。売上高による免除（電子取引）があっても、作る手間は小さく、スキャナ保存の将来（R1 の B）にも要る
- **Alternatives**: FTS5 の全文検索 → 部分一致の 1 列に対して過剰。正規化を SQL の関数で行う → SQLite に NFKC の関数がない

## R5. 仕訳との結びつき（相互関連性）

- **Decision**: 結びつきは**仕訳（`journal_id`）単位**で、行には結びつけない（`receipt_links`、data-model §1.3）
  - 001 の訂正（`correctJournal`）は同じ `journal_id` のまま内容を置き換える（version +1、行の ID は変わる）。仕訳に結びつけるので、**訂正で結びつきはそのまま引き継がれる**（FR-013。移す処理は要らない）。締め済みの年度の訂正仕訳（`correctsJournalId` を持つ新しい仕訳）は別の仕訳で、元の仕訳の結びつきは動かさない
  - 取消（`voidJournal`）: 結びつきは残し、状態を `journal_voided` と導く（保存しない）。別の仕訳に結び直すときは、同じトランザクションで古い結びつきを閉じ（`unlinked_at`、理由「結びついた仕訳が取り消されたため」）、新しい結びつきを作る
  - 有効な結びつき（`unlinked_at IS NULL`）は証憑ごとに高々 1 件（部分 UNIQUE、INV-64）。仕訳ごとには複数（FR-011）
  - 付け替え（有効な仕訳に結びついている証憑を別の仕訳へ）は `replace: true` と理由を要求する。付けていなければ 409 `RECEIPT_ALREADY_LINKED`
  - 解除は理由つき。結びつきの行は消さず、`unlinked_at`・`unlink_reason` を 1 回だけ書ける（トリガー）
  - 結びつける先: 存在する仕訳（`JOURNAL_NOT_FOUND`）、取消済みでない（`JOURNAL_VOIDED`）、締め済みの年度でもよい（結びつきは仕訳を変えない）。source を問わない（FR-011）
- **005 の `JOURNAL_LINKED` のような制約は作らない**: 証憑は仕訳の根拠であって、仕訳の内容を決めない。仕訳の訂正・取消を証憑が止める理由がない（取消は結びつきの状態で分かる）
- **Rationale**: 行の ID は訂正で変わる（006 が行に結びつけて訂正のたびに扱いを決めたのと違い、証憑は仕訳全体の根拠）。spec の Key Entities（1 件の証憑に有効な結びつきは 1 件まで、1 件の仕訳には複数）に合う
- **Alternatives**: 行に結びつける → 訂正のたびに移す処理が要る。証憑の列に `journal_id` を持つ → 付け替え・解除の履歴が列の上書きになる（ヴァージョン管理の③）

## R6. 仕訳の一覧・詳細での証憑、結びつける候補

- **Decision**:
  - 仕訳の詳細（`GET /journals/:journalId`）は、006 の `statements` と同じく**ルートで合成**して `receipts: ReceiptSummary[]`（有効な結びつきの証憑。削除済みは含めない＝削除の前に解除が要る）を足す
  - 仕訳の一覧（`GET /journals`）は、ルートで `countReceiptsByJournal(journalIds)`（有効な結びつきの数）を引き、各項目に `receiptCount` を足す。001 の `LedgerRepository.findJournals` と domain の `Journal` の型は変えない
  - 候補（`GET /receipts/:receiptId/journal-candidates`）: 取引年月日（未入力なら受領日）の前後 `RECEIPT_CANDIDATE_WINDOW_DAYS`（14）日の有効な仕訳を `findJournals` で引き、`rankJournalCandidates`（純関数）で並べる: ①仕訳の借方合計 = 証憑の金額 ②日付の差の小さい順 ③金額の差の小さい順 ④仕訳番号。上位 20 件。利用者は仕訳の検索（001 の条件）でも探せる
- **Rationale**: 001 のリポジトリと型に証憑を持ち込まない（006 と同じ合成の位置）。一覧の件数は 1 回の `GROUP BY` で引ける
- **Alternatives**: `findJournals` の SQL に副問い合わせを足す → 001 の型と全プロジェクトのテストに波及する。web が別の API で件数を引いて合わせる → 画面ごとに合わせる処理が要る

## R7. 履歴（ヴァージョン管理）と訂正・差し替え・削除

- **Decision**:
  - **ファイルは版ごとに `receipt_files` に 1 行**（追加が版 1、差し替えで +1）。行は不変（UPDATE・DELETE をトリガーで禁止）。`receipts.current_sha256` が今の版。差し替えは最新の版にだけできる（ヴァージョン管理の①②）
  - **証憑の値**（取引年月日・金額・取引先・区分・メモ）は `receipts` の列を更新し、変更のたびに `receipt_audit_log`（追記のみ）に前後の値（`auditEntry`）と理由を残す。過去の任意の時点の値は、追加の行の `after` から更新の `after` を順に当てれば戻る（INV-63、SC-005）
  - **削除は論理**（`deleted_at`・`deleted_reason`）。行・ファイル・履歴は残る。削除済みは通常の一覧から外れ、`includeDeleted` で検索・表示できる（③④）。有効な結びつきがあれば 409 `RECEIPT_LINKED`。削除の取り消しは作らない（plan の差し戻し D5）
  - **理由が要る操作**: 既に値のある取引年月日・金額・取引先・区分を変える（訂正）、差し替え、削除、付け替え、解除。未入力の欄を初めて埋める・メモだけを変えるときは理由を求めない（US2 シナリオ3 の後からの入力）。理由の検査は 001 の `checkReason`（`REASON_REQUIRED`）
  - 同時の更新は `version`（楽観ロック。001 と同じ `VERSION_CONFLICT`）
  - 物理削除は DB のトリガーで止める（`receipts`・`receipt_files`・`receipt_links`・`receipt_readings`・`receipt_audit_log` の DELETE を禁止。`receipt_files`・`receipt_audit_log` は UPDATE も禁止）
- **Rationale**: スキャナ問33 の 4 条件と spec FR-018・019。001 の `audit_log` と同じ形（`auditEntry`）で、機能ごとの表は 005・006 の `*_audit_log` に倣う
- **Alternatives**: 値の版を別表に持つ（`receipt_versions`）→ 監査の記録と二重になる。削除で行を別表に移す → 検索が 2 表になる

## R8. 証憑のファイルの暗号化と名前

- **確かめたこと**: DB は `deriveDbKey`（`HKDF-SHA256(DK, salt=空, info="trebuchet/db/tenant:<id>/v1")`、`packages/db/src/tenant-store.ts`）、バックアップは `HKDF(DK, ヘッダーの salt, "trebuchet/backup/v1")` で AES-256-GCM（`packages/db/src/backup/crypto.ts`）。DK は `setDataKey` のバッファだけが持ち、`withDataKey` が施錠中に `VaultLockedError` を投げる
- **Decision**（data-model §1.8）:
  - 形式 `TRC1`: `"TRC1"（4）| salt（16）| nonce（12）| 暗号文 | タグ（16）`
  - 鍵 = `HKDF-SHA256(DK, salt, "trebuchet/receipt:<entityId 小文字>/v1")`（ファイルごとに乱数の salt。nonce の衝突の上限を気にしなくてよい）。使い終えたら `fill(0)`
  - AAD = `"TRC1" | salt | nonce | entityId | sha256（16 進）`。別の事業体・別の名前への差し替え、1 バイトの改ざん、誤った DK は復号で必ず失敗する。復号の後に平文の SHA-256 が名前と一致することも確かめる（INV-61）
  - **名前 = 平文の SHA-256（小文字 16 進）+ `.trc`**（NFR-04、Constitution II）。DB の `receipt_files.sha256` と同じ値
  - 実装は `packages/db/src/receipt-files.ts`（`encryptReceipt`・`decryptReceipt` の純関数と、`ReceiptFileStore` の実装）。鍵は `withDataKey` の中でだけ作る
- **ハッシュが漏らすものの評価**: 平文の SHA-256 からは中身を戻せない。漏れるのは ①同じ内容かどうか（事業体の中では重複を 1 件にするので意味がない）②**推測した候補のファイルと照らす確認**（相手が同じファイルを持っていれば、利用者がそれを持つことを確かめられる）。スマホの撮影は毎回画素が違うので②は成り立たない。電子取引の PDF（発行元が同じファイルを持つ）では、データ場所を読める者に限り②が成り立つ。データ場所は利用者の Mac（FileVault）にあり、そこを読める者は DB の大きさ・更新日時も読めるので、追加の害は小さい。**データ場所では平文のハッシュの名前でよい**。同期フォルダ（クラウド）に置くバックアップでは名前を鍵つきにする（R11）
- **Alternatives**:
  - DB に BLOB で入れる（事業体の DB か別の SQLCipher の DB）→ バックアップのたびに全部の写しになり（R11）、NFR-04（ハッシュをファイル名）に反する
  - 事業体ごとに 1 つの鍵 + 乱数の nonce → 5,000 件では安全だが、salt を持つ形はバックアップ（`crypto.ts`）と同じで、鍵の再利用を考えなくてよい
  - 名前を `HMAC(DK 由来の鍵, 平文)` にする → Constitution II の「内容ハッシュで識別」から外れ、データ場所では得るものが小さい

## R9. 置き場所・施錠・平文の写し

- **Decision**:
  - 置き場所: `<データ場所>/receipts/<entityId 小文字>/<sha256>.trc`（`receiptFile(entityId, sha256)`。`tenantFile` と同じく entityId と sha256 の形を検査してパスを作る）。`tenants/` の下に置かない（`hasExistingLedger` などの `tenants/*.sqlite` の走査と分ける）
  - 書き込みは `.partial` に書いてから改名（途中で落ちても壊れたファイルを残さない）。同じ名前があれば書かない（同じ内容）
  - **施錠中は読み書きできない**: 鍵を `withDataKey` の中でだけ作るので、施錠中は `VaultLockedError`（server は 401 `LOCKED`）。証憑の API は事業体の DB を開くので、そこでも止まる
  - **平文の写し**: 変換（R12）のために `sips` に渡す平文は `.tmp/receipt-convert-<乱数>/` に書き、`finally` で消す。起動時（`lib/startup.ts`）に残った `receipt-convert-*` を消す（004 の `removeStaleSnapshots` と同じ）。応答は `Cache-Control: no-store`（ブラウザのディスクのキャッシュに平文を残さない）
  - **初回の設定**（008 の D4.1、`apps/server/src/lib/vault.ts`）で以前の registry・事業体を `discarded-<時刻>/` に移すとき、`receipts/` も移す
- **Rationale**: FR-003。DK の扱いを DB と同じ 1 か所（`tenant-store.ts`）に寄せる
- **Alternatives**: `tenants/<id>/receipts/` → `tenants/` の走査（復元・バックアップ）と混ざる。メモリーだけで変換する → `sips` はファイルを要する

## R10. 追加の手順（形式・大きさ・重複・全部か無か）

- **Decision**:
  - 受け口は 007 の `apps/server/src/lib/upload.ts`（`uploadLimitFor(1, RECEIPT_MAX_BYTES)`、`readUpload(c, RECEIPT_MAX_BYTES)`、`readJsonField(c, "options", ReceiptCreateOptions)`）。上限 `RECEIPT_MAX_BYTES` = 20 MB（`packages/schema/src/receipts.ts`。web も同じ値で事前に止める）。超えれば 413 `FILE_TOO_LARGE`
  - **形式は中身で判定**（`detectReceiptFormat`、domain の純関数）: JPEG `FF D8 FF`、PNG `89 50 4E 47 0D 0A 1A 0A`、PDF 先頭 1,024 バイト以内の `%PDF-`、HEIC ISOBMFF の `ftyp`（offset 4）で major brand が `heic`・`heix`・`heim`・`heis`・`hevc`・`hevx`、または `mif1`・`msf1` で compatible brands に前の 6 つのどれか。それ以外は 422 `RECEIPT_FORMAT_UNSUPPORTED`（拡張子・`Content-Type` は見ない）
  - 画素数・色は形式の判定の後に `ReceiptImageTool.probe`（R12）で調べる（非同期。ここまでは何も書かない）。**画素数の上限 `RECEIPT_MAX_PIXELS`（1 億画素、`probe` が `width × height` で判定）を超える画像は 422 `VALIDATION`（`details.maxPixels`）で拒む**: 20 MB 以下でも高圧縮の画像は展開で数 GB のメモリーを使い、`sips` が止まる・server が重くなる（画像の展開爆弾）。iPhone の最高の撮影（約 4,800 万画素）や A4 を 600dpi で読んだ画像（約 3,500 万画素）は通る。`probe` が寸法を返せないときは拒まない（PDF など）。判定は PNG・JPEG・HEIC の先頭のヘッダーを `sips -g` が読むだけで展開しない
  - **同期の区間で全部か無か**: `digest → 既存の判定 → ファイルの書き込み（なければ）→ ReceiptUnitOfWork の run（行と履歴）→ 失敗ならこの呼び出しが作ったファイルだけを消す` を `await` を挟まずに行う（Node の 1 本のスレッドで、同じ内容の同時の追加が交わらない）。DB の UNIQUE（`receipt_files.sha256`）に当たれば重複として扱う
  - **重複**（FR-004）: 事業体の `receipt_files` に同じ SHA-256 があれば（削除済み・差し替え前の版を含む）、作らずに 409 `RECEIPT_DUPLICATE`（`details.receiptId`、`deleted`）。画面は既存の証憑を開く
  - 経路（FR-002）は要求の Host で決める: `isLocalHost(requestHost(c.req))`（`apps/server/src/lib/origin.ts`。`requestHost` は `Host` ヘッダーをそのまま返す。004 の T001(b)）が真なら `local`（画面の表示は「Mac」）、それ以外（ts.net）は `remote`（「スマホ・リモート」）。端末の自己申告は使わない
- **Rationale**: FR-001・004・007、Edge Cases（拡張子と中身の違い、2 回送る、途中で切れる）。multipart のファイル全体がメモリーに乗るのは 20 MB までなので許容（007 も同じ読み方）
- **Alternatives**: ファイルを先に一時の名前で置き、DB の後で改名 → 失敗の後始末が 2 か所になる。孤立したファイルの定期の掃除 → 同期の区間で作ったものだけ消せば、異常終了の残りは無害（同じ内容が来れば使い回す）なので作らない

## R11. バックアップへの含め方

- **確かめたこと**: 今のバックアップは registry と全事業体の DB を `VACUUM INTO` で写し、1 つのアーカイブを**メモリー上で**組んで AES-GCM で 1 つの `.tbk` にする（`snapshot.ts`・`archive.ts`・`crypto.ts`）。自動は 24 時間ごと、内容が同じなら書かない（`shouldSkipBackup`）、世代を整理する（`selectBackupsToPrune`）。復元は展開先を作ってから改名で入れ替える（`restore.ts`、全部か無か）
- **大きさの見積もり**: 1 枚 2〜5 MB、年 1,000 枚で年 3 GB 前後、7 年で約 20 GB。`.tbk` に入れると世代ごとに全部の写しになり、メモリー上のアーカイブも成り立たない
- **Decision**: **証憑のファイルは `.tbk` に入れず、バックアップの置き場所の下の別のフォルダに増分で写す**（data-model §1.8）
  - 置き場所: `<バックアップの置き場所>/trebuchet-receipts/<entityId>/<名前>.trc`。**名前 = `HMAC-SHA256(K, sha256)` の 16 進**、`K = HKDF-SHA256(DK, salt=空, "trebuchet/backup/receipt-name/v1")`（同期フォルダのクラウドに平文のハッシュを見せない。R8 の②を閉じる）。DK は系列の間変わらないので名前は毎回同じ＝増分になる
  - 中身は**データ場所の `.trc` と同じバイト列**（すでに DK 由来の鍵で暗号化済み。復号し直さない）
  - 実行の順序（`apps/server/src/lib/backup-run.ts`）: スナップショット → 写した各事業体の DB から `receipt_files.sha256` を読む → **置き場所にないものを写す**（`.partial` → 読み戻して `decryptReceipt` で検証 → 改名）→ `.tbk` を書く（`shouldSkipBackup` で書かないときも、写しの確認はする）。どの `.tbk` も、書いた時点で参照する証憑が置き場所にそろっている（INV-68）。写しの失敗は `failed`（`error_code` に `RECEIPTS_SYNC_FAILED` を足す）で `.tbk` を書かない
  - 世代の整理は `.tbk` だけ。証憑の写しは消さない（物理削除しない。7 年以上、FR-021）
  - **復元**（`restore.ts`、`pnpm restore`）: `.tbk` を復号して展開した後、各事業体の写しの DB の `receipt_files` の各 sha256 について、`--receipts-dir`（既定は `.tbk` と同じフォルダの `trebuchet-receipts/`）から名前を求めて読み、バックアップの DK で `decryptReceipt`（AAD と SHA-256 の検証）→ 展開先の `receipts/<entityId>/<sha256>.trc` に同じバイト列を書く。**1 件でも欠ける・壊れていれば改名の前に失敗**（`RestoreErrorCode` に `RECEIPTS_MISSING`。件数を示す）。`--allow-missing-receipts` で帳簿だけを戻せる（欠けた証憑は画面で「ファイルがありません」）
  - 復元前のバックアップ（今の帳簿の `.tbk`）は DB だけ。今の証憑は改名で残る `.before-restore-<日時>/receipts/` にある（文書に書く）
  - **INV-54 は変わらない**: `.tbk` の形式とヘッダーの recovery の包みはそのまま。証憑の写しは、その `.tbk` から回復キーで開いた DK で読める
- **Rationale**: 証憑は不変で内容で名前が決まるので、増分の写しが自然。`.tbk` の大きさと実行時間は今と同じ（証憑の行が増えるだけ）。SC-006（復元でハッシュが一致）を復元の時点で全件確かめる
- **Alternatives**:
  - `.tbk` に全部入れる → 世代 × 20 GB、メモリーに乗らない。ストリームの形式への作り直しが要る
  - 増分の束（`.rcp`）を実行ごとに書く → 復元に過去の束が全部要り、整理ができない
  - 置き場所でも平文のハッシュの名前 → クラウドに②の確認を許す。HMAC の手間は小さい

## R12. 画像の変換（HEIC の表示、AI に送る JPEG、PDF）

- **Decision**: 新しい npm の依存を足さず、**macOS の `sips` を server から `node:child_process` の `execFile` で呼ぶ**。domain にポート `ReceiptImageTool`（contracts/domain-module.md §4）を置き、server の `apps/server/src/lib/image-tool.ts` が実装する。テストは偽の変換器（決まったバイト列・画素数を返す）を使い、`sips` を呼ばない
  - `probe(bytes, format)`: `sips -g pixelWidth -g pixelHeight -g space -g bitsPerSample`。PDF は調べない（undefined）。`width × height` が `RECEIPT_MAX_PIXELS`（1 億画素。R10）を超えれば `Result` の失敗（422 `VALIDATION`）にして、変換・保存に進ませない（S1。`sips` が展開で重くなるのを防ぐ）
  - `toDisplay(bytes, format)`: HEIC だけ `sips -s format jpeg` で JPEG にする（Chrome は HEIC を表示できない。Safari は表示できるが同じ経路にそろえる）。JPEG・PNG・PDF は原本をそのまま返す（PDF はブラウザの表示に任せる）。原本は変えない
  - `toAiJpeg(bytes, format, maxPx)`: `sips -s format jpeg -s formatOptions 80 -Z <maxPx>`（長辺 `RECEIPT_AI_MAX_PX` = 2,048）。PDF は 1 ページ目を描く（`sips -s format png` の後に縮小。描けないとき・文字が読めないときは `qlmanage -t -s 2048` を試す。どちらもだめなら PDF の読み取りは `RECEIPT_READ_UNSUPPORTED` で手入力）
  - AI に送る前に domain の `stripJpegMetadata`（純関数）で APP1（Exif・XMP）・APP13（IPTC）・COM を除く（位置情報を送らない。Constitution III）。**向き（Exif の Orientation）だけを残す最小の APP1 を作り直す**（向きが失われると画像が横倒しになる）
  - `sips` の作業ファイルは `.tmp/receipt-convert-<乱数>/`（R9）。子プロセスの環境の `TMPDIR` も `.tmp/` にする。時間切れ 20 秒。`sips` がない・失敗したら `RECEIPT_CONVERSION_FAILED`（表示）または読み取りの失敗（AI）
- **ゲート**（tasks の **T040**。Phase 1 の直後、`image-tool.ts` の T013 より前に行い、T013 はその結果に従う。O1。利用者の Mac で行う。サンドボックスでは `sips` が一時ファイルを書けず確かめられなかった）: 合成の HEIC（iPhone の撮影）・PDF（1 ページの電子の領収書）で、①HEIC → JPEG の表示 ②PDF の 1 ページ目が 2,048 px で文字が読める ③iPhone の縦の撮影の向きが AI 用の JPEG で正しい、を確かめて research に追記する。②が `sips` でも `qlmanage` でもだめなら、PDF の読み取りを範囲外にする（利用者の判断。依存の候補 `pdfjs-dist` は承認が要る）
- **Rationale**: Constitution VII（標準機能で代替できれば依存を足さない）。対象は macOS だけ（Technical Constraints）。iPhone の Safari はカメラの撮影・写真の選択を `accept="image/*"` で JPEG に変えて送ることが多く、HEIC は Mac のファイルの追加で来ることが多い
- **Alternatives**（依存を足すなら利用者の承認が要る）: `sharp`（libvips のネイティブ、HEIC は別の libheif が要る）、`heic-convert`/`libheif-js`（WASM、遅い）、`pdfjs-dist`（PDF の描画に canvas が要る）。どれも `sips` で足りる間は足さない

## R13. 外部の AI による読み取り（INV-45 の例外を閉じ込める）

- **確かめたこと**: 006 は `createAiSuggester`（`packages/domain/src/usecases/inference.ts`）が `buildAiPayload`（マスク）を通した文字列だけを送る（INV-45）。server の `chatCompletion`（`apps/server/src/lib/ai-client.ts`）は OpenAI 互換の `/v1/chat/completions` を `fetch` で呼び、`messages[].content` は文字列だけ、`response_format` を受けない接続先には付けずに再試行、時間切れは `COLUMN_TIMEOUT_DETAIL`。外部の接続先は `createAiRuntime` の `externalEndpoint()`（`ai_settings` の有効・URL・モデルとキーチェーンの API キー）
- **Decision**:
  - **経路を分ける**: 証憑の読み取りは新しいポート `ReceiptReader`（domain）と、server の `createReceiptReader`（`ai-client.ts`）だけを通る。006 の `createAiSuggester`・`SuggestionProvider`・`buildAiPayload` を通さず、逆に 006 の経路から画像を送る口も作らない。`createReceiptReader` は**外部の endpoint だけ**を受け取る（端末内の `fm` は範囲外、FR-014）
  - **呼べる条件**: `ai_settings.external_enabled` と `receipt_images_enabled`（R15）がともに真で、URL・モデル・API キーがそろっている。そうでなければ 422 `AI_NOT_CONFIGURED`（呼ばない）
  - **送るもの**（`buildReceiptReadingRequest`、純関数、INV-66）: ①固定の指示文（`receipts/reading-prompt.ts` の定数）②有効な科目のコードと名前の一覧（006 の推定と同じ選び方）③税区分のコードの一覧 ④画像 1 枚（R12 の JPEG、メタデータを除いたもの）。**取引先の一覧、ほかの仕訳、口座、メモ、元のファイル名、証憑に入力済みの値は送らない**（FR-015）
  - **要求の形**: `messages: [{ role: "system", content: 指示文 }, { role: "user", content: [{ type: "text", text: 選択肢 }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,…", detail: "high" } }] }]`、`response_format` は `json_schema`（strict、各項目は null を許す）。`chatCompletion` の `ChatRequest.messages[].content` を「文字列 | 部品の配列」に広げる（006・007 の呼び出しは文字列のまま）
  - **時間切れ** `RECEIPT_READ_TIMEOUT_MS` = 90 秒（画像は文字より遅い。外部の 60 秒より長く）
  - **失敗の記録の写像**（X1）: `receipt_readings.error_code` は ErrorCode ではなく文字列の定数（`packages/domain/src/receipts/reading.ts` の `RECEIPT_READING_ERROR`: `AI_TIMEOUT`・`AI_HTTP_ERROR`・`AI_INVALID_OUTPUT`・`RECEIPT_READ_UNSUPPORTED`・`RECEIPT_CONVERSION_FAILED`）。`readReceipt` ②の失敗を ③ で次のように記録して `ok(reading)` を返す: `toAiJpeg` が `RECEIPT_READ_UNSUPPORTED`（PDF を描けない）→ `failed`・`RECEIPT_READ_UNSUPPORTED`／`toAiJpeg` のその他の失敗 → `failed`・`RECEIPT_CONVERSION_FAILED`／`stripJpegMetadata` の失敗 → `failed`・`RECEIPT_CONVERSION_FAILED`／`reader.read` の失敗で `details.timeout`（`COLUMN_TIMEOUT_DETAIL` と同じ印）→ `timeout`・`AI_TIMEOUT`／その他の `reader.read` の失敗（`chatCompletion` は通信の失敗と HTTP のエラーを見分けない）→ `failed`・`AI_HTTP_ERROR`／`parseReceiptReading` が `invalid` → `invalid`・`AI_INVALID_OUTPUT`。`AI_UNREACHABLE` は作らない。`RECEIPT_READ_UNSUPPORTED` は `toAiJpeg` の失敗の ErrorCode でもあるので 9 つ目のコードとして足す（H: §1）
  - **憲法と AGENTS.md の改定**（C1。利用者が外部への画像の送信を明示的に選んだ、2026-11-02）: 例外が仕様・plan だけにあって、憲法の「外部の AI に送る情報は必要最小限、マスクする」と AGENTS.md の 006 の「AI へ送る情報は `buildAiPayload` を通したものだけ（INV-45）」と食い違わないよう、tasks T039 で ①`.specify/memory/constitution.md` の III に「証憑の画像の読み取りは、利用者が別に有効にしたときだけ、この原則の例外として許す」を 1 文足す（PATCH の改定。Sync Impact Report に変更・理由・影響を書く）②AGENTS.md の 006 の該当の規則に「010 の証憑の画像は例外。専用の `ReceiptReader` を通す」を一言足す。ADR 0014（T038）にも例外の判断を書く
  - **3 段**（006/R8 と同じ）: ①`ReceiptUnitOfWork` で証憑・科目・税区分を読む ②UnitOfWork の外で復号・変換・AI の呼び出し ③読み取りの記録と履歴を書く。AI の呼び出しをトランザクションの中に入れない
  - 読み取りは利用者の操作（`POST /receipts/:id/readings`）。「追加時に自動で読む」は web が追加の直後にこの API を呼ぶだけ（設定が有効なとき）。追加の応答（SC-001）を待たせない
- **Rationale**: spec FR-014〜017、Constitution III・IV。例外を 1 つのポートと 1 つの関数に閉じ込め、テスト（INV-66）で送る中身の形を固定する
- **Alternatives**: 006 の `SuggestionProvider` に画像の口を足す → マスクの原則（INV-45）の経路と混ざる。端末内の `fm` で読む → spec の範囲外。読み取りをジョブ（`lib/jobs.ts`）にする → 1 件ずつの操作で、同時に 1 つの制限が邪魔になる

## R14. AI の出力の検証と、読み取りの記録

- **Decision**:
  - Zod `AiReceiptReading`（`packages/schema/src/ai.ts` に足す）: `{ transactionDate: DateString | null, amount: 整数 0 < x < 1e12 | null, partnerName: string(1..100) | null, accountCode: string | null, taxCategory: TaxCategoryCode | null, confidence: 0..100 の整数, reason: string（200 字まで） }`。`reason` は 006 の `AiSuggestion.reason` と同じく、候補の根拠の短い説明（画面に AI の候補の説明として出す。記録には保存しない）。200 字を超えれば `reason` だけ「候補なし」（空）にし、ほかの項目は残す
  - domain の `parseReceiptReading(raw, context)`: JSON として読めなければ全項目「候補なし」。読めれば**項目ごとに** `safeParse` し、合わない項目だけ「候補なし」（FR-016、US4 シナリオ2）。科目は事業体の有効な科目のコードにあるものだけ、税区分は一覧にあるものだけ。日付は実在の日付（`DateString` の検査）
  - 候補は応答として返し、**証憑の値は変えない**（INV-67。保存は利用者の `PATCH` だけ）
  - 記録（`receipt_readings`、data-model §1.4）: 読み取った日時、ファイルの版（sha256）、モデル名、状態（`succeeded` / `invalid` / `failed` / `timeout`）、失敗のコード、候補の値（項目ごと、なければ NULL）。**画像と応答の本文は保存しない**（FR-017）
  - 精度の記録: 読み取りの後に利用者が値を保存したとき（`PATCH`）、その版の最新の `succeeded` の読み取りで比べていないものに、`date_match`・`amount_match`・`partner_match`（`normalizeReceiptText` で比べる）を 1 回だけ書く。証憑から仕訳を登録したとき（`readingId` を渡す）、`account_match`・`tax_match`（仕訳のどれかの行の科目コード・税区分が候補と同じ）を書く。**書けるのは列ごとに NULL から値への 1 回だけ**（トリガー。L2）: 値の保存（`date_match`・`amount_match`・`partner_match`）と仕訳の登録（`account_match`・`tax_match`）は別の機会なので、後から書く列を先の書き込みが塞がない。`compared_at` は最初の比べで 1 回だけ書き、後の比べでは動かさない
  - 監査（`receipt_audit_log`）には `read` の操作として日時・モデル名・状態だけを書く（US4 シナリオ5）
- **Rationale**: Constitution IV（Zod で検証、確信度を含める）。006 の `parseSuggestion` は全体を 1 つで判定するが、証憑は項目ごとに部分的に使える
- **Alternatives**: 応答の本文を保存して後で比べる → FR-017 に反する

## R15. 設定「証憑の画像を外部の AI に送る」

- **Decision**: registry の `ai_settings` に列 `receipt_images_enabled`（0/1、既定 0）を足す（registry のマイグレーション `0002`）。`AiSettingsInput`・`AiSettings`（schema）に `receiptImagesEnabled` を足す。外部の AI が無効なら真にできない（422 `AI_NOT_CONFIGURED`、`apps/server/src/routes/ai-settings.ts` の既存の検査に足す）。画面（`apps/web/src/routes/settings/ai.tsx`）は有効にする前に「画像はマスクできず、そのまま外部の AI に送られる（006 の送る情報の原則の例外）」を示し、確認を求める（FR-015）
  - `AiSettingsInput`・`AiSettings` の `receiptImagesEnabled` は**必須**（省略を許さない。`localEnabled`・`externalEnabled` と同じ `z.boolean()`。L2）。web は今の値を読み、画面で変えたものを全項目つきで送る
  - `ai_settings` はバックアップに含めない（`EXCLUDED_REGISTRY_TABLES`）。**復元は `ai_settings` を列名を並べて引き継いでいる**（`restore.ts` の `readAiSettings` と `INSERT`）ので、新しい列も足す
- **Rationale**: 外部の AI の設定（URL・キー）と同じ端末の設定で、同じ画面で見られる。spec「外部の AI の設定が有効で、さらに…別に有効」
- **Alternatives**: 事業体ごとの設定（tenant の表）→ 外部の AI の接続先が端末の設定なので、片方だけ事業体ごとにすると分かりにくい（利用者の判断 Q3）。`app_settings` の key → 外部の AI の設定と別の場所になる

## R16. スマホからの追加と PWA

- **確かめたこと**: `apps/web/public/manifest.webmanifest`（`display: standalone`、`start_url: "/"`、アイコン 1024px）と `apps/web/index.html` の `rel="manifest"`・`apple-touch-icon` は 004 の US4 で置かれている。ts.net の Host・ペアリング・静的配信（`pnpm start`）は 004 の T016〜T018b（T016b・T001(b)・T022 は 2026-11-02 時点で未完）
- **Decision**:
  - 新しい依存も Service Worker も足さない。iOS のホーム画面への追加は manifest と `apple-touch-icon` で足りる。Service Worker はオフラインのキャッシュに使うもので、オフラインの送信は範囲外（spec の Assumptions）。API の応答をキャッシュに残さない方が安全（R9）
  - 撮影: `<input type="file" accept="image/*" capture="environment">`。ファイルの選択: `accept="image/jpeg,image/png,image/heic,image/heif,application/pdf"`（`capture` なし）。送信の前に 20 MB を超えるものを止める
  - スマホ向けの画面 `routes/e/$entityId/receipts/capture.tsx`（撮影・選択、区分、任意で日付・金額・取引先、送信の結果）。事業体の一覧（`/`）の各事業体に「証憑を撮る」への入口を置く（ホーム画面のアプリは `/` から始まる）
  - 送信の失敗（通信の切断・`LOCKED`・5xx）ははっきり失敗と示し、保存されたと誤解させない（US2 シナリオ4）。成功の表示は 201 の応答を受けてから
  - iOS のホーム画面のアプリは Safari と cookie を分ける。アプリの中で 1 回パスキーでサインインする（quickstart §3 で確かめる）
- **Rationale**: FR-006。Constitution VII
- **Alternatives**: Service Worker で送信待ちを溜める → spec の範囲外。manifest の `shortcuts` → iOS は対応しない

## R17. 評価（SC-004）

- **Decision**: 合成の証憑の画像 20 枚（レシート・領収書・電子の PDF を混ぜる。HEIC 2 枚、PDF 2 枚を含む）を `packages/domain/test/fixtures/receipts/` に置く（`README.md` に作り方・匿名化・項目の正解、`expected.ts` に正解）。作る手順はリポジトリに置かない使い捨てのスクリプト（002・007 のフィクスチャと同じ）。実データの写真は入れない
  - `scripts/eval-receipts.ts`（`pnpm eval:receipts`）が外部の AI（設定済みのもの）を R13 と同じ経路（`buildReceiptReadingRequest` → `createReceiptReader`）で呼び、項目ごとの一致率を `.tmp/eval-receipts/` に件数と割合だけで残し、前回と比べる。CI に含めない（外部に送る、費用がかかる）。CI のテストは偽の `ReceiptReader` で集計だけを確かめる
  - **目標値**: 取引年月日の一致率 ≥ 90%、金額の一致率 ≥ 90%（20 枚中 18 枚）。取引先・科目・税区分は記録だけ（目標なし）
  - 指示文・`RECEIPT_AI_MAX_PX`・`RECEIPT_READ_TIMEOUT_MS` を変えるときは、変更の前と後で `pnpm eval:receipts` を比べる（Constitution IV。007 の `eval:columns` と同じ規則）
- **Rationale**: Constitution IV（AI の変更は評価を伴う）、V（実データをフィクスチャにしない）
- **Alternatives**: 006 の評価（`evals.ts`、明細の候補）に足す → 入力の形（画像）が違う

## R18. 事務処理規程とシステム概要書（文書）

- **Decision**: `docs/receipts/` に 2 つの文書を置く（FR-020）
  - `docs/receipts/processing-rules.md`: 国税庁の「電子取引データの訂正及び削除の防止に関する事務処理規程」の**個人の例**（R1 の URL）を元に、①対象（電子で受け取った領収書・請求書等）②保存の場所と方法（このアプリ、受領後の保存の期限）③訂正・削除の原則禁止と、やむを得ない訂正・削除の手順（アプリで理由を入れる＝履歴に残る）④保存の責任者（利用者の名前の欄）⑤保存期間（7 年以上、NFR-09）⑥**紙を撮影した証憑は紙の原本も保存する**（R1 の結論。将来タイムスタンプを足すまで）⑦入力の期限の目安（R2 の業務処理サイクル）。名前と日付の欄を空けておく
  - `docs/receipts/system-overview.md`: 電子計算機処理システムの概要書（自社開発のプログラムを使う場合の備付け、R1(g)）。保存の仕組み（R7・R8・R11）、検索の方法（R4）、表示と印刷、バックアップと復元の手順の要約
- **Rationale**: 電子取引の真実性（規則4①四）と可視性（規則2②一イ）。spec FR-020 は規程だけだが、システム概要書も要件（plan の差し戻し D2）
- **Alternatives**: 法人の例を写す → 個人事業主に合わない章（役員・従業員）が多い

## R19. ユーザーストーリーの分け方と層の置き場所

- **Decision**: spec の 5 つのユーザーストーリーをそのまま実装の単位にする
  - **US1**（保存と検索）: 形式の判定、暗号化のファイル、表、追加・一覧・表示・取り出し、R2・R3 の警告、検索。**US2 の土台**
  - **US2**（スマホ）: 経路、PWA の入口、撮影の画面。004 の US4（T016b・T001(b)・T022）の完了に依存する。ts.net での確認は利用者の端末
  - **US3**（仕訳との結びつき）: 結びつけ・付け替え・解除、証憑からの仕訳の登録、仕訳の一覧・詳細の表示、候補
  - **US4**（AI の読み取り）: 設定、変換、`ReceiptReader`、検証、記録、評価
  - **US5**（訂正・差し替え・削除、規程）: 訂正・差し替え・削除の API と画面、履歴の表示、文書 2 つ。**履歴の表と追記のトリガーは Foundational**（US1 の追加から履歴を残すため）
  - **バックアップ・復元（FR-021）**は US1 の後の独立した段（Polish の前）
- **層の置き場所**（003・009 と同じ形）:

| 層 | 場所 |
|---|---|
| 入出力の型（証憑、検索の条件、警告、AI の出力） | `packages/schema/src/receipts.ts`、`ai.ts`（`AiReceiptReading`）、`errors.ts` |
| 業務ルール（形式の判定、入力期限・解像度の警告、検索の正規化、候補の順位、履歴からの復元、JPEG のメタデータの除去、指示文と送る中身、出力の検証） | `packages/domain/src/receipts/`（`format.ts`、`warnings.ts`、`search.ts`、`candidates.ts`、`history.ts`、`jpeg-metadata.ts`、`reading-prompt.ts`、`reading.ts`） |
| ユースケース | `packages/domain/src/usecases/receipts.ts`（追加・更新・差し替え・削除・検索）、`receipt-links.ts`（結びつき・仕訳の登録）、`receipt-reading.ts`（読み取り） |
| 永続化 | `packages/db/src/receipt-repository.ts`（`ReceiptStore`）、`receipt-files.ts`（暗号化と `ReceiptFileStore`）、`backup/receipts.ts`（置き場所への写しと復元） |
| HTTP | `apps/server/src/routes/receipts.ts`（`journals.ts` は詳細・一覧の合成だけを足す） |
| server の部品 | `apps/server/src/lib/image-tool.ts`（`sips`）、`ai-client.ts`（`createReceiptReader`）、`ai-runtime.ts`、`backup-run.ts`、`startup.ts` |
| 画面 | `apps/web/src/features/receipts/`、`apps/web/src/routes/e/$entityId/receipts/`（`index.tsx`、`$receiptId.tsx`、`capture.tsx`） |

- **ADR**: `docs/adr/0014-receipt-storage.md`（0013 の次。`docs/adr/` で空きを確かめた）。内容: R8（暗号化と名前）、R11（`.tbk` と別置きの増分の写し）、R13（INV-45 の例外を 1 つの経路に閉じ込める）、R1（タイムスタンプを使わないので紙の原本を残す）
- **Alternatives**: 証憑の表を 006 の `statement-repository.ts` に同居させる → 機能の境界が崩れる

## R20. 税制の値（電子帳簿保存法の数値）

- **Decision**: `tax_parameters` に 4 つの key を足す（Constitution VI。値・出典は data-model §1.6）: `RECEIPT_INPUT_CYCLE_MONTHS`（2）、`RECEIPT_INPUT_GRACE_BUSINESS_DAYS`（7）、`RECEIPT_SCAN_MIN_LONG_PX`（2,338）、`RECEIPT_SCAN_MIN_SHORT_PX`（1,654）。適用開始日 2024-01-01、出典はスキャナ一問一答（問23・問26）の URL。日付で解決する（取引年月日。未入力なら受領日）
  - AGENTS.md の「税制の値の足し方」のとおり、`seed/tax-parameters.ts`（正本）とマイグレーションの両方に書く。`key` の CHECK と型 `TaxParameterKey`・Drizzle の enum も直す（表の作り直し。009 の `0011` と同じ手順）
  - 値が解決できないときは警告を出さない（`DEPRECIATION_PARAMETER_MISSING` のような警告は足さない。保存を止めない機能のため）
- **Rationale**: 入力期間・画素数の目安は国税の規則・通達の数値で、ロジックに直書きしない
- **Alternatives**: domain の定数（出典のコメントつき）→ Constitution VI に反する。表の作り直しを避けるため別表を作る → 同じ性質の値が 2 か所になる

## R21. 性能

- **SC-002（5,000 件の検索 1 秒）**: R4 の索引で足りる。`scripts/bench-reports.ts`（`pnpm bench:reports`）に「010 SC-002」を足す: 証憑 5,000 件（ファイルなし。行だけをリポジトリで入れる）の事業体で、日付の範囲 × 金額の範囲 × 取引先の部分一致の組み合わせを 10 回、各 1 秒以内。新しい bench のスクリプトは作らない（003・009 の SC と同じ置き場所）
- **SC-001（5 MB の撮影から保存の表示まで 10 秒）**: 暗号化（AES-GCM、5 MB で数十ミリ秒）と `sips` の `probe`（1 回、1 秒未満の見込み）。tailnet の転送が大半。利用者の端末で手で計る（quickstart §3）
- **一覧の表示**: 一覧は画像を読まない（サムネイルは作らない）。画像は詳細で 1 件ずつ復号する
- **Alternatives**: サムネイルを暗号化して保存 → 版ごとに派生のファイルが増え、バックアップの対象が増える（YAGNI）

## R22. spec への差し戻しと利用者の確認

plan の「spec への差し戻し」（D1〜D7）と「利用者の判断が要る点」（Q1〜Q5）にまとめる。spec はこの段階では直さない。
