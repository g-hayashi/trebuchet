# Research: 定額法・一括償却資産・開業費の償却

**Feature**: [spec.md](./spec.md) | **Date**: 2026-11-01

既存のコードの参照は 003 の実装（`packages/domain/src/blue-return/`、`usecases/blue-return.ts`、`packages/db/src/closing-repository.ts`、`packages/db/src/schema/tenant.ts`、`drizzle/tenant/0003`〜`0004`）による。税制の出典は各節に書く。番号は 009 の中だけで通す（他の機能は `003/R7` の形で指す）。

## R1. 償却方法の列挙と、資産に足す列

- **Decision**: `DepreciationMethod`（Zod、`packages/schema/src/blue-return.ts`）と `fixed_assets.method` の CHECK に `straight_line`（定額法）と `lump_sum`（一括償却資産）を足す。`fixed_assets` に 3 列を足す（data-model §1.3）:
  - `in_service_on`（事業の用に供した日。NULL なら取得日とみなす）
  - `prior_accumulated`（前年までの償却累計額。整数、既定 0）
  - `prior_through_year`（`prior_accumulated` が何年分までの累計か。NULL なら台帳の計算は供用の年から始まる）
- 定額法は `useful_life_years` が必須（DB の CHECK と domain の検査）。一括償却は `useful_life_years` を持たない（NULL）。少額の特例（003）は `prior_accumulated = 0`・`prior_through_year IS NULL` に限る
- 台帳が計算を始める年度 `startYear` = `prior_through_year + 1`（あれば）、なければ供用の年
- 既存の仕訳との結びつけ（`linked_journal_id`、003/R7）は少額の特例だけに残す。定額法・一括償却で指定したら `VALIDATION`（`field: "linkedJournalId"`）
- **Rationale**: ADR 0005 の「影響」が定めた足し方（列挙に値を足し、`depreciate` を方法で分ける）に従う。「前年までの累計」は基準の年がないと、どの年度の期首から計算を続けるかが決まらない（spec US1 シナリオ4）。年を持てば、取込済みの年度（freee の帳簿に償却が入っている年度）と台帳で計算する年度を分けられる（R10、R16 の Q2: 取込済みの年度の資産は `prior_through_year` をその年度にし、翌年度から台帳で計算する）
- **Alternatives**:
  - 列の名前を `lump_sum_3y` にする → 年数は税制の値（R4）なので名前に入れない
  - 「期首の未償却残高」を持つ（`opening_book_value` + 年）→ 取得価額 − 累計 と同じ情報。spec の入力（累計額）に合わせる。画面で残高から累計を求めて送ってもよい
  - 資産の種類を足して別表から耐用年数を引く → spec の Assumptions（耐用年数は利用者が入力）で範囲外

## R2. 定額法の償却率の表

- **Decision**: 新しい表 `straight_line_rates`（耐用年数、償却率の千分率の整数、適用開始日・終了日、出典 URL。data-model §1.1）を作る。正本は domain の `packages/domain/src/seed/depreciation-rates.ts`（`STRAIGHT_LINE_RATES`）で、同じ値をマイグレーションで投入する。db のテスト（`closing-repository.test.ts` の `listTaxParameters` と同じ形の `listStraightLineRates`）で一致を確かめる。率の解決は `resolveStraightLineRate(usefulLifeYears, acquiredOn, rates)`（`resolveTaxParameter` と同じ選び方。外れたら undefined）。日付は**取得日**（率は取得の時期で決まる。月数は供用日、R3）
- **値**: 2007-04-01 以後に取得した資産の定額法の償却率（耐用年数省令 別表第八）。適用開始日 2007-04-01、終了日 NULL。千分率（0.250 → 250）

| 耐用年数 | 率 | 耐用年数 | 率 | 耐用年数 | 率 | 耐用年数 | 率 | 耐用年数 | 率 |
|---|---|---|---|---|---|---|---|---|---|
| 2 | 500 | 12 | 84 | 22 | 46 | 32 | 32 | 42 | 24 |
| 3 | 334 | 13 | 77 | 23 | 44 | 33 | 31 | 43 | 24 |
| 4 | 250 | 14 | 72 | 24 | 42 | 34 | 30 | 44 | 23 |
| 5 | 200 | 15 | 67 | 25 | 40 | 35 | 29 | 45 | 23 |
| 6 | 167 | 16 | 63 | 26 | 39 | 36 | 28 | 46 | 22 |
| 7 | 143 | 17 | 59 | 27 | 38 | 37 | 28 | 47 | 22 |
| 8 | 125 | 18 | 56 | 28 | 36 | 38 | 27 | 48 | 21 |
| 9 | 112 | 19 | 53 | 29 | 35 | 39 | 26 | 49 | 21 |
| 10 | 100 | 20 | 50 | 30 | 34 | 40 | 25 | 50 | 20 |
| 11 | 91 | 21 | 48 | 31 | 33 | 41 | 25 | | |

- **出典**: 国税庁「Ⅲ 資料編 減価償却資産の償却率表」（平成19年4月1日以後取得 定額法 償却率） https://www.nta.go.jp/law/joho-zeikaishaku/shotoku/shinkoku/070412/pdf/3.pdf （2026-11-01 に本文のテキストで 2〜50 年の全行を照合した）。同じ表は No.2100 の「減価償却資産の償却率等表」（https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/pdf/2100_02.pdf 。画像の PDF のため文字では照合していない）。計算の方法は No.2106 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2106.htm
- 平成24年の改正で変わったのは定率法だけで、定額法の率は変わっていない（同じ資料）。各値は ⌈1000 / 耐用年数⌉ と一致する（seed のテストで確かめてよいが、計算はこの式で代えない）
- **Rationale**: Constitution VI（税制の値はデータ、出典つき）。千分率の整数なら浮動小数を使わずに式を書ける（R3）
- **Alternatives**:
  - `tax_parameters` に 49 個の key（`STRAIGHT_LINE_RATE_4` など）を足す → CHECK の列挙と型が膨らみ、耐用年数で引けない
  - ⌈1000 / 耐用年数⌉ で計算する → 結果は同じだが、率は法令の表が正本で、ロジックに直書きしない（VI）。将来の改正で式が崩れる
  - 率を浮動小数（0.25）で持つ → Constitution I

## R3. 定額法の計算

