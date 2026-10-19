import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { createTestEntity, type ErrorBody } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;

beforeEach(async () => {
  tmp = useTempDataDir("server-imports-upload");
  entityId = await createTestEntity();
});
afterEach(() => tmp.cleanup());

const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/domain/test/fixtures/freee/${name}`, import.meta.url));

const preview = (body: FormData | string, headers?: Record<string, string>) =>
  app.request(`/api/entities/${entityId}/imports/freee/preview`, {
    method: "POST",
    body,
    ...(headers === undefined ? {} : { headers }),
  });

const formWith = (file: File | string | undefined) => {
  const form = new FormData();
  if (file !== undefined) form.append("file", file);
  return form;
};

const errorOf = async (res: Response) => ((await res.json()) as ErrorBody).error;

describe("POST /imports/freee/preview のアップロード（T016）", () => {
  it("5 MB を超えるファイルは 413 FILE_TOO_LARGE", async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.csv", { type: "text/csv" });
    const res = await preview(formWith(big));
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("FILE_TOO_LARGE");
  });

  it("Content-Length が 5 MB を超える要求は 413 FILE_TOO_LARGE", async () => {
    const body = "x".repeat(6 * 1024 * 1024);
    const res = await preview(body, {
      "content-type": "text/plain",
      "content-length": String(body.length),
    });
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("FILE_TOO_LARGE");
  });

  it("ちょうど 5 MB のファイルは大きさでは拒まない", async () => {
    const file = new File([new Uint8Array(5 * 1024 * 1024)], "max.csv", { type: "text/csv" });
    const res = await preview(formWith(file));
    expect(res.status).not.toBe(413);
  });

  it("file がない → 400 VALIDATION", async () => {
    const res = await preview(formWith(undefined));
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({ issues: [{ path: ["file"] }] });
  });

  it("file がファイルでない（文字列）→ 400 VALIDATION", async () => {
    const res = await preview(formWith("取引日,金額"));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("freee 以外の CSV → 422 IMPORT_UNKNOWN_FORMAT（期待した種類と欠けている列を返す）", async () => {
    const csv = new File(["日付,金額,摘要\n2025-01-01,100,テスト\n"], "other.csv", {
      type: "text/csv",
    });
    const res = await preview(formWith(csv));
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("IMPORT_UNKNOWN_FORMAT");
    expect(error.details).toMatchObject({ expected: "journal" });
    const { missingColumns } = error.details as { missingColumns: unknown };
    expect(Array.isArray(missingColumns) && missingColumns.length > 0).toBe(true);
  });

  it("仕訳帳の代わりに総勘定元帳 → 422 IMPORT_WRONG_KIND", async () => {
    const ledger = new File([fixture("ledger-2025.csv")], "ledger.csv", { type: "text/csv" });
    const res = await preview(formWith(ledger));
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("IMPORT_WRONG_KIND");
    expect(error.details).toMatchObject({ expected: "journal", actual: "ledger" });
  });

  it("freee の仕訳帳 → 200 で判別の結果とファイルの SHA-256 を返す（暫定の応答）", async () => {
    const bytes = fixture("journal-2025.csv");
    const journal = new File([bytes], "journal-2025.csv", { type: "text/csv" });
    const res = await preview(formWith(journal));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      file: { name: string; sha256: string; kind: string; encoding: string; rowCount: number };
    };
    expect(body.file).toMatchObject({
      name: "journal-2025.csv",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      kind: "journal",
      encoding: "utf-8",
    });
    expect(body.file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.file.rowCount).toBeGreaterThan(0);
  });
});
