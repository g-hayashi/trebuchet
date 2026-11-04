import { clearDataKey } from "@trebuchet/db";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createInvoicingTestContext, type InvoicingTestContext } from "./invoicing-helpers.ts";

let tmp: TempDataDir;
let ctx: InvoicingTestContext;
beforeEach(async () => {
  tmp = useTempDataDir("draft-api");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());
const draft = {
  mode: "detailed" as const,
  date: "2026-",
  memo: "未完成",
  partnerId: null,
  tagIds: [],
  lines: [
    {
      side: "debit" as const,
      accountId: null,
      subAccountId: null,
      amount: null,
      taxCategory: null,
      partnerId: "入力中",
      tagIds: ["入力中"],
      description: "行説明",
    },
  ],
};

it("空の取得、全置換、完全復元、何度でも削除", async () => {
  const api = ctx.e["journal-draft"];
  expect(await (await api.$get({ param: ctx.param })).json()).toEqual({
    draft: null,
    updatedAt: null,
  });
  const put = await api.$put({ param: ctx.param, json: draft });
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ updatedAt: "2026-10-31T03:00:00.000Z" });
  expect(await (await api.$get({ param: ctx.param })).json()).toMatchObject({ draft });
  const other = await createInvoicingTestContext();
  expect(await (await other.e["journal-draft"].$get({ param: other.param })).json()).toEqual({
    draft: null,
    updatedAt: null,
  });
  for (let i = 0; i < 2; i++) expect((await api.$delete({ param: ctx.param })).status).toBe(204);
  expect(await (await api.$get({ param: ctx.param })).json()).toEqual({
    draft: null,
    updatedAt: null,
  });
});

it("入力上限違反は400で既存値を変えない", async () => {
  const api = ctx.e["journal-draft"];
  await api.$put({ param: ctx.param, json: draft });
  for (const invalid of [
    { ...draft, memo: "a".repeat(1001) },
    { ...draft, lines: Array(51).fill(draft.lines[0]) },
    { ...draft, lines: [{ ...draft.lines[0], amount: 1.5 }] },
  ]) {
    expect((await api.$put({ param: ctx.param, json: invalid })).status).toBe(400);
  }
  expect(await (await api.$get({ param: ctx.param })).json()).toMatchObject({ draft });
});

it("存在しないentityは404、施錠中はアクセス不可", async () => {
  const api = ctx.e["journal-draft"];
  expect(
    (await api.$get({ param: { entityId: "0191f5a0-0000-7000-8000-000000000000" } })).status,
  ).toBe(404);
  clearDataKey();
  for (const response of [
    await api.$get({ param: ctx.param }),
    await api.$put({ param: ctx.param, json: draft }),
    await api.$delete({ param: ctx.param }),
  ])
    expect(response.status).toBe(401);
});
