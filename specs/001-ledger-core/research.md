# Research: 001-ledger-core

調査日: 2026-10-18。出典の詳細は調査メモ（セッションの `research-stack.md`）を参照。
バージョンは調査時点の最新の安定版。実装時に `pnpm add` で解決される版を正とし、メジャーが変わる場合は再検討する。

## R1. SQLite ドライバー

- **Decision**: `better-sqlite3`（13.x）＋ `drizzle-orm/better-sqlite3`
- **Rationale**: 同期 API のため、「検証 → 仕訳の書込 → 監査ログの追記」を1トランザクションで素直に書ける。Drizzle の安定版が正式に対応している。実績が多い。
- **Risk**: Node 26（ABI）向けのビルド済みバイナリがあるかは未確認。ない場合はローカルでのビルドが必要（Xcode Command Line Tools）。
- **Gate**: tasks の最初に PoC を置く（インストール、STRICT テーブル、トリガーによる削除の禁止、Drizzle からの接続、`crypto.randomUUIDv7`）。
- **Alternatives**:
  - `node:sqlite`（Node 組み込み, Stability 1.2 = RC）: ネイティブのビルドが不要で、Tauri 化にも有利。ただし Drizzle のドライバーは rc 系のみ。**PoC が失敗した場合の代替**とする。リポジトリのポート（[contracts/domain-module.md](./contracts/domain-module.md)）の背後に閉じ込めるため、差し替えの影響は `packages/db` に限られる。
  - `@libsql/client`: 非同期 API でトランザクションの扱いが複雑になる。リモート同期は不要なため不採用。

## R2. ORM とマイグレーション

- **Decision**: `drizzle-orm` 0.45 系（安定版）＋ `drizzle-kit` 0.31 系。スキーマは TypeScript で定義し、`drizzle-kit generate` で SQL を生成してリポジトリに含める。テナント DB を開くときに `migrate()` を実行し、未適用のマイグレーションを当てる。
- **Rationale**: v1 は RC のため、安定版を使う。すべてのテナント DB に同じ SQL を当てるだけなので、「起動時・テナントを開くときに migrate」が最も単純。
- **補足**: トリガー（削除の禁止、監査ログの追記のみ）、ビュー `v_unbalanced_journals`、`STRICT` は Drizzle のスキーマ定義で表現できないため、`drizzle-kit generate --custom` で手書きの SQL マイグレーションとして追加する。
- **Alternatives**: Kysely（型安全なクエリビルダー、マイグレーションは自前）。Drizzle の方が学習資料が多く、スキーマから型を得られるため不採用。

## R3. API 層

- **Decision**: `hono` 4.x ＋ `@hono/node-server` 2.1.3 以降（セキュリティ修正を含む）。バリデーションは `@hono/standard-validator` ＋ Zod 4。クライアントは `hono/client` の `hc<AppType>`（RPC）で、サーバーの型をフロントで共有する。
- **Rationale**: OpenAPI の生成やコード生成なしで、エンドツーエンドの型安全が得られる。Standard Schema 経由のため、将来のバリデーターの差し替えにも強い。
- **注意**: RPC の型推論には `tsconfig` の `strict: true` が必要。ルートはメソッドチェーンで定義し、`AppType` を export する。
- **Alternatives**: tRPC（Hono の RPC で足りる）、`@hono/zod-openapi`（外部公開しないため OpenAPI は不要）。

## R4. フロントエンド

| 項目 | Decision | 理由 |
|---|---|---|
| UI | React 19 ＋ Vite 8 | 確定済みのスタック |
| ルーター | TanStack Router（ファイルベース） | 検索パラメータ（帳票の期間、検索条件）を型安全に扱える。URL で帳票の状態を共有できる |
| サーバー状態 | TanStack Query | キャッシュの無効化（仕訳の登録後に帳票を更新）が簡単 |
| フォーム | React Hook Form ＋ Zod resolver | 仕訳行の可変長の入力（`useFieldArray`）の実績が多い |
| 表 | TanStack Table | 元帳・試算表の表示。行数が少ないため仮想化は不要 |
| スタイル | Tailwind CSS 4 ＋ shadcn/ui | コンポーネントのコードを手元に持てる。学習しやすい |

- **Alternatives**: React Router 8（比較は未完。TanStack Router の型安全な検索パラメータを優先）、TanStack Form（RHF の方が実績が多い）。

## R5. 金額の表現

- **Decision**: `number`（整数）。ブランド型 `Yen` と、Zod の `z.number().int().positive().lt(1e12)` で境界を検証する。DB は `INTEGER`。
- **Rationale**: 1兆円未満の和は、年数千件でも `Number.MAX_SAFE_INTEGER`（約9千兆）に十分収まる。`bigint` は JSON・Drizzle・UI での変換コストが大きい。
- **内税額**: `Math.floor(amount * rate / (100 + rate))`。`amount < 1e12` かつ `rate <= 10` で、乗算は安全な整数の範囲に収まる。

