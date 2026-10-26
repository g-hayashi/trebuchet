import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorOf } from "./helpers.ts";
import {
  createInvoicingTestContext,
  type InvoicingTestContext,
  okBody,
} from "./invoicing-helpers.ts";

// 006 US1: contracts/http-api.md §2・§3.1〜§3.3。貼り付けのプレビュー → 確定 → 再取込

let tmp: TempDataDir;
let ctx: InvoicingTestContext;

beforeEach(async () => {
  tmp = useTempDataDir("server-statements-import-api");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());

const accounts = () => ctx.e["statement-accounts"];
const imports = () => ctx.e.statements.imports;

const HEADER = ["日付", "内容", "金額（円）", "保有金融機関", "メモ", "振替"].join("\t");
const line = (...cells: (string | number)[]) => cells.join("\t");
const TEXT = [
  HEADER,
  line("05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0),
  line("05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0),
  line("05/11(月)", "売上入金", "3,000", "サンプル銀行", "メモ", 0),
  line("合計"),
].join("\n");

const paste = (text = TEXT, year = 2026) => ({ kind: "paste" as const, text, year });

const mapBank = async (name = "サンプル銀行") => {
  const res = await accounts()[":name"].$put({
    param: { ...ctx.param, name },
    json: { usage: "business", kind: "bank", accountId: ctx.accountId("普通預金") },
  });
  expect(res.status).toBe(200);
  return okBody(res);
};

const preview = (source = paste()) =>
  imports().preview.$post({ param: ctx.param, json: { source } });

const commit = (source: ReturnType<typeof paste>, inputSha256: string, countNew: number) =>
  imports().$post({
    param: ctx.param,
    json: { source, expected: { inputSha256, countNew } },
  });

describe("取込元の口座（§2）", () => {
  it("GET は空から始まり、PUT で用途・種類・科目を保存すると一覧に出る（rebuilt は 0）", async () => {
    expect((await okBody(await accounts().$get({ param: ctx.param }))).accounts).toEqual([]);
    const saved = await mapBank();
    expect(saved.rebuilt).toBe(0);
    expect(saved.account).toMatchObject({
      name: "サンプル銀行",
      usage: "business",
      kind: "bank",
      accountId: ctx.accountId("普通預金"),
      subAccountId: null,
    });
    const list = await okBody(await accounts().$get({ param: ctx.param }));
    expect(list.accounts.map((a) => a.name)).toEqual(["サンプル銀行"]);
  });

  it("private は科目を持たずに保存できる。科目を付けると 400 VALIDATION", async () => {
    const ok = await accounts()[":name"].$put({
      param: { ...ctx.param, name: "テスト現金" },
      json: { usage: "private", kind: "cash" },
    });
    expect(ok.status).toBe(200);
    expect((await okBody(ok)).account.accountId).toBeNull();
    const bad = await accounts()[":name"].$put({
      param: { ...ctx.param, name: "テスト現金" },
      json: { usage: "private", kind: "cash", accountId: ctx.accountId("現金") },
    });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("VALIDATION");
  });

  it("存在しない科目は 422 ACCOUNT_NOT_FOUND", async () => {
    const res = await accounts()[":name"].$put({
      param: { ...ctx.param, name: "サンプル銀行" },
      json: {
        usage: "business",
        kind: "bank",
        accountId: "00000000-0000-7000-8000-000000000000",
      },
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("取込のプレビュー（§3.1）", () => {
  it("件数・期間・合計・未対応の口座・読めない行を返す。何も保存しない", async () => {
    const res = await preview();
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.countNew).toBe(3);
    expect(body.period).toEqual({ from: "2026-05-10", to: "2026-05-11" });
    expect(body.totals).toEqual({ inflow: 3000, outflow: 2400 });
    expect(body.unmappedAccounts).toEqual(["サンプル銀行"]);
    expect(body.unreadable).toEqual([{ line: 5, reason: "列が足りません" }]);
    expect(body.rows.map((r) => [r.status, r.key])).toEqual([
      ["new", "サンプル銀行|2026-05-10|-1200|ショップ#|0"],
      ["new", "サンプル銀行|2026-05-10|-1200|ショップ#|1"],
      ["new", "サンプル銀行|2026-05-11|3000|売上入金|0"],
    ]);
    const batches = await okBody(await imports().$get({ param: ctx.param }));
    expect(batches.batches).toEqual([]);
  });

  it("入力のハッシュは、貼り付けのテキストと年から決まる", async () => {
    const a = await okBody(await preview());
    const same = await okBody(await preview());
    const otherYear = await okBody(await preview(paste(TEXT, 2025)));
    const otherText = await okBody(await preview(paste(`${TEXT}\n`.replace("3,000", "3,001"))));
    expect(same.inputSha256).toBe(a.inputSha256);
    expect(otherYear.inputSha256).not.toBe(a.inputSha256);
    expect(otherText.inputSha256).not.toBe(a.inputSha256);
  });

  it("読めない貼り付けは 422 STATEMENT_PASTE_UNREADABLE（details.unreadable）", async () => {
    const res = await preview(paste("あいうえお\nかきくけこ"));
    expect(res.status).toBe(422);
    const e = await errorOf(res);
    expect(e.code).toBe("STATEMENT_PASTE_UNREADABLE");
    expect(e.details).toMatchObject({ unreadable: [{ line: 1 }, { line: 2 }] });
  });

  it("必須の列が欠ければ 422（details.missingColumns）", async () => {
    const res = await preview(paste(["日付\t内容\t保有金融機関", "05/10(日)\tA\tB"].join("\n")));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).details).toMatchObject({ missingColumns: ["金額（円）"] });
  });

  it("入力の形が違えば 400 VALIDATION（貼り付けが空・取り込み元の種類が違う）", async () => {
    const empty = await imports().preview.$post({
      param: ctx.param,
      json: { source: { kind: "paste", text: "", year: 2026 } },
    });
    expect(empty.status).toBe(400);
    const unknownKind = await imports().preview.$post({
      param: ctx.param,
      json: {
        source: { kind: "mfme_fetch", jobId: "00000000-0000-7000-8000-000000000001" },
      } as never,
    });
    expect(unknownKind.status).toBe(400);
  });
});

describe("取込の確定（§3.2）→ 再取込 → 履歴（§3.3）", () => {
  it("未対応の口座があれば 422 STATEMENT_ACCOUNT_UNMAPPED（details.names）", async () => {
    const p = await okBody(await preview());
    const res = await commit(paste(), p.inputSha256, p.countNew);
    expect(res.status).toBe(422);
    const e = await errorOf(res);
    expect(e.code).toBe("STATEMENT_ACCOUNT_UNMAPPED");
    expect(e.details).toEqual({ names: ["サンプル銀行"] });
  });

  it("プレビュー → 確定 201 → 再取込のプレビューは新規 0 件 → 確定しても 0 件", async () => {
    await mapBank();
    const p = await okBody(await preview());
    expect(p.unmappedAccounts).toEqual([]);
    const res = await commit(paste(), p.inputSha256, p.countNew);
    expect(res.status).toBe(201);
    const committed = await okBody(res);
    expect(committed.added).toBe(3);
    expect(committed.changed).toBe(0);
    expect(committed.batch).toMatchObject({
      origin: "paste",
      inputSha256: p.inputSha256,
      periodFrom: "2026-05-10",
      periodTo: "2026-05-11",
      countNew: 3,
      countUnreadable: 1,
    });

    const again = await okBody(await preview());
    expect(again.countNew).toBe(0);
    expect(again.rows.every((r) => r.status === "existing")).toBe(true);
    const second = await commit(paste(), again.inputSha256, again.countNew);
    expect(second.status).toBe(201);
    expect((await okBody(second)).added).toBe(0);
  });

  it("一部が取込済みなら、残りだけが新規になる", async () => {
    await mapBank();
    const first = paste(
      [HEADER, line("05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0)].join("\n"),
    );
    const p1 = await okBody(await preview(first));
    expect((await commit(first, p1.inputSha256, p1.countNew)).status).toBe(201);
    const p2 = await okBody(await preview());
    expect(p2.countNew).toBe(2);
    expect(p2.rows.map((r) => r.status)).toEqual(["existing", "new", "new"]);
  });

  it("プレビューの後に入力を変えると 409 STATEMENT_PLAN_CHANGED。何も保存しない", async () => {
    await mapBank();
    const p = await okBody(await preview());
    const changed = paste(TEXT.replace("3,000", "3,500"));
    const res = await commit(changed, p.inputSha256, p.countNew);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("STATEMENT_PLAN_CHANGED");
    // 年だけを変えた場合も同じ
    const otherYear = await commit(paste(TEXT, 2025), p.inputSha256, p.countNew);
    expect(otherYear.status).toBe(409);
    expect((await okBody(await imports().$get({ param: ctx.param }))).batches).toEqual([]);
  });

  it("新規の件数がプレビューと違えば 409 STATEMENT_PLAN_CHANGED", async () => {
    await mapBank();
    const p = await okBody(await preview());
    const res = await commit(paste(), p.inputSha256, p.countNew + 1);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("STATEMENT_PLAN_CHANGED");
  });

  it("読めない貼り付けの確定は 422 STATEMENT_PASTE_UNREADABLE", async () => {
    await mapBank();
    const res = await commit(paste("あいうえお"), "a".repeat(64), 0);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("STATEMENT_PASTE_UNREADABLE");
  });

  it("確定の入力の形が違えば（ハッシュが 64 桁の 16 進でない）400 VALIDATION", async () => {
    const res = await commit(paste(), "xyz", 0);
    expect(res.status).toBe(400);
  });

  it("GET /statements/imports は新しい順に回を返す", async () => {
    await mapBank();
    const a = paste(
      [HEADER, line("05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0)].join("\n"),
    );
    const pa = await okBody(await preview(a));
    const first = await okBody(await commit(a, pa.inputSha256, pa.countNew));
    const pb = await okBody(await preview());
    const second = await okBody(await commit(paste(), pb.inputSha256, pb.countNew));
    const { batches } = await okBody(await imports().$get({ param: ctx.param }));
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.id).sort()).toEqual([first.batch.id, second.batch.id].sort());
  });
});