- **Decision**（data-model §2.2 に式）:
  - 年の普通償却費の候補 = ⌈取得価額 × 率 × 月数 / 12000⌉（率は千分率。1 円未満は切上げ、FR-005）
  - 月数（FR-006）= その年度に事業に使った月数。供用の年は供用の月から 12 月まで（1 月なら 12、12 月なら 1）、除却の年は 1 月（供用の年なら供用の月）から除却の月まで。月の途中は 1 か月と数える。計算は `packages/domain/src/dates.ts`（`monthIndex` など）を使う
  - その年の償却費 = min(候補, 期首の未償却残高 − 1)（FR-007。最終の年度は残高 − 1 円）。残高が 1 円なら 0 で、以後の年度は案を出さない
  - 期首の未償却残高（年度 Y）= 取得価額 − `prior_accumulated` − Σ（`startYear` 〜 Y−1 の償却費）。取得価額 × 率 は 2007 年以後の定額法の「償却の基礎になる金額」= 取得価額（様式のロ）
  - 必要経費算入額 = ⌊償却費 × 事業専用割合 / 10000⌋、家事分 = 償却費 − 算入額（FR-008。003/R5 の `computeHomeUse` をそのまま使う）
- **整数の範囲**: 金額 < 10^12、率 ≤ 500、月数 ≤ 12 なので積は < 6×10^15 で `Number.MAX_SAFE_INTEGER` に収まる（BigInt は要らない）
- **仕訳の案**: 003 の形のまま（減価償却費 / 資産の勘定（償却費）、家事分があれば 事業主貸 / 減価償却費）。日付は年度末日、税区分は `OUT_OF_SCOPE`
- **確かめる例**（SC-001。合成の値）: (1) spec US1 シナリオ1（500,000 円・4 年・7 月供用 → 6/12、62,500、残高 437,500）、(2) シナリオ2（60% → 算入 37,500、家事分 25,000）、(3) No.2106 の例（1,000,000 円・10 年・1 月供用 → 毎年 100,000、10 年目 99,999、残高 1）、(4) シナリオ4（前年までの累計の入力 → 12/12）、(5) 12 月供用（1/12）と除却の年（月割り、R8）
- **Rationale**: 国税庁 No.2106（1 円まで償却、年の中途は月割り）と spec FR-005〜008
- **Alternatives**: 月割りの前に年額を切り上げてから月数を掛ける → 2 回の丸めで国税庁の式（1 回）とずれる

## R4. 一括償却資産

- **Decision**:
  - 登録できるのは、取得日に適用される `LUMP_SUM_COST_MIN` ≤ 取得価額 < `LUMP_SUM_COST_MAX`（10 万円以上 20 万円未満）のときだけ。外れたら 422 `LUMP_SUM_COST_OUT_OF_RANGE`（`details.min`・`max`）。値がなければ `TAX_PARAMETER_MISSING`
  - 年数 n は税制の値 `LUMP_SUM_YEARS`（3）。各年度の額は、1〜n−1 年度目が ⌊取得価額 / n⌋、n 年度目が残り（取得価額 − (n−1)×⌊取得価額 / n⌋）。月割りしない（FR-010）。100,000 円なら 33,333・33,333・33,334
  - 1 年度目は**事業の用に供した年**（`in_service_on`、NULL なら取得日。spec FR-010）。前年までの累計があるときは、各年度の額を min(年の額, 残り) にし、n 年度目で残りをすべて償却する
  - 除却しても n 年度の償却を続け、除却損を出さない（FR-011）。台帳に残し、3 ページに載せ続ける
  - 少額の特例の年間の上限の集計（`validateFixedAsset` の `sameYearAssets`）は今も `method === "small_asset_28_2"` だけを数える（FR-004 は満たしている。テストで確かめる）
  - 事業専用割合・家事分・仕訳の案の形は定額法と同じ（R3）
- **出典**: 国税庁 No.2100 注2「その業務の用に供した年以後3年間の各年分において…3分の1」 https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm
- **Rationale**: 端数を最後の年度に寄せると、毎年度同じ規則で計算でき、合計が取得価額と一致する（spec US2 シナリオ2、SC-002）。切捨ては早い年度の必要経費を多く計上しない側（003/R5 と同じ考え方）
- **注意**: 法令は「その年に供した一括償却資産の取得価額の**合計額**の 3 分の 1」。資産ごとに切り捨てると、1・2 年度目の合計が合計額で計算した値より最大で（資産の数 − 1）円少なく、3 年度目で戻る。資産ごとの行にする（FR-018）ための差で、利用者が受け入れた（R16 の Q3）
- **Alternatives**:
  - 1 年度目に端数を寄せる（⌈÷3⌉）→ 合計は一致するが、早い年度に多く計上する
  - 年数を定数 3 にする → spec FR-022 は範囲と月数だけを挙げるが、年数も法令の値なので VI に合わせてデータにする（行を 1 つ足すだけ）

## R5. 開業費（繰延資産）

- **Decision**:
  - 新しい表 `deferred_assets`（名称、支出の総額、開業日、前年までの累計 `prior_accumulated`、累計の年 `prior_through_year`、帳簿の勘定（既定 1080 開業費）、備考）と、年度ごとの決定 `deferred_amortizations`（繰延資産, 年度 → 金額 ≥ 0。PK（繰延資産, 年度））を作る（data-model §1.4〜1.5）。開業費以外の繰延資産は範囲外なので、種類の列は作らない
  - 年度 Y の上限（FR-013）= 期首の未償却残高 = 総額 − `prior_accumulated` − Σ（Y より前の年度の**有効な**償却額）。有効な償却額は、決定の金額のうち、結びついた償却の仕訳が取り消されていないもの（R6）
  - 目安（FR-013）= min(上限, ⌈総額 × その年度の月数 / `OPENING_COST_AMORTIZATION_MONTHS`⌉)。月数は、開業日の月から 60 か月の範囲とその年度の重なり。60 か月を過ぎた年度の目安は 0（任意償却は続けられる。上限は残る）
  - 決定（FR-014〜015）: 0 ≤ 金額 ≤ 上限の整数（超えたら 422 `DEFERRED_AMORTIZATION_OVER_LIMIT`、`details.limit`）。0 円の決定は記録だけで案を作らない。正の金額の決定は、その年度の決算整理の案（種別 `deferred_amortization`）になり、003 の `commitAdjustment` で仕訳と出所を 1 トランザクションで登録する（R7）
  - 決定は、その年度に有効な償却の仕訳がない間だけ変えられる（あれば 409 `DEPRECIATION_JOURNAL_EXISTS`。仕訳を取り消してから変える）。締め済みの年度は `PERIOD_CLOSED`。`startYear`（`prior_through_year + 1` か開業の年）より前の年度は `VALIDATION`
  - 仕訳の案は **減価償却費（5180）/ 開業費の勘定**（金額 = 決定の額。家事分はない）。決算書 3 ページの「減価償却費の計算」に行を載せ、欄 18 に含める（FR-019。R11）
