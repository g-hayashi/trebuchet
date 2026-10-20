import { writeFileSync } from "node:fs";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity, errorOf } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;

const tr = client.api.entities[":entityId"]["tax-return"][":year"];
const memos = tr.memos;
const documents = tr.documents;
const blueReturn = client.api.entities[":entityId"]["blue-return"][":year"];

beforeEach(async () => {
  tmp = useTempDataDir("server-tax-return");
  entityId = await createTestEntity();
});
afterEach(() => tmp.cleanup());

const p = <T extends Record<string, string>>(extra?: T) =>
  ({ entityId, year: "2026", ...extra }) as { entityId: string; year: string } & T;

/** 一時の場所（.tmp/ の下）に作った実在するファイルの絶対パス */
const existingFile = () => {
  const path = `${tmp.dir}/withholding.pdf`;
  writeFileSync(path, "dummy");
  return path;
};
const missingFile = () => `${tmp.dir}/missing.pdf`;

type MemoJson = Parameters<typeof memos.$post>[0]["json"];
type DocJson = Parameters<typeof documents.$post>[0]["json"];

const postMemo = (json: Record<string, unknown>) =>
  memos.$post({ param: p(), json: json as MemoJson });
const postDoc = (json: Record<string, unknown>) =>
  documents.$post({ param: p(), json: json as DocJson });

describe("控え /tax-return/:year/memos（FR-033, FR-036）", () => {
  it("201 で作り、GET は年度ごとに fileExists を付けて返す", async () => {
    const exists = existingFile();
    const a = await postMemo({ kind: "salary", amount: 3_000_000, filePath: exists, memo: "源泉" });
    expect(a.status).toBe(201);
    await postMemo({ kind: "donation", filePath: missingFile() });
    await postMemo({ kind: "medical" });
    const res = await memos.$get({ param: p() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      memos: { kind: string; filePath: string | null; fileExists: boolean }[];
    };
    expect(body.memos.map((m) => [m.kind, m.fileExists])).toEqual([
      ["salary", true],
      ["donation", false],
      ["medical", false],
    ]);
    const other = await memos.$get({ param: p({ year: "2025" }) });
    expect(((await other.json()) as { memos: unknown[] }).memos).toEqual([]);
  });

  it("相対パスは 400、その他で項目名なしも 400", async () => {
    const rel = await postMemo({ kind: "salary", filePath: "docs/a.pdf" });
    expect(rel.status).toBe(400);
    expect((await errorOf(rel)).code).toBe("VALIDATION");
    const other = await postMemo({ kind: "other" });
    expect(other.status).toBe(400);
  });

  it("PUT で更新、DELETE で 204。ない id は 400", async () => {
    const created = await postMemo({ kind: "crypto", amount: 100 });
    const { memo } = (await created.json()) as { memo: { id: string } };
    const put = await memos[":memoId"].$put({
      param: p({ memoId: memo.id }),
      json: { kind: "crypto", amount: 200 } as MemoJson,
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { memo: { amount: number } }).memo.amount).toBe(200);
    const bad = await memos[":memoId"].$put({
      param: p({ memoId: memo.id }),
      json: { kind: "crypto", filePath: "relative.pdf" } as MemoJson,
    });
    expect(bad.status).toBe(400);
    const missing = await memos[":memoId"].$put({
      param: p({ memoId: "nope" }),
      json: { kind: "crypto" } as MemoJson,
    });
    expect(missing.status).toBe(400);
    const del = await memos[":memoId"].$delete({ param: p({ memoId: memo.id }) });
    expect(del.status).toBe(204);
    const list = await memos.$get({ param: p() });
    expect(((await list.json()) as { memos: unknown[] }).memos).toEqual([]);
    const again = await memos[":memoId"].$delete({ param: p({ memoId: memo.id }) });
    expect(again.status).toBe(400);
  });

  it("控えを足しても決算書の値は変わらない（FR-034）", async () => {
    const before = await (await blueReturn.$get({ param: p() })).json();
    await postMemo({ kind: "salary", amount: 9_999_999 });
    await postDoc({ kind: "blue_return", filePath: "/x/y.pdf" });
    const after = await (await blueReturn.$get({ param: p() })).json();
    expect(after).toEqual(before);
  });
});

describe("書類 /tax-return/:year/documents（FR-035, FR-036）", () => {
  it("201 で作り、GET は fileExists を付けて返す", async () => {
    const a = await postDoc({
      kind: "blue_return",
      filePath: existingFile(),
      filedOn: "2027-03-10",
      memo: "e-Tax",
    });
    expect(a.status).toBe(201);
    await postDoc({ kind: "attachment", filePath: missingFile() });
    const res = await documents.$get({ param: p() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documents: { kind: string; filedOn: string | null; fileExists: boolean }[];
    };
    expect(body.documents.map((d) => [d.kind, d.filedOn, d.fileExists])).toEqual([
      ["blue_return", "2027-03-10", true],
      ["attachment", null, false],
    ]);
  });

  it("相対パス・パスなし・提出日の形の誤りは 400", async () => {
    for (const json of [
      { kind: "other", filePath: "a.pdf" },
      { kind: "other" },
      { kind: "other", filePath: "/a.pdf", filedOn: "2027-13-40" },
    ]) {
      const res = await postDoc(json);
      expect(res.status).toBe(400);
    }
  });

  it("PUT で更新、DELETE で 204", async () => {
    const created = await postDoc({ kind: "tax_return", filePath: "/a/b.pdf" });
    const { document } = (await created.json()) as { document: { id: string } };
    const put = await documents[":documentId"].$put({
      param: p({ documentId: document.id }),
      json: { kind: "tax_return", filePath: "/a/c.pdf", filedOn: "2027-03-15" } as DocJson,
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { document: { filePath: string } }).document.filePath).toBe(
      "/a/c.pdf",
    );
    const del = await documents[":documentId"].$delete({ param: p({ documentId: document.id }) });
    expect(del.status).toBe(204);
    const list = await documents.$get({ param: p() });
    expect(((await list.json()) as { documents: unknown[] }).documents).toEqual([]);
  });
});

describe("法人の事業体", () => {
  it("8つとも 422 ENTITY_KIND_UNSUPPORTED", async () => {
    const res0 = await client.api.entities.$post({
      json: { name: "法人", kind: "corporation", fiscalStartMonth: 4, firstFiscalYear: 2026 },
    });
    const corpId = ((await res0.json()) as { entity: { id: string } }).entity.id;
    const c = client.api.entities[":entityId"]["tax-return"][":year"];
    const q = { entityId: corpId, year: "2026" };
    const r = { ...q, memoId: "m", documentId: "d" };
    const memoJson = { kind: "salary" } as MemoJson;
    const docJson = { kind: "other", filePath: "/a" } as DocJson;
    const responses = [
      await c.memos.$get({ param: q }),
      await c.memos.$post({ param: q, json: memoJson }),
      await c.memos[":memoId"].$put({ param: r, json: memoJson }),
      await c.memos[":memoId"].$delete({ param: r }),
      await c.documents.$get({ param: q }),
      await c.documents.$post({ param: q, json: docJson }),
      await c.documents[":documentId"].$put({ param: r, json: docJson }),
      await c.documents[":documentId"].$delete({ param: r }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe("ENTITY_KIND_UNSUPPORTED");
    }
  });
});
