import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { BlueReturn } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { client, createTestEntity, errorOf } from "./helpers.ts";

let tmp: TempDataDir;
let entityId: string;

const e = client.api.entities[":entityId"];
const br = () => e["blue-return"][":year"];

beforeEach(async () => {
  tmp = useTempDataDir("server-blue-return-notes");
  entityId = await createTestEntity();
});
afterEach(() => tmp.cleanup());

const putNote = (kind: string, body: string, year = "2026") =>
  br().notes[":kind"].$put({
    param: { entityId, year, kind } as {
      entityId: string;
      year: string;
      kind: "opening_difference";
    },
    json: { body },
  });

const getPage4 = async () => {
  const res = await br().$get({ param: { entityId, year: "2026" } });
  expect(res.status).toBe(200);
  return BlueReturn.parse(((await res.json()) as { blueReturn: unknown }).blueReturn).page4;
};

describe("PUT /blue-return/:year/notes/:kind（FR-027, FR-030）", () => {
  it("200 で { note } を返し、前後の空白を除いて保存する。もう一度保存すると置き換える", async () => {
    const first = await putNote("special_circumstances", "  災害のため操業を停止  ");
    expect(first.status).toBe(200);
    const { note } = (await first.json()) as { note: Record<string, unknown> };
    expect(note).toMatchObject({
      fiscalYear: 2026,
      kind: "special_circumstances",
      body: "災害のため操業を停止",
    });
    expect(typeof note.updatedAt).toBe("string");

    const second = await putNote("special_circumstances", "別の説明");
    expect(((await second.json()) as { note: { body: string } }).note.body).toBe("別の説明");
  });

  it("opening_difference は決算書の4ページ（openingDifferenceNote）に出る。空にすると null に戻る", async () => {
    expect((await getPage4()).openingDifferenceNote).toBeNull();
    expect((await putNote("opening_difference", "期首の修正のため")).status).toBe(200);
    expect((await getPage4()).openingDifferenceNote).toBe("期首の修正のため");
    expect((await putNote("opening_difference", "   ")).status).toBe(200);
    expect((await getPage4()).openingDifferenceNote).toBeNull();
  });

  it("400 VALIDATION: 5000字を超える、kind が違う、存在しない年度", async () => {
    const long = await putNote("opening_difference", "あ".repeat(5001));
    expect(long.status).toBe(400);
    expect((await errorOf(long)).code).toBe("VALIDATION");

    const kind = await putNote("unknown", "メモ");
    expect(kind.status).toBe(400);
    expect((await errorOf(kind)).code).toBe("VALIDATION");

    const year = await putNote("opening_difference", "メモ", "1999");
    expect(year.status).toBe(400);
    expect((await errorOf(year)).code).toBe("VALIDATION");

    expect((await putNote("opening_difference", "あ".repeat(5000))).status).toBe(200);
  });

  it("締め済みの年度でも保存できる", async () => {
    const closed = await e["fiscal-periods"][":year"].close.$post({
      param: { entityId, year: "2026" },
    });
    expect(closed.status).toBe(200);
    expect((await putNote("opening_difference", "締め後の説明")).status).toBe(200);
    expect((await getPage4()).openingDifferenceNote).toBe("締め後の説明");
  });
});
