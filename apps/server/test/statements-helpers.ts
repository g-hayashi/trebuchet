import { readFileSync } from "node:fs";
import type { StatementColumnMapping } from "@trebuchet/schema";
import { expect } from "vitest";
import { okBody } from "./helpers.ts";

/**
 * 明細の取込（007 の multipart: `file` と `options`）の server のテストの共通部品。
 * 取込のルートは multipart で受けるので、hc の型つきの `form` は使えない。`$post({ param }, { init: { body } })` で送る
 */

type Post = (
  args: { param: { entityId: string } },
  options: { init: RequestInit },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** `e.statements.imports`（preview と commit だけを使う） */
export type StatementImports = { preview: { $post: Post }; $post: Post };
export type StatementParam = { entityId: string };

const FIXTURES = new URL("../../../packages/domain/test/fixtures/statements/", import.meta.url);

/** 合成のフィクスチャのファイルをバイト列で読む（`packages/domain/test/fixtures/statements/`） */
export const readStatementFixture = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(new URL(name, FIXTURES)));

/** multipart の本体。`options` は JSON にする（文字列ならそのまま。壊れた JSON のテスト用） */
export function statementForm(
  file: string | Uint8Array<ArrayBuffer> | undefined,
  options: unknown,
  name = "statement.txt",
): FormData {
  const form = new FormData();
  if (file !== undefined) form.append("file", new File([file], name, { type: "text/plain" }));
  if (options !== undefined) {
    form.append("options", typeof options === "string" ? options : JSON.stringify(options));
  }
  return form;
}

/** 日付・内容・金額（円）・保有金融機関・メモ・振替のタブ区切り（見出しは先頭の行）の対応 */
export const SIMPLE_MAPPING: StatementColumnMapping = {
  delimiter: "\t",
  headerRow: 0,
  columns: {
    date: 0,
    content: 1,
    amount: 2,
    accountName: 3,
    memo: 4,
    transferFlag: 5,
  },
  amountSign: "inflow_positive",
};

export const SIMPLE_HEADER = ["日付", "内容", "金額（円）", "保有金融機関", "メモ", "振替"].join(
  "\t",
);

export type ImportOptions = {
  mapping?: StatementColumnMapping;
  year?: number;
  origin?: "paste" | "file";
  fixedAccountName?: string;
  /** 未対応の口座の対応（既定は空。先に `statement-accounts` で対応させておく） */
  accounts?: unknown[];
  encoding?: "utf-8" | "shift_jis";
};

/** preview → commit。ファイルのバイト列（または文字列）を正しい対応で取り込み、commit の本文を返す */
export async function importStatementFile(
  imports: StatementImports,
  param: StatementParam,
  file: string | Uint8Array<ArrayBuffer>,
  {
    mapping = SIMPLE_MAPPING,
    year = 2026,
    origin = "paste",
    fixedAccountName,
    accounts = [],
    encoding,
  }: ImportOptions = {},
) {
  const base = {
    origin,
    year,
    mapping,
    ...(fixedAccountName === undefined ? {} : { fixedAccountName }),
    ...(encoding === undefined ? {} : { encoding }),
  };
  const previewRes = await imports.preview.$post(
    { param },
    { init: { method: "POST", body: statementForm(file, base) } },
  );
  expect(previewRes.status).toBe(200);
  const preview = (await previewRes.json()) as { inputSha256: string; countNew: number };
  const res = await imports.$post(
    { param },
    {
      init: {
        method: "POST",
        body: statementForm(file, {
          ...base,
          expected: { inputSha256: preview.inputSha256, countNew: preview.countNew },
          accounts,
          saveSource: null,
        }),
      },
    },
  );
  expect(res.status).toBe(201);
  return okBody(res) as Promise<{ added: number; changed: number }>;
}

/** 見出し（`SIMPLE_HEADER`）と行（タブ区切り）を貼り付けとして取り込む（日付 `MM/DD(曜)`・内容・金額・口座・メモ・振替） */
export const importStatementLines = (
  imports: StatementImports,
  param: StatementParam,
  ...lines: string[]
) => importStatementFile(imports, param, [SIMPLE_HEADER, ...lines].join("\n"));
