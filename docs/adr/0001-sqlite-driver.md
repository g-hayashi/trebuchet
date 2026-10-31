# ADR 0001: SQLite ドライバーに better-sqlite3 を使う

- 状態: 採用（ドライバーは 2026-10-30 に `better-sqlite3-multiple-ciphers` へ変更。[ADR 0011](0011-passkey-prf-vault.md)）
- 日付: 2026-10-18
- 関連: specs/001-ledger-core/research.md R1, R2、[ADR 0011](0011-passkey-prf-vault.md)

> **変更（2026-10-30、008）**: DB を暗号化するため、ドライバーを `better-sqlite3-multiple-ciphers` 13.0.3 に替えた。API は `better-sqlite3` と同じ（同期、同じバイナリの形式）で、SQLCipher 方式の暗号（`PRAGMA cipher='sqlcipher'`、`PRAGMA key`）を持つ。ビルド済みバイナリが同梱され、ビルドのスクリプトは今も要らない。`drizzle-orm/better-sqlite3` の `drizzle()` は実行時に `better-sqlite3` を import するので、`packages/db/src/driver.ts` が同じ組み立てを行う。以下の本文は 001 の時点の決定の記録で、「`better-sqlite3`」は読み替える。

## 状況

帳簿データは事業体ごとの SQLite ファイルに保存する。「検証 → 仕訳の書込 → 監査ログの追記」を1つのトランザクションで確実に行いたい。Node 26 で使える候補は、better-sqlite3（ネイティブ拡張）と、Node 組み込みの `node:sqlite`（Stability 1.2 = RC）。

## 決定

`better-sqlite3` 13 と `drizzle-orm/better-sqlite3` を使う。

## 理由

- 同期 API のため、トランザクションの中で検証と書込を素直に書ける
- Drizzle の安定版（0.45）が正式に対応している。`node:sqlite` のドライバーは rc 版のみ
- PoC（2026-10-18, Node 26.9.0, macOS arm64）で、必要な機能をすべて確認した
  - ビルド済みバイナリ（`prebuilds/darwin-arm64.node`）が同梱されており、ビルドスクリプトもコンパイラも不要
  - STRICT テーブル、トリガーによる削除の禁止、CHECK 制約、同期トランザクションのロールバック

## 検討した代替案

- `node:sqlite`: 依存を増やさずに済み、PoC でも同じ項目が動いた。Drizzle の対応が安定したら再検討する
- `@libsql/client`: 非同期 API でトランザクションの扱いが複雑になる。リモート同期は不要

## 影響

- DB へのアクセスは `packages/db` のリポジトリの実装に閉じ込める。ドライバーを差し替えるときの影響はこのパッケージだけ
- 型定義は `@types/better-sqlite3` を使う（008 以降も同じ型を使う。`better-sqlite3-multiple-ciphers` は型を見つけられないので、`packages/db/src/better-sqlite3-multiple-ciphers.d.ts` で `@types/better-sqlite3` の型を当てる）
- 主キーの UUIDv7 は `import { randomUUIDv7 } from "node:crypto"` で生成する（グローバルの `crypto` にはない）
- TypeScript は `tsx` を使わず、Node の型の除去で直接実行する（`erasableSyntaxOnly`、import に `.ts` を付ける）