- **出典**: 国税庁 質疑応答事例「償却期間経過後における開業費の任意償却」（60 か月の均等償却又は任意償却。所得税法施行令 137 条 1 項 1 号・3 項） https://www.nta.go.jp/law/shitsugi/shotoku/04/08.htm
- **端数**: 目安は 1 円未満を切り上げ、上限で抑える。均等の額を毎年度計上すると 60 か月目で残高がちょうど 0 になり、端数の残りが出ない。目安は利用者が変えられる参考の値なので、どちらに寄せても税額の誤りにはならない
- **Rationale**: 任意償却なので年度ごとの額は利用者の判断で、帳簿の集計値ではない（保存してよい。Constitution I は集計値の保存を禁じる）。案の確定の経路（作り直し → 金額の比較 → `createJournal` → 出所）を 003 と共有し、新しい確定の API を作らない
- **Alternatives**:
  - 決定を保存せず、確定の API に金額を渡すだけにする → 0 円の決定（FR-015）を記録できない
  - 決定の行に `journal_id` を持つ → `adjustment_journal_refs` と二重になる。取消の判定も refs で足りる
  - 目安を切り捨てる → 最後の年度に 1〜数円の残りが出て、もう 1 年度の案が要る

## R6. 償却額は資産の属性から決め、登録済みかは仕訳から判定する

- **Decision**: 定額法・一括償却の各年度の償却費は、資産の属性（取得価額、方法、耐用年数・率、供用日、前年までの累計、除却日）と税制の値だけから決まる関数で計算し、保存しない（spec の Key Entities「年度の償却（導出）」）。登録した仕訳の金額は計算に使わない。ある（資産, 年度）が「登録済み」かは、003 と同じく `adjustment_journal_refs` のその年度・その資産の行の仕訳に、取り消されていないものがあるかで判定する（`assessDepreciation` の今の判定）。開業費だけは任意償却なので、利用者の決定（R5）が年度の額になる
- **Rationale**: 個人の減価償却は強制償却（償却しなかった年度の分も償却したものとして残高が減る）。仕訳から逆算すると、登録を忘れた年度の後の残高が法令とずれる。忘れた年度は、帳簿と台帳の照合（R10）と欄 18 の照合（`DEPRECIATION_MISMATCH`）で見つかる
- spec の Key Entities「資産と登録済みの仕訳から導く」は、金額は資産から、登録の状態は仕訳から導く、と読む
- **Alternatives**: 各年度の償却費を、前の年度に登録した仕訳の金額から積み上げる → 強制償却と合わず、取消・訂正のたびに以後の年度が動く

## R7. 仕訳との結びつき

- **Decision**: 年度ごとの結びつきは、003 の `adjustment_journal_refs`（仕訳 ID、種別、出所の ID、**年度**）をそのまま使う。この表はすでに年度の列を持ち、1 つの資産の複数の年度の仕訳を表せる。変えるのは次だけ:
  - `kind` に `deferred_amortization` を足す（CHECK と `AdjustmentKind`）
  - 列 `deferred_asset_id`（FK `deferred_assets`）を足し、出所の CHECK を「種別に応じた ID が NOT NULL」に広げる
- 同じ（出所, 年度）に有効な仕訳は高々 1 件（FR-017）。取り消された仕訳の参照の行は残り（削除禁止のトリガー）、取り消せば案が再び出る。UNIQUE 制約は張れない（取消済みの行が残るため）ので、確定のトランザクションの中で作り直して判定する（INV-60）
- `fixed_assets.linked_journal_id` は 003 の意味（取得がすでに費用で仕訳されている少額の資産。FR-022 of 003）のまま、少額の特例だけに使う（R1）
- **Rationale**: 判断メモの「年度ごとの結びつきの表に一本化」は、すでに `adjustment_journal_refs` がその役割を持っていた。新しい表を作ると出所が 2 か所に分かれる（VII）
- **Alternatives**: 新しい表（資産, 年度 → 仕訳、UNIQUE）→ 取消の後の再登録で UNIQUE が邪魔になり、refs と二重になる

## R8. 除却

- **Decision**:
  - **定額法**: 除却の年度の案は 1 つの仕訳で、(a) 1 月（供用の年なら供用の月）から除却の月までの月割りの償却（R3。最終年の 1 円の規則も効く）と、(b) 除却損 = (a) の後の未償却残高（備忘価額の 1 円を含む）。(b) は「固定資産除却損 / 資産の勘定」で、家事分（⌊除却損 × 事業専用割合 / 10000⌋ を除いた残り）は「事業主貸 / 固定資産除却損」。除却の翌年度からは計算しない（3 ページにも載せない）。除却の年度の後、資産の勘定の貸方の合計は期首の未償却残高と等しい（INV-57）
  - **一括償却**: 除却しても計算を変えない（R4、FR-011）
  - **少額の特例**: 003 のまま
  - 除却の日は供用日（NULL なら取得日）以後に限る（今は取得日以後。`VALIDATION`）
  - 除却の年度に有効な償却の仕訳がすでにある（除却の前に通年の償却を登録した）なら、除却は 409 `DEPRECIATION_JOURNAL_EXISTS`（その年度以後の仕訳を取り消してから除却する。R12）
- **出典**: 月割りの償却は No.2106 の注（年の中途で取壊しをした場合は月割り）。事業用の資産の除却の損失は必要経費（所得税法 51 条 1 項）
- **Rationale**: 1 つの仕訳にすれば「同じ資産・同じ年度の案は 1 回」（FR-017）の判定が 1 つで済み、償却だけを登録して除却損を忘れることがない。家事分の扱いは償却と同じ規則にそろえる
- **売却**（R16 の Q1、spec FR-009・Edge Cases）: 除却の入力に種類 `disposal_kind`（`scrap` 廃棄 / `sale` 売却。既定 `scrap`）を足す。売却なら (a) は同じで、(b) の代わりに「事業主貸 / 資産の勘定」（(a) の後の未償却残高の全額。家事分の分割はしない）にする。除却損の科目は使わない。譲渡所得の計算は範囲外で、除却の画面と案の内訳に「譲渡所得は確定申告書で別に計算する」旨を示す。一括償却・少額の特例は種類にかかわらず廃棄と同じ（一括償却は売却しても償却を続ける）
- **Alternatives**: 償却と除却損を別の案（別の種別）にする → 種別と判定が増え、片方だけの登録が起きる。売却を扱わず知らせるだけにする（spec の当初の案）→ 売却を除却として登録すると未償却残高が除却損（必要経費）になり誤り、登録しなければ帳簿に資産の残高が残る

## R9. 勘定科目

