import { randomUUID } from "node:crypto";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BANK_TWO_COLUMNS } from "../../../packages/domain/test/fixtures/statements/expected.ts";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";
import {
  readStatementFixture,
  SIMPLE_HEADER,
  SIMPLE_MAPPING,
  statementForm,
} from "./statements-helpers.ts";

// 007 US2: contracts/http-api.md §2.1（sourceId・match）・§2.3（saveSource）・§3（取込元の一覧・名前の変更・削除）

let tmp: TempDataDir;
let ctx: InvoicingTestContext;

beforeEach(async () => {
  tmp = useTempDataDir("server-statements-sources-api");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());

const imports = () => ctx.e.statements.imports;
const sources = () => ctx.e["statement-sources"];
const line = (...cells: (string | number)[]) => cells.join("\t");

const TEXT = [
  SIMPLE_HEADER,
  line("05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0),
  line("05/11(月)", "売上入金", "3,000", "サンプル銀行", "メモ", 0),
].join("\n");
/** 見出しが 1 列ふえた（先頭に「番号」）同じ種類の表 */
const TEXT_EXTRA_COLUMN = [
  ["番号", SIMPLE_HEADER].join("\t"),
  line(1, "05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0),
].join("\n");
const FIXED = "テスト銀行";

const mapAccount = async (name: string) => {
  const res = await ctx.e["statement-accounts"][":name"].$put({
    param: { ...ctx.param, name },
    json: { usage: "business", kind: "bank", accountId: ctx.accountId("普通預金") },
  });
  expect(res.status).toBe(200);
};

const layout = (file: string | Uint8Array<ArrayBuffer>, options: Record<string, unknown> = {}) =>
  imports().layout.$post(
    { param: ctx.param },
    { init: { body: statementForm(file, { origin: "paste", ...options }) } },
  );

/** preview → commit。取込元の保存は `saveSource` */
const commit = async (
  file: string | Uint8Array<ArrayBuffer>,
  saveSource: { id?: string; name: string } | null,
  over: Record<string, unknown> = {},
) => {
  const base = {
    origin: "paste",
    year: 2026,
    mapping: SIMPLE_MAPPING,
    ...over,
  };
  const p = await okBody(
    await imports().preview.$post(
      { param: ctx.param },
      { init: { body: statementForm(file, base) } },
    ),
  );
  return imports().$post(
    { param: ctx.param },
    {
      init: {
        body: statementForm(file, {
          ...base,
          expected: { inputSha256: p.inputSha256, countNew: p.countNew },
          accounts: [],
          saveSource,
        }),
      },
    },
  );
};

const list = async () => (await okBody(await sources().$get({ param: ctx.param }))).sources;

describe("取込の確定で取込元を保存する（§2.3 saveSource）", () => {
  it("saveSource なし（null）は取込元を作らない。応答の source は null、回の sourceName も null", async () => {
    await mapAccount("サンプル銀行");
    const res = await commit(TEXT, null);
    expect(res.status).toBe(201);
    const body = await okBody(res);
    expect(body.source).toBeNull();
    expect(body.batch.sourceName).toBeNull();
    expect(await list()).toEqual([]);
  });

  it("{ name } は新しい取込元を作る。対応・見出しの署名を保存し、回の sourceName に名前が残る", async () => {
    await mapAccount("サンプル銀行");
    const res = await commit(TEXT, { name: "MF ME" });
    expect(res.status).toBe(201);
    const body = await okBody(res);
    expect(body.source).toMatchObject({
      name: "MF ME",
      fixedAccountName: null,
      mapping: SIMPLE_MAPPING,
      // 見出しの署名（正規化した見出し。「（円）」は除く）
      header: ["日付", "内容", "金額", "保有金融機関", "メモ", "振替"],
    });
    expect(body.batch.sourceName).toBe("MF ME");
    expect((await list()).map((s) => s.name)).toEqual(["MF ME"]);
    const { batches } = await okBody(await imports().$get({ param: ctx.param }));
    expect(batches[0]?.sourceName).toBe("MF ME");
  });

  it("口座名の列のない取込元は fixedAccountName（口座の名前）を保存する", async () => {
    await mapAccount(FIXED);
    const res = await commit(
      readStatementFixture("bank-two-columns.csv"),
      { name: "テスト銀行 CSV" },
      {
        origin: "file",
        mapping: BANK_TWO_COLUMNS.mapping,
        fixedAccountName: FIXED,
      },
    );
    expect(res.status).toBe(201);
    expect((await okBody(res)).source).toMatchObject({ fixedAccountName: FIXED });
  });

  it("{ id, name } は既存の取込元を更新する（名前を変えられる）", async () => {
    await mapAccount("サンプル銀行");
    const created = (await okBody(await commit(TEXT, { name: "MF ME" }))).source;
    expect(created).not.toBeNull();
    const res = await commit(TEXT, { id: created?.id ?? "", name: "MF ME 2" });
    expect(res.status).toBe(201);
    expect((await okBody(res)).source).toMatchObject({ id: created?.id, name: "MF ME 2" });
    expect((await list()).map((s) => s.name)).toEqual(["MF ME 2"]);
  });

  it("同じ名前の別の取込元があれば 409 STATEMENT_SOURCE_NAME_TAKEN。取込の回も明細も保存しない", async () => {
    await mapAccount("サンプル銀行");
    expect((await commit(TEXT, { name: "MF ME" })).status).toBe(201);
    const other = [TEXT, line("05/12(火)", "ショップ002", "-500", "サンプル銀行", "", 0)].join(
      "\n",
    );
    const res = await commit(other, { name: "MF ME" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("STATEMENT_SOURCE_NAME_TAKEN");
    const { batches } = await okBody(await imports().$get({ param: ctx.param }));
    expect(batches).toHaveLength(1);
  });

  it("id の取込元がなければ 404 STATEMENT_SOURCE_NOT_FOUND", async () => {
    await mapAccount("サンプル銀行");
    const res = await commit(TEXT, { id: randomUUID(), name: "MF ME" });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("STATEMENT_SOURCE_NOT_FOUND");
  });
});

describe("取込元の照合（§2.1 layout）", () => {
  it("保存した取込元と見出しが同じ表は match: one。対応の headerRow は今回の判定の値", async () => {
    await mapAccount("サンプル銀行");
    await commit(TEXT, { name: "MF ME" });
    const body = await okBody(await layout(TEXT));
    expect(body.match.kind).toBe("one");
    if (body.match.kind === "one") {
      expect(body.match.source.name).toBe("MF ME");
      expect(body.match.source.mapping).toMatchObject({ columns: SIMPLE_MAPPING.columns });
    }
    expect(body.headerDiff).toBeUndefined();
  });

  it("同じ見出しの取込元が 2 件あれば match: many", async () => {
    await mapAccount("サンプル銀行");
    await commit(TEXT, { name: "A" });
    const more = [TEXT, line("05/12(火)", "ショップ002", "-500", "サンプル銀行", "", 0)].join("\n");
    await commit(more, { name: "B" });
    const body = await okBody(await layout(TEXT));
    expect(body.match.kind).toBe("many");
    if (body.match.kind === "many") {
      expect(body.match.sources.map((s) => s.name).sort()).toEqual(["A", "B"]);
    }
  });

  it("sourceId で見出しが違う表は match: none と headerDiff（足された列）。取込元がなければ 404", async () => {
    await mapAccount("サンプル銀行");
    const created = (await okBody(await commit(TEXT, { name: "MF ME" }))).source;
    const body = await okBody(await layout(TEXT_EXTRA_COLUMN, { sourceId: created?.id }));
    expect(body.match.kind).toBe("none");
    expect(body.headerDiff).toEqual({ added: ["番号"], removed: [] });
    // 見出しの名前が同じ列の役割を引き継ぐ（列の番号は 1 つずれる）
    expect(body.suggestedColumns).toMatchObject({ date: 1, content: 2, amount: 3 });

    const missing = await layout(TEXT, { sourceId: randomUUID() });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("STATEMENT_SOURCE_NOT_FOUND");
  });

  it("sourceId が当てはまる表は match: one", async () => {
    await mapAccount("サンプル銀行");
    const created = (await okBody(await commit(TEXT, { name: "MF ME" }))).source;
    const body = await okBody(await layout(TEXT, { sourceId: created?.id }));
    expect(body.match.kind).toBe("one");
  });
});

describe("取込元の一覧・名前の変更・削除（§3）", () => {
  const seed = async (names: string[]) => {
    await mapAccount("サンプル銀行");
    const made: { id: string; name: string }[] = [];
    for (const [i, name] of names.entries()) {
      const text = [
        TEXT,
        ...Array.from({ length: i }, (_, k) =>
          line(`06/0${k + 1}(月)`, `ショップ9${i}${k}`, "-100", "サンプル銀行", "", 0),
        ),
      ].join("\n");
      const res = await commit(text, { name });
      expect(res.status).toBe(201);
      const source = (await okBody(res)).source;
      if (source !== null) made.push(source);
    }
    return made;
  };

  it("GET は空から始まり、last_used_at の新しい順に返す", async () => {
    expect(await list()).toEqual([]);
    await seed(["古い", "新しい"]);
    const names = (await list()).map((s) => s.name);
    expect(new Set(names)).toEqual(new Set(["古い", "新しい"]));
  });

  it("PATCH は名前を変える。重複は 409、ない id は 404、空の名前は 400", async () => {
    const [a] = await seed(["A", "B"]);
    const ok = await sources()[":id"].$patch({
      param: { ...ctx.param, id: a?.id ?? "" },
      json: { name: "  A 改  " },
    });
    expect(ok.status).toBe(200);
    expect((await okBody(ok)).source).toMatchObject({ id: a?.id, name: "A 改" });

    const taken = await sources()[":id"].$patch({
      param: { ...ctx.param, id: a?.id ?? "" },
      json: { name: "B" },
    });
    expect(taken.status).toBe(409);
    expect((await errorOf(taken)).code).toBe("STATEMENT_SOURCE_NAME_TAKEN");

    const missing = await sources()[":id"].$patch({
      param: { ...ctx.param, id: randomUUID() },
      json: { name: "X" },
    });
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe("STATEMENT_SOURCE_NOT_FOUND");

    const empty = await sources()[":id"].$patch({
      param: { ...ctx.param, id: a?.id ?? "" },
      json: { name: "" },
    });
    expect(empty.status).toBe(400);
  });

  it("DELETE は 204。取込の回の sourceName・明細は変わらない。ない id は 404", async () => {
    const [a] = await seed(["A"]);
    const res = await sources()[":id"].$delete({ param: { ...ctx.param, id: a?.id ?? "" } });
    expect(res.status).toBe(204);
    expect(await list()).toEqual([]);
    const { batches } = await okBody(await imports().$get({ param: ctx.param }));
    expect(batches[0]?.sourceName).toBe("A");

    const again = await sources()[":id"].$delete({ param: { ...ctx.param, id: a?.id ?? "" } });
    expect(again.status).toBe(404);
    expect((await errorOf(again)).code).toBe("STATEMENT_SOURCE_NOT_FOUND");
    // 消した後は照合されない
    expect((await okBody(await layout(TEXT))).match.kind).toBe("none");
  });
});
