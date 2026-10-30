// better-sqlite3-multiple-ciphers 13 は package.json の exports が型（index.d.ts）を指さず、nodenext の解決で
// 型が見つからない。API は better-sqlite3 と同じなので、drizzle-orm も使う @types/better-sqlite3 の型を当てる
// （暗号の設定は `pragma` で行い、独自の `key()`・`rekey()` は使わない）。`driver.ts` が参照する
declare module "better-sqlite3-multiple-ciphers" {
  import Database = require("better-sqlite3");
  export = Database;
}