- **Decision**: 初期セット（`packages/domain/src/seed/accounts.individual.ts`）に `5300` 固定資産除却損（費用、`reportLine` 30。任意欄）を足す（`5290` 研修費と `5310` 雑費の間）。既存の `1070` 一括償却資産・`1080` 開業費・`5180` 減価償却費・`3090` 事業主貸はそのまま。仕訳の科目はコードで引く（定数 `DISPOSAL_LOSS_ACCOUNT_CODE = "5300"`、`DEPRECIATION_ACCOUNT_CODE`、`DRAWINGS_ACCOUNT_CODE`）。科目がない事業体（初期セットの前に作った事業体）では、除却の案が 003 と同じ `ACCOUNT_NOT_FOUND` になる
- 一括償却資産の勘定の既定は `1070`、定額法は `1060`（今の画面の既定）、開業費は `1080`。どれも区分が資産の科目に限る（003 の `ASSET_ACCOUNT_INVALID`）
- **欄**: 様式（`form.ts`、令和7年分）に除却損の欄はない。費用の欄 8〜24 のどれにも当たらないので任意欄（25〜30）に載る。`buildBlueReturn` は欄 25〜30 の科目を金額が 0 でないものだけ詰めるので、除却のない年度は欄を使わない。初期セットの任意科目は 25〜29 の 5 つで、欄 30 が空いている
- **Rationale**: spec の Assumptions（ない科目は plan で seed に足す）。雑費（31）に入れるより科目名が決算書に出る
- **Alternatives**: 雑費（5310）で仕訳する → 決算書で除却損が見えない。`reportLine` を null にする → 任意欄に詰める動きは同じだが、欄の意図がコードから読めない

## R10. 帳簿と台帳の照合（FR-020）

- **Decision**: `checkAssetRegister`（新しい純関数、`blue-return/asset-register.ts`）が勘定ごとに比べ、差があれば警告 `ASSET_REGISTER_MISMATCH` を出す（自動で直さない）:
  - **対象の勘定**: 定額法・一括償却の資産と開業費が使う勘定（資産の勘定・開業費の勘定）。少額の特例の資産だけが使う勘定は対象にしない
  - **帳簿の期首**: その年度の 001 の期首残高（補助科目を合計、借方を正）。4 ページの期首と同じ値
  - **台帳の期首**: 年度の期首より前に取得した資産の期首の未償却残高（定額法は除却の前の年度まで、一括償却は除却しても残高、少額の特例は 0）と、開業費の期首の未償却残高（R5）の合計
  - その勘定の資産・開業費に `prior_through_year ≥ 年度` のものがあれば（台帳がその年度を計算しない）、その勘定は照合しない
- 繰延資産の 003 の警告 `DEFERRED_ASSET_NOT_AMORTIZED` は、その勘定の開業費にその年度の決定（0 円を含む）があれば出さない（FR-015）。開業費を登録していない 1080 の残高には今のまま出す
- **Rationale**: 取込で始めた帳簿の期首（freee の残高）と、台帳に登録した前年までの累計の食い違いを、決算の前に見つける。少額の特例の勘定（1060 工具器具備品）まで対象にすると、台帳に定額法の資産を登録していない 003 の利用（003 quickstart の期首 240,000 円）でも新しい警告が出る
- **Alternatives**:
  - 期末も比べる → 期末は登録した仕訳しだいで、`DEPRECIATION_MISMATCH`（欄 18）と翌年度の期首の照合で足りる
  - 1060・1070・1080 を常に対象にする → 台帳に資産を登録していない残高も見つけられるが、少額の特例だけの利用に新しい警告が出る。利用者は使う勘定だけを選んだ（R16 の Q4）

## R11. 決算書 3 ページの行と欄 18

- **Decision**: `DepreciationRow`（`packages/schema/src/blue-return.ts`）に列を足す: `source`（`fixed_asset` / `deferred_asset`）、`ratePermille`（定額法の償却率、他は null）、`months`（本年中の償却期間の月数。定額法だけ、他は null）、`disposedOn`。`method` は行の償却方法 `DepreciationRowMethod` = 資産の方法 + `deferred`（開業費、表示は「任意償却」）。`assetId` は資産・開業費の ID（`source` で区別）
- **載せる行**: 少額の特例は 003 のまま。定額法はその年度の償却費 > 0、またはその年度に取得・除却した資産（残高 1 円で償却の終わった資産は載せない）。一括償却はその年度の額 > 0。開業費はその年度の決定の額 > 0（決定の額を載せ、仕訳の登録を問わない。登録していなければ欄 18 との不一致で分かる）
- **値**: 取得価額（開業費は総額）、償却の基礎になる金額（定額法・一括償却は取得価額、開業費は総額）、本年分の普通償却費 = 償却費合計（特別償却は範囲外）、事業専用割合（開業費は 10000）、必要経費算入額、未償却残高（期末）
- 欄 18 との照合（`DEPRECIATION_MISMATCH`、003 FR-023）は今のまま（行の必要経費算入額の合計 = 欄 18）。除却損は欄 18 に含めない（別の科目）
- 画面（`FormPage3.tsx`）と CSV（`csv.ts` の `page3Rows`）に 償却率・本年中の償却期間（`n/12`）の列を足す
- **Rationale**: 様式の「減価償却費の計算」の列（償却率又は改定償却率、本年中の償却期間）。開業費を同じ表に載せるのは spec FR-019（国税庁の作成コーナーは繰延資産の償却費を減価償却費の欄から入力する）
- **Alternatives**: 開業費を 3 ページとは別の欄に出す → spec FR-019 と食い違う

## R12. 変更の制限と締め済みの年度

- **Decision**:
  - 資産の計算に効く項目（取得日、供用日、取得価額、方法、耐用年数、事業専用割合、前年までの累計とその年、資産の勘定）は、その資産に有効な償却の仕訳（どの年度でも）があれば変えられない: 409 `DEPRECIATION_JOURNAL_EXISTS`（`details.years`）。名称・数量・備考は変えられる。開業費（総額、開業日、累計とその年、勘定）も同じ
  - 除却は、除却の年度以後に有効な償却の仕訳があれば同じ 409
  - 判定は `adjustment_journal_refs`（出所ごと）と 001 の仕訳の状態（`getJournal(id).status`）。保存と同じ `ClosingUnitOfWork` の中で読む
  - 締め済みの年度（FR-021）: `getAdjustmentProposals` は締め済みの年度に償却（`depreciation`）と開業費（`deferred_amortization`）の案を返さない。`commitAdjustment` は今の `PERIOD_CLOSED` のまま。按分（`home_use`）の一覧の動きは変えない
- **Rationale**: spec Edge Cases（登録済みの仕訳と食い違う変更は、仕訳を取り消してから）。003 の `saveFixedAsset` はこの検査を持たないので新しく足す（少額の特例の資産にも効く。003 の動きの変更）
- **Alternatives**: 変更を許し、差額の案を出す（按分の `HOME_USE_ADJUSTMENT_STALE` と同じ）→ 複数の年度にまたがり、締め済みの年度の差額は当年度の訂正になり、規則が増える

## R13. 税制の値の追加

- **Decision**: `tax_parameters` の key（CHECK、型 `TaxParameterKey`、Drizzle の enum）に 4 つを足し、`packages/domain/src/seed/tax-parameters.ts`（正本）とマイグレーションの両方に行を足す（AGENTS.md「決算書（003）」の手順）