## R6. テスト

- **Decision**: Vitest 5 ＋ fast-check 4。fast-check は `fc.assert(fc.property(...))` を直接使う。`@fast-check/vitest` は API を確認できていないため、最初は採用しない。
- **プロパティの対象**: data-model.md の INV-1〜10。仕訳のジェネレーター（ランダムな科目・金額・行数で、貸借が一致する仕訳）を `packages/domain/test/arbitraries.ts` に置き、各帳票の不変条件を検証する。
- **統合テスト**: テンポラリの SQLite ファイル（テスト用ディレクトリ配下）でリポジトリとトリガーを検証する。
- **E2E**: Playwright で主要な流れ（事業体の作成 → 仕訳の登録 → 試算表）を1本。
- **SC-008（R7 の決算書との一致）**: 実データはリポジトリに含めない（Constitution V）。`work/` を読む **ローカル専用の検証スクリプト** として 002（freee 取込）で実施する。001 では、匿名化した小さなフィクスチャで PL・BS の数値を検証する。

## R7. Lint・型検査

- **Decision**: Biome 2（lint と format）。型検査は TypeScript 7（`tsc --noEmit`）。
- **Rationale**: Biome は TypeScript の Compiler API に依存しないため、TS 7 と組み合わせられる。typescript-eslint は TS 7.0 の API に未対応。
- **Alternatives**: ESLint ＋ Prettier（設定が多い。TS 7.1 以降に再検討）。

## R8. ID と仕訳番号

- **Decision**: 主キーは UUIDv7（`crypto.randomUUIDv7()`、Node 26.1 以降）。仕訳番号は別に、事業体内の通し番号（`INTEGER`, UNIQUE）をトランザクション内で `max + 1` で採番する。
- **Rationale**: UUIDv7 は時系列順だが単調性が保証されないため、表示用の番号は別に持つ（FR-016）。
- **Alternatives**: ULID（外部ライブラリが必要）、自動採番の整数の主キー（後で取込・同期するときに衝突しやすい）。

## R9. リポジトリの構成

- **Decision**: pnpm workspace の monorepo。`apps/server`、`apps/web`、`packages/domain`、`packages/schema`、`packages/db`。
- **Rationale**: ドメイン層をフレームワークから独立させる（Constitution VII）。後の Tauri 化では `apps/web` と `packages/*` を再利用できる。
- **Alternatives**: 単一パッケージ（境界がコードレビュー頼みになるため不採用）。Turborepo・Nx（規模が小さく不要）。

## R10. 勘定科目の初期セット

- **Decision**: 青色申告決算書（一般用）の損益計算書の欄（1〜45）と貸借対照表の科目に、過去3年に使った任意科目（会議費、諸会費、支払手数料、新聞図書費）を加える。欄番号を科目に持たせる。
- **Rationale**: 決算書への転記（FR-10, フェーズ4）を、科目の欄番号の集計だけで実現できる。
- **出典**: 国税庁「青色申告決算書（一般用）」の様式。過去の決算書の分析（`analysis-tax-return.md`）。

## R11. 訂正の方式

- **Decision**: 締め前の年度は、監査ログに変更前のスナップショットを残して書き換える。締め済みの年度は書き換えず、当年度に訂正仕訳（`corrects_journal_id` つき）を起票する。
- **Rationale**: 利用者の決定（2026-10-18, C案）。電子帳簿保存法の訂正削除履歴の要件は、変更前の内容を保持することで満たす。
- **Alternatives**: 逆仕訳のみ（仕訳帳が読みにくくなる）、書き換えのみ（申告後の帳簿が変わる）。

## R12. 性能

- **Decision**: 帳票は「期間内の有効な仕訳行」を1クエリで取得し、ドメインの純関数でメモリ上で集計する。インデックスは `journals(date)`、`journal_lines(account_id)`、`journal_lines(partner_id)`。
- **Rationale**: 年2,000仕訳 × 3行 ≒ 6,000行。メモリ上の集計は数ミリ秒で、SC-004（1秒以内）を十分に満たす。集計ロジックを純関数にすると、プロパティテストがしやすい。
- **Alternatives**: SQL の集計（GROUP BY）。速いが、ロジックが SQL に分散してテストしにくい。

## R13. 実行環境とアクセス

- **Decision**: 001 では `127.0.0.1` だけで待ち受ける。Tailscale 経由のアクセスとパスキーは 003 で追加する。データは `data/`（`.gitignore` 済み）に置き、パスは環境変数 `TREBUCHET_DATA_DIR` で変更できる。
- **Rationale**: 認証がない状態でネットワークに公開しない（Constitution III）。
