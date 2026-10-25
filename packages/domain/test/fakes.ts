/**
 * ユースケースのテスト用のフェイク（メモリ上の実装）。実体はストアごとに `fakes/` に分けてあり、
 * このファイルは再エクスポートだけを持つ
 */
export * from "./fakes/auth.ts";
export * from "./fakes/closing.ts";
export * from "./fakes/core.ts";
export * from "./fakes/import.ts";
export * from "./fakes/invoicing.ts";
export * from "./fakes/ledger.ts";
export * from "./fakes/master.ts";
export * from "./fakes/recurring.ts";
export * from "./fakes/unit-of-work.ts";