| キー | 適用開始日 | 適用終了日 | 値 | 出典 |
|---|---|---|---|---|
| `LUMP_SUM_COST_MIN`（以上） | 2007-04-01 | — | 100,000 | https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm |
| `LUMP_SUM_COST_MAX`（未満） | 2007-04-01 | — | 200,000 | 同上 |
| `LUMP_SUM_YEARS` | 2007-04-01 | — | 3 | 同上 |
| `OPENING_COST_AMORTIZATION_MONTHS` | 2007-04-01 | — | 60 | https://www.nta.go.jp/law/shitsugi/shotoku/04/08.htm |

- 値の解決の日付: 一括償却の 3 つは取得日、開業費の月数は開業日。該当する行がなければ、登録は 422 `TAX_PARAMETER_MISSING`（`details.key`・`date`）、決算書は警告 `DEPRECIATION_PARAMETER_MISSING`（spec Edge Cases）で、その資産の計算をしない
- **適用開始日について**: 法令の施行日ではなく、この機能が扱う期間の始め（2007-04-01 以後の取得。spec の Assumptions）にそろえた。その日に効力があった値なので誤りではないが、より前の日の行は持たない
- **確認済み（T001、2026-11-01）**: (a) 令和8年度の税制改正の大綱（所得税に関係する章 https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/08taikou_01.htm 〜 `_09`）に一括償却資産・繰延資産の改正の記載はない。国税庁 No.2100（令和8年4月1日現在法令等）は 10 万円以上 20 万円未満・3 年の均等償却のまま。開業費の 60 か月は質疑応答（上表の URL）のまま。よって上表の値に適用終了日は付けない。政令第93号の新旧対照表（https://www.mof.go.jp/tax_policy/tax_reform/outline/fy2026/seirei/shinkyu/93_shotoku.pdf ）の本文は読めなかったので、施行令 137 条・139 条の条文の照合はしていない。(b) 2100 は個人の一括償却を「業務の用に供した年以後3年間」と書いており（R4）、年数 3 の根拠はこのページで足りる
- **Rationale**: Constitution VI、spec FR-022
- **Alternatives**: 一括償却の範囲を 1 つの key（上限だけ）にする → 下限（10 万円未満は少額で、償却資産でない）も判定に要る

## R14. マイグレーション

- **Decision**: 2 本を足す（001/R2・AGENTS.md の手順）:
  - `0011_depreciation`（`drizzle-kit generate` の出力を手で直す）: 新しい表 `straight_line_rates`・`deferred_assets`・`deferred_amortizations`、列の追加、CHECK を変える表（`fixed_assets`、`adjustment_journal_refs`、`tax_parameters`、`closing_audit_log`）の作り直し。007 の `0009_statement_sources.sql` と同じく、`PRAGMA defer_foreign_keys=ON` で、作り直した表は最終の名前で作って写す。新しい表と作り直した表は `) STRICT;`
  - `0012_depreciation_integrity`（`--custom`）: 償却率 49 行と税制の値 4 行の `INSERT`、作り直しで消えたトリガー（`adjustment_journal_refs_no_delete`、`closing_audit_log_no_update`・`_no_delete`。本文は `0004_tax_return_integrity.sql` と同じ）を作り直す。`deferred_amortizations` は更新を許し（R5）、削除をトリガーで禁止する
- 既存のデータの移行は考えない（開発中、AGENTS.md）。ただし作り直す表の行は写す（既存の dev のデータ場所で起動できるように。0009 と同じ）
- **確かめること**（db のテスト）: 新しい表と作り直した表が STRICT（`tenant-store.test.ts`）、トリガーが効く、`listStraightLineRates` が `STRAIGHT_LINE_RATES` と一致、`listTaxParameters` が `TAX_PARAMETERS` と一致（既存のテストがそのまま効く）
- **Alternatives**: 0003 を書き換える → 適用済みのデータ場所で動かない。CHECK を外して Zod だけで守る → 他の表と揃わず、DB の守りが減る

## R15. 不変条件とテスト

- **Decision**: data-model §4 に INV-55〜60 を足し、fast-check の性質テスト（`fc.assert(fc.property(...))` を直接呼ぶ。001/R6）で検証する。ジェネレーターは `packages/domain/test/blue-return-arbitraries.ts` に足す（取得日、供用日、取得価額、耐用年数 2〜50、事業専用割合、前年までの累計、除却日、開業費の総額・開業日・年度ごとの決定）。INV-59（台帳と帳簿の一致）は、生成した資産について供用の年から案を毎年 `FakeUnitOfWork` で登録し、各年度の `checkAssetRegister` の差と `DEPRECIATION_MISMATCH` が 0 件であることを見る
- 国税庁の計算例（R3 の 5 例、R4 の 2 例）は例のテスト（SC-001）
- **Rationale**: Constitution I・V

## R16. 利用者の確認（決定済み。利用者の回答 2026-11-01）

4 点とも推奨どおりに決まった。spec も合わせて直した（下の「spec の修正」）。

| # | 論点 | 選んだ案 | 退けた案 | 反映先 |
|---|---|---|---|---|
| Q1 | 定額法の資産を**売却**したとき | 除却の入力に種類（廃棄・売却）を足し、売却なら除却損の代わりに 事業主貸 / 資産の勘定（未償却残高）の案にする。譲渡所得の計算は範囲外のまま | 除却と同じ月割りの償却の案だけを作り、残りの振替は手で仕訳するよう知らせる | R8、data-model §1.3（`disposal_kind`）・§2.3、contracts の除却の入力、INV-55・57 |
| Q2 | アプリの前の年度（freee から取り込んだ年度）にすでに償却の仕訳がある資産 | `prior_through_year` をその年度にして、台帳の計算を翌年度から始める（取込済みの年度は 3 ページに載らず、その年度の欄 18 との不一致の警告は残る） | 定額法にも「既存の仕訳との結びつけ」を年度ごとに足す（結びつけの誤りを直す仕組みが要る。参照の行は消せない） | R1、R10 |
| Q3 | 一括償却資産の 3 ページの行と端数 | 資産ごとの行・資産ごとの端数（最終年度に寄せる）。差は 1・2 年度目で（資産の数 − 1）円以内で、3 年度目に戻る | 供用の年ごとにまとめた 1 行・合計額で端数 | R4 |
| Q4 | 帳簿と台帳の照合（FR-020）の対象の勘定 | 定額法・一括償却・開業費が使う勘定だけ | 1060・1070・1080 を常に対象にする | R10 |

## spec の修正（利用者の承認 2026-11-01）

- **一括償却の開始の年**: 「取得した年度から」を「事業の用に供した年度（供用日の入力がなければ取得日の年度）から」に直した（US2、FR-010）。法令（No.2100 注2）に合わせた
- **売却**: US1 シナリオ7 を足し、FR-009・Edge Cases・Key Entities（除却の種類）・Assumptions（譲渡所得の計算だけが範囲外）を Q1 に合わせた
- **変更の制限**: Edge Cases の「003 と同じく結びついた仕訳を取消してから」を、R12 の制限（どの年度でも有効な償却の仕訳があれば計算に効く項目を変えられない。少額の特例の資産にも掛かる。除却・開業費の決定も同じ。409 `DEPRECIATION_JOURNAL_EXISTS`）と一致する文言に直した

## R17. タスクごとの細部（テストの観点と手順）

tasks.md の 1 行を 500 字程度までにするため、タスクの細部をここに置く（tasks.md からは「R17/T0xx」で参照する）。式・制約・関数の形は data-model・contracts が正本で、ここは書かない。ここにあるのは、テストの観点と、他の節に書いていない手順・表示の文言だけ。

- **T001**: 確かめる 2 点: (1) 一括償却資産の取得価額の範囲（10 万円以上 20 万円未満）と年数（3）。(2) 開業費の均等償却の 60 か月（https://www.nta.go.jp/law/shitsugi/shotoku/04/08.htm ）。出典は R13 の表の URL と、`packages/domain/src/seed/tax-parameters.ts` の `MOF_FY2026` の URL（令和8年度の税制改正の大綱）、国税庁 No.2100（https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2100.htm ）。
- **T002**: Zod の定義は http-api §6。`apps/server/src/errors.ts` の `ERROR_STATUS`（`satisfies Record<ErrorCode, …>`）に http-api §1 の 6 コードの HTTP の値を足す。`apps/web/src/features/blue-return/FormPage3.tsx` の `METHOD_LABELS` に足す表示名は `straight_line`「定額法」・`lump_sum`「一括償却」・`deferred`「任意償却」（型エラーを防ぐだけ。列は T016）。参照を探す `grep -rn "DepreciationMethod\|AdjustmentKind\|BlueReturnWarningCode\|small_asset_28_2\|\"straight_line\"\|DEPRECIATION_METHOD_UNSUPPORTED" packages apps scripts` の結果は担当外のプロジェクトも直す。既存テストは `"straight_line"` を「サポートしない方法」の例（不正な値）に使っている（`apps/server/test/fixed-assets.api.test.ts` の 85-86 行、`packages/domain/test/blue-return/depreciation.test.ts` の 76-78 行、`usecase-fixed-asset.test.ts` の 126 行付近、`packages/schema/test/blue-return.test.ts` の 88 行付近、`packages/db/test/closing-schema.test.ts` の 199 行付近）。009 で `straight_line` は有効な方法になるので、これらの不正な値は列挙外の値 `"declining_balance"` に差し替える（`DEPRECIATION_METHOD_UNSUPPORTED` は 3 つの方法以外だけに返る）。テスト `packages/schema/test/blue-return.test.ts`: `priorAccumulated` -1・`disposalKind` の不明値・`amount` -1 を拒否する、省略時の既定値（`priorAccumulated` 0、`disposalKind` `scrap`）。
- **T003**: 足す項目: `FixedAsset` に `inServiceOn: string | null`・`priorAccumulated: number`・`priorThroughYear: number | null`・`disposalKind: "scrap" | "sale" | null`。`FakeClosingStore` の `insertAdjustmentRef` は `deferredAssetId` を持つ。`FixedAsset`・`AdjustmentRef` を作る箇所の探し方: `grep -rn "linkedJournalId\|allocationId:" packages apps scripts`。T002 の schema の変更（`DepreciationRow` の `source`・`ratePermille`・`months`・`disposedOn`、breakdown の union）で型が通らなくなる箇所: `packages/domain/src/blue-return/build.ts` の `depreciationRows`（130 行付近。少額の特例の行は `source: "fixed_asset"`、`ratePermille: null`、`months: null`、`disposedOn: a.disposedOn`）と、`depreciation.ts` の `proposeDepreciationAdjustment` が返す `AdjustmentProposal` の `breakdown`（少額の特例は data-model §2.1 の償却の形で `method: "small_asset_28_2"`、`months`・`ratePermille` は null、`openingBookValue` は取得価額、`closingBookValue` は 0、`disposalKind` は null、`disposalAmount`・`disposalDeductible` は 0）。呼び出し元（`usecases/blue-return.ts`、テスト、`scripts/`）は `pnpm typecheck` の出力で探す。既存のテストの期待値は、新しい項目の分だけ直す（金額は変えない）。
- **T004**: 足す場所は `packages/domain/src/` の下（`seed/` と `blue-return/`）。`seed/depreciation-rates.ts`（`effectiveFrom` 2007-04-01、`effectiveTo` null、出典は R2 の 3.pdf の URL）、`seed/accounts.individual.ts` に `["5300", "固定資産除却損", 30]`（`5290` と `5310` の間）、`blue-return/tax-parameters.ts` の `resolveStraightLineRate(usefulLifeYears, acquiredOn, rates)`（`resolveTaxParameter` と同じ選び方）。科目数・並びに依存するテストの探し方: `grep -rn "INDIVIDUAL_ACCOUNTS\|5310" packages apps scripts`。テスト `packages/domain/test/blue-return/tax-parameters.test.ts`: 率の表は耐用年数 2〜50 が 1 行ずつで、各値が `Math.ceil(1000 / n)` と一致する（転記の検算。計算はこの式で代えない）、2007-03-31 は undefined、4 年は 250、51 年は undefined、4 つの key の解決。科目数・並びに依存するテストは `seed-accounts.test.ts`、`form.test.ts` など。
- **T005**: テストを先に書く（`packages/db/test/closing-schema.test.ts`・`tenant-store.test.ts`）: 新しい表と作り直した表が STRICT、`fixed_assets`・`adjustment_journal_refs`・新規 3 表の各 CHECK の違反が失敗（`straight_line` で耐用年数 NULL、`disposal_kind` だけある行、`deferred_amortization` で `deferred_asset_id` NULL など）、`tax_parameters` に新しい key の行を入れられる。表・列がないので赤になる。実装の手順は次のとおり。生成のコマンド: `pnpm --filter @trebuchet/db exec drizzle-kit generate --config drizzle.tenant.config.ts`。手直しは `0009_statement_sources.sql` と同じ: 先頭のコメント、新しい表と作り直す表の `);` を `) STRICT;`、`PRAGMA defer_foreign_keys=ON`、最終の名前で作って行を写す（新しい列は既定値・NULL で写す）。
- **T006**: 生成のコマンド: `pnpm --filter @trebuchet/db exec drizzle-kit generate --custom --config drizzle.tenant.config.ts`。書くもの（R14）: `STRAIGHT_LINE_RATES` と同じ 49 行と T004 の 4 行の `INSERT`（既存の行は書き換えない）、作り直しで消えたトリガー `adjustment_journal_refs_no_delete`・`closing_audit_log_no_update`・`closing_audit_log_no_delete`（本文は `0004_tax_return_integrity.sql`）、新規 `deferred_amortizations` の削除禁止。テスト（先に書いて赤を確かめる。`packages/db/test/closing-schema.test.ts`・`tenant-store.test.ts`）: 作り直しで消えた 3 つのトリガーと `deferred_amortizations` の削除禁止が効く（更新・削除が失敗）、`tax_parameters` と償却率の表の行が `TAX_PARAMETERS`・`STRAIGHT_LINE_RATES`（domain の seed）と一致する（SQL で直接読んで比べる。リポジトリ経由の一致は T007）。CHECK・STRICT のテストは T005。
- **T007**: テスト `packages/db/test/closing-repository.test.ts`: 各メソッドの往復、`listStraightLineRates()` が `STRAIGHT_LINE_RATES` と一致、`listTaxParameters()` が `TAX_PARAMETERS`（4 行を含む）と一致（既存のテスト）、`listAdjustmentRefsBySource` が出所ごとに全年度を返す、`deferred_amortizations` の upsert が同じ PK の行を更新する。
- **T008**: ジェネレーターの範囲: `straightLineAssetArb` は取得日 2007-04-01 以後、供用日 ≥ 取得日、取得価額 1〜10^9、耐用年数 2〜50、割合 0〜10000、`prior_accumulated` と `prior_through_year` の組（data-model §1.3 の上限と CHECK を満たす）、除却の有無と `disposalKind`。`lumpSumAssetArb` は取得価額 100,000〜199,999。`deferredAssetArb` と、年度ごとの決定の列 `deferredDecisionsArb`。
- **T009**: テスト `packages/domain/test/blue-return/straight-line.test.ts`: R3 の 5 例（US1 シナリオ1 の 62,500・437,500、No.2106 の 100,000 と 10 年目の 99,999、シナリオ4 の累計、12 月供用 1/12、1 月供用 12/12）、除却の月まで（10 月除却で 4/12、`disposalAmount`）。`straight-line.property.test.ts`: INV-55（`straightLineAssetArb`）。
- **T010**: 少額の特例は 003 の値のまま新しい項目を埋める。呼び出し元の探し方: `grep -rn "depreciate(\|isDepreciationRow(\|validateFixedAsset(" packages apps scripts`。`validateFixedAsset` は `params.rates` と定額法の検査（エラーは D: §2 の表と http-api §1）、`depreciate` は率がなければ `TAX_PARAMETER_MISSING`。テスト `depreciation.test.ts`: 各エラーコードと details（`USEFUL_LIFE_UNSUPPORTED`、供用日 < 取得日の `VALIDATION`、`PRIOR_ACCUMULATED_INVALID`、他の方法の `linkedJournalId` の `VALIDATION`）、少額の特例の検査（累計 0・年 null・供用日 null）と既存のテストが通る。`isDepreciationRow` は除却の年度を載せる（R11）。
- **T011**: 摘要と `breakdown` に方法・月数・率・除却の種類を入れ、売却は「譲渡所得は範囲外」と書く。テスト `depreciation.test.ts`: quickstart §2 手順5 の金額（41,667・25,000・458,333・274,999・183,334）と売却の形。`depreciation.property.test.ts`: INV-57（廃棄・売却とも）と INV-23。
- **T012**: テスト `packages/domain/test/blue-return/asset-register.test.ts`: 一致、不一致、取得の年度（期首に含めない）、除却の翌年度（0）、飛ばす勘定（`prior_through_year ≥ 年度`）、少額の特例だけの勘定は対象外。
- **T013**: `buildBlueReturn` の入力に `straightLineRates`、3 ページの行に `source`・`ratePermille`・`months`・`disposedOn`。CSV の 3 ページの行に償却率と本年中の償却期間（`n/12`）。テスト `packages/domain/test/blue-return/build-depreciation.test.ts`、`csv.test.ts`、`build.property.test.ts`（INV-18・19 が定額法の資産と除却損の科目を含めても成り立つ）。
- **T014**: 変更の対象（`packages/domain/src/usecases/blue-return.ts`。行番号は変わるので関数名で探す）: `assessDepreciation`（601 行付近の `ProposalSources` を受け、年度ごとに `proposeDepreciationAdjustment` を呼ぶ。登録済みかは `listAdjustmentRefsBySource` と仕訳の状態で判定し、取り消された仕訳は未登録として案を戻す）、`ProposalSources`（今の closing の `Pick` に `listStraightLineRates`・`listTaxParameters` を足し、率・税制の値を `assessDepreciation` に渡す）、`rebuildProposal` と `commitAdjustment`（償却の案は資産・年度で再構築し、率・税制の値を渡す。登録後の同じ資産・年度の 2 回目は `ADJUSTMENT_NOT_NEEDED`、INV-60）。409 `DEPRECIATION_JOURNAL_EXISTS` は少額の特例の資産にも効く。テスト: `usecase-fixed-asset.test.ts`、`usecase-adjustment.test.ts`（少額の特例の資産にも制限が効くことを含む）、新規 `packages/domain/test/blue-return/depreciation-ledger.property.test.ts`（INV-59: `straightLineAssetArb` の資産を `startYear` から毎年 `FakeUnitOfWork` で登録して繰り越すと警告 0 件、INV-60: 2 回目の確定は `ADJUSTMENT_NOT_NEEDED`、取消で案が戻る）、`packages/db/test/closing-adjustment.test.ts` に INV-60 の統合テスト（実際の UnitOfWork）。
- **T015**: テスト `apps/server/test/fixed-assets.api.test.ts`: 定額法の登録と `?year=` の `depreciation`、422 `USEFUL_LIFE_UNSUPPORTED`・`PRIOR_ACCUMULATED_INVALID`、仕訳を登録した後の PUT と dispose が 409 `DEPRECIATION_JOURNAL_EXISTS`。`blue-return.api.test.ts`: 3 ページの新しい列。
- **T016**: ルートは足さないので `routeTree.gen.ts` の再生成は要らない。画面の内容: `FixedAssetForm.tsx` は方法の選択 3 つ、方法ごとの入力（定額法は耐用年数を必須、一括償却は耐用年数を出さない、供用日、前年までの累計とその年）。`DisposeDialog.tsx` は廃棄・売却の選択、売却に「譲渡所得の計算はこのアプリの範囲外」。台帳の一覧は年度の償却費・算入額・未償却残高、`depreciationError` の表示、409 のメッセージ。`FormPage3.tsx` は償却率・本年中の償却期間の列。`AdjustmentPanel.tsx` は償却の内訳（月数・率・除却の種類と金額）。`WarningList.tsx` は 2 つの新しい警告の表示。資産の保存・除却・案の登録の後に案・決算書の query が読み直されること: `lib/queries.ts` の `invalidateLedger` が案（`adjustments`）と決算書（`blue-return`）の query を含むかを確かめ、含まなければ `fixed-assets/api.ts` の呼び出しの後でその query key を無効にする（資産の保存・除却は仕訳を変えないので `invalidateLedger` 全体は要らない場合がある）。画面のテストで、保存の後に案の query が再取得されることを確かめる。
- **T017**: テスト `lump-sum.test.ts`: 150,000 円で 50,000 × 3 と 4 年度目 0、100,000 円で 33,333・33,333・33,334、供用の年から数える、前年までの累計、除却の有無で同じ額。`lump-sum.property.test.ts`: INV-56（`lumpSumAssetArb`）。`depreciation.test.ts`: 一括償却の資産が少額の特例の年間の上限の集計に入らない（FR-004）。あわせて API・画面・台帳と帳簿の一致のテストを足す（T015・T016 の実装が一括償却も通すので、これらは落ちたところだけ直す。domain のテストは赤を確かめる）: `apps/server/test/fixed-assets.api.test.ts` に 422 `LUMP_SUM_COST_OUT_OF_RANGE` と一括償却の `depreciation`、`apps/web/test/routes/fixed-assets.test.tsx` に一括償却の登録（耐用年数の欄が出ない）と 3 ページの「一括償却」の行、`depreciation-ledger.property.test.ts` の INV-59・60 に `lumpSumAssetArb`（`1070` の照合を含む）。INV-56 の性質テストに、除却しても額が変わらないことと、除却損が常に 0 であることを含める。
- **T018**: 月数・月の計算は `packages/domain/src/dates.ts`（`monthIndex`、`addMonths`、`monthOfDate`）を使い、月の算術を書き直さない。テスト `deferred-asset.test.ts`: US3 シナリオ1〜4 の値、60 か月を過ぎた年度の目安 0（上限は残る）、`DEFERRED_AMORTIZATION_OVER_LIMIT`（`details.limit`）、`PRIOR_ACCUMULATED_INVALID`、取り消された仕訳の決定は翌年度の上限を減らさない。`deferred-asset.property.test.ts`: INV-58（`deferredAssetArb`・`deferredDecisionsArb`）。
- **T019**: `buildBlueReturn` の入力に `deferredAssets`・`deferredAmortizations`・全年度の参照と仕訳の状態、3 ページの `deferredRows` は `source: "deferred_asset"`・`method: "deferred"`。テスト: `build-depreciation.test.ts`（開業費の行が欄 18 に含まれ一致する）、`build-page4.test.ts`（決定があれば知らせが出ない、開業費を登録していない 1080 の残高には出る）、`asset-register.test.ts`（開業費の照合）。
- **T020**: `getAdjustmentProposals` は開業費の案を最後に足し、締め済みの年度は返さない。`commitAdjustment` は `deferred_amortization` を受け、参照に `deferredAssetId` を入れる。`closing_audit_log` は `deferred_asset`・`deferred_amortization`、`target_id` は `開業費ID:年度`。テスト: `packages/domain/test/blue-return/usecase-deferred-asset.test.ts`（`saveDeferredAsset` の更新: 有効な償却の仕訳がない開業費は更新でき、有効な仕訳があれば計算に効く項目（総額・開業日・累計とその年・勘定）の変更が 409 `DEPRECIATION_JOURNAL_EXISTS`（`details.years`）、名称・備考だけの変更は通る、仕訳を取り消した後は更新できる。R12。更新は `closing_audit_log` に `reason` を残す）、`usecase-adjustment.test.ts`、`depreciation-ledger.property.test.ts` の INV-59・60 に開業費を足す、`packages/db/test/closing-adjustment.test.ts` に開業費の確定の全部か無か。
- **T021**: `POST .../adjustments` の `deferred_amortization` は入力の Zod が変わるだけ。テスト `apps/server/test/deferred-assets.api.test.ts`: 登録、更新（`PUT /deferred-assets/:deferredAssetId`、H: §3。仕訳がなければ 200、有効な償却の仕訳があって計算に効く項目を変えると 409 `DEPRECIATION_JOURNAL_EXISTS`）、一覧（`?year=` の `amortization`）、決定（0 円で `proposal: null`、上限超えで 422、仕訳の後の変更で 409、締め済みで `PERIOD_CLOSED`）、`adjustments` で開業費の仕訳が登録される。
- **T022**: ルートを足す場合は `pnpm --filter @trebuchet/web build` で `routeTree.gen.ts` を再生成してから typecheck。新規 `apps/web/src/features/deferred-assets/` の `api.ts`（query key と呼び出し）、`DeferredAssetForm.tsx`、`AmortizationDecision.tsx`。`apps/web/src/routes/e/$entityId/fixed-assets/index.tsx` に開業費の欄、`AdjustmentPanel.tsx` に開業費の内訳。`apps/web/test/mock-api.ts` の既定の応答は `"GET /deferred-assets": () => ok({ deferredAssets: [] })`。テスト `apps/web/test/routes/fixed-assets.test.tsx`: 開業費の登録・決定・上限超えのエラー表示。開業費の保存・決定・案の登録の後は、案（`adjustments`）・決算書（`blue-return`）・`deferred-assets` の query が読み直される（T016 と同じ確かめ方。画面のテストで再取得を確かめる）。`AmortizationDecision.tsx` は上限・目安を見せ、0〜上限の整数を入力、0 円は「償却しない」と表示。
- **T024**: `--closing` の JSON の形: `assets` に `method`・`inServiceOn`・`usefulLifeYears`・`priorAccumulated`・`priorThroughYear` を足し、新しく `deferredAssets: { name, totalAmount, openedOn, priorAccumulated, priorThroughYear, accountCode, decisions: { year, amount }[] }[]`。
- **T025**: `AGENTS.md` の「開発の進め方」の不変条件の索引の記述（`specs/INVARIANTS.md`（INV-1〜50 の索引…））を INV-1〜60 に直す（`specs/INVARIANTS.md` の見出しは INV-1〜60 になっている）。`AGENTS.md` の節「定額法・一括償却資産・開業費（009）」: 置き場所の表は `blue-return/straight-line.ts`・`lump-sum.ts`・`deferred-asset.ts`・`asset-register.ts`、`usecases/deferred-assets.ts`、`routes/deferred-assets.ts`、`features/deferred-assets/`。規則は、償却率の表の足し方（`seed/depreciation-rates.ts` とマイグレーションの両方、db のテストで一致）、額は資産の属性から計算し保存しない（ADR 0012）、変更の制限 409、除却の種類、開業費の決定。「決算書（003）」の節は少額の特例だけの記述を直す。
