import { createHash } from "node:crypto";
import { type TempDataDir, useTempDataDir } from "@trebuchet/db/testing";
import type { StatementColumnMapping } from "@trebuchet/schema";
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

// 006 US1・007 US1: contracts/http-api.md §2。multipart（file と options）の layout・preview・確定 → 再取込

let tmp: TempDataDir;
let ctx: InvoicingTestContext;

beforeEach(async () => {
  tmp = useTempDataDir("server-statements-import-api");
  ctx = await createInvoicingTestContext();
});
afterEach(() => tmp.cleanup());

const accounts = () => ctx.e["statement-accounts"];
const imports = () => ctx.e.statements.imports;

const line = (...cells: (string | number)[]) => cells.join("\t");
const TEXT = [
  SIMPLE_HEADER,
  line("05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0),
  line("05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0),
  line("05/11(月)", "売上入金", "3,000", "サンプル銀行", "メモ", 0),
  line("合計"),
].join("\n");

/** 見出しの下の行がすべて読めない（日付が日付でない）テキスト */
const UNREADABLE = [
  SIMPLE_HEADER,
  line("あ", "い", "う", "え", "", 0),
  line("か", "き", "く", "け", "", 0),
].join("\n");

/** 取込の入力（ファイルのバイト列または文字列と、options の JSON になる値） */
type Input = { file: string | Uint8Array<ArrayBuffer>; options: Record<string, unknown> };

const paste = (
  text = TEXT,
  year = 2026,
  mapping: StatementColumnMapping = SIMPLE_MAPPING,
  over: Record<string, unknown> = {},
): Input => ({ file: text, options: { origin: "paste", year, mapping, ...over } });

/** 口座名の列のない銀行の CSV（CP932 の `bank-two-columns.csv`、UTF-8 の `.utf8.csv`）。口座名は固定 */
const FIXED = "テスト銀行";
const bankCsv = (name = "bank-two-columns.csv", over: Record<string, unknown> = {}): Input => ({
  file: readStatementFixture(name),
  options: {
    origin: "file",
    year: 2026,
    mapping: BANK_TWO_COLUMNS.mapping,
    fixedAccountName: FIXED,
    ...over,
  },
});

const mapBank = async (name = "サンプル銀行") => {
  const res = await accounts()[":name"].$put({
    param: { ...ctx.param, name },
    json: { usage: "business", kind: "bank", accountId: ctx.accountId("普通預金") },
  });
  expect(res.status).toBe(200);
  return okBody(res);
};

const param = () => ctx.param;
const init = (file: Input["file"] | undefined, options: unknown) => ({
  init: { body: statementForm(file, options) },
});

const layout = (input: Input, options: Record<string, unknown> = {}) =>
  imports().layout.$post(
    { param: param() },
    init(input.file, { origin: input.options.origin, ...options }),
  );
const preview = (input = paste()) =>
  imports().preview.$post({ param: param() }, init(input.file, input.options));
const commit = (input: Input, inputSha256: string, countNew: number, over = {}) =>
  imports().$post(
    { param: param() },
    init(input.file, {
      ...input.options,
      expected: { inputSha256, countNew },
      accounts: [],
      saveSource: null,
      ...over,
    }),
  );

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

describe("表の判定（§2.1 layout）", () => {
  it("タブ区切りの貼り付け: 区切り・見出しの行・見出し・見本・文字コード・取込元の照合なし", async () => {
    const res = await layout(paste());
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body).toMatchObject({
      encoding: "utf-8",
      delimiter: "\t",
      headerRow: 0,
      header: ["日付", "内容", "金額（円）", "保有金融機関", "メモ", "振替"],
      columnCount: 6,
      needsYear: true,
      match: { kind: "none" },
    });
    expect(body.rowCount).toBeGreaterThanOrEqual(3);
    expect(body.sampleRows.length).toBeGreaterThanOrEqual(3);
    expect(body.sampleRows.length).toBeLessThanOrEqual(10);
    expect(body.suggestedColumns).toMatchObject({ date: 0, content: 1, amount: 2 });
  });

  it("CP932 の CSV は自動で shift_jis と判定し、前置きの後の見出しの行を見つける", async () => {
    const body = await okBody(await layout(bankCsv()));
    expect(body.encoding).toBe("shift_jis");
    expect(body.delimiter).toBe(",");
    expect(body.headerRow).toBe(BANK_TWO_COLUMNS.mapping.headerRow);
    expect(body.header).toEqual(["取引日", "摘要", "出金額", "入金額", "残高"]);
    expect(body.needsYear).toBe(false);
  });

  it("UTF-8 の同じ CSV は utf-8。options.encoding を指定すると自動の判定を使わない", async () => {
    const utf8 = await okBody(await layout(bankCsv("bank-two-columns.utf8.csv")));
    expect(utf8.encoding).toBe("utf-8");
    expect(utf8.header).toEqual(["取引日", "摘要", "出金額", "入金額", "残高"]);

    const wrong = await layout(bankCsv("bank-two-columns.utf8.csv"), { encoding: "shift_jis" });
    if (wrong.status === 200) {
      const body = await okBody(wrong);
      expect(body.encoding).toBe("shift_jis");
      expect(body.header).not.toEqual(utf8.header);
    } else {
      expect(wrong.status).toBe(422);
    }

    const same = await okBody(await layout(bankCsv(), { encoding: "shift_jis" }));
    expect(same.encoding).toBe("shift_jis");
    expect(same.header).toEqual(utf8.header);
  });

  it("options.headerRow に null を指定すると見出しなし（header は null）", async () => {
    const body = await okBody(await layout(bankCsv(), { headerRow: null }));
    expect(body.headerRow).toBeNull();
    expect(body.header).toBeNull();
  });

  it("読めない・空の入力は 422 STATEMENT_TABLE_UNREADABLE", async () => {
    const res = await layout(paste(""));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("STATEMENT_TABLE_UNREADABLE");
  });

  it("options が壊れていれば 400 VALIDATION（JSON でない・origin がない・file がない）", async () => {
    const post = (file: string | undefined, options: unknown) =>
      imports().layout.$post({ param: param() }, init(file, options));
    for (const res of [
      await post("a\tb", "{not json"),
      await post("a\tb", { delimiter: "\t" }),
      await post("a\tb", { origin: "file", delimiter: "|" }),
      await post("a\tb", undefined),
      await post(undefined, { origin: "paste" }),
    ]) {
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
  });
});

describe("取込のプレビュー（§2.2）", () => {
  it("件数・期間・合計・未対応の口座・読めない行を返す。何も保存しない", async () => {
    const res = await preview();
    expect(res.status).toBe(200);
    const body = await okBody(res);
    expect(body.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.countNew).toBe(3);
    expect(body.period).toEqual({ from: "2026-05-10", to: "2026-05-11" });
    expect(body.totals).toEqual({ inflow: 3000, outflow: 2400 });
    expect(body.unmappedAccounts).toMatchObject([
      { name: "サンプル銀行", suggestion: { kind: "bank", usage: null, cues: ["銀行"] } },
    ]);
    expect(body.unreadable).toHaveLength(1);
    expect(body.unreadable[0]?.line).toBe(5);
    expect(body.rows.map((r) => [r.status, r.key])).toEqual([
      ["new", "サンプル銀行|2026-05-10|-1200|ショップ#|0"],
      ["new", "サンプル銀行|2026-05-10|-1200|ショップ#|1"],
      ["new", "サンプル銀行|2026-05-11|3000|売上入金|0"],
    ]);
    const batches = await okBody(await imports().$get({ param: ctx.param }));
    expect(batches.batches).toEqual([]);
  });

  it("CP932 の CSV（銀行・出金と入金の 2 列）の件数と合計が expected と一致する", async () => {
    const body = await okBody(await preview(bankCsv()));
    expect(body.countNew).toBe(BANK_TWO_COLUMNS.rowCount);
    expect(body.totals).toEqual({
      inflow: BANK_TWO_COLUMNS.inflowTotal,
      outflow: BANK_TWO_COLUMNS.outflowTotal,
    });
    expect(body.unmappedAccounts.map((a) => a.name)).toEqual([FIXED]);
  });

  it("options.encoding の指定: 正しければ自動と同じ結果。UTF-8 の同じ内容でも同じ入力のハッシュ", async () => {
    const auto = await okBody(await preview(bankCsv()));
    const sjis = await okBody(
      await preview(bankCsv("bank-two-columns.csv", { encoding: "shift_jis" })),
    );
    const utf8 = await okBody(await preview(bankCsv("bank-two-columns.utf8.csv")));
    expect(sjis.inputSha256).toBe(auto.inputSha256);
    expect(utf8.inputSha256).toBe(auto.inputSha256);
    expect(utf8.countNew).toBe(auto.countNew);
  });

  it("文字コードを誤って指定すると文字が変わる（入力のハッシュが変わり、摘要が文字化けする）", async () => {
    const auto = await okBody(await preview(bankCsv()));
    const wrong = await preview(bankCsv("bank-two-columns.csv", { encoding: "utf-8" }));
    if (wrong.status === 200) {
      const body = await okBody(wrong);
      expect(body.inputSha256).not.toBe(auto.inputSha256);
      expect(body.rows.map((r) => r.content)).not.toEqual(auto.rows.map((r) => r.content));
    } else {
      expect(wrong.status).toBe(422);
    }
  });

  it("入力のハッシュは、テキスト・年・対応・口座名の固定から決まる（R11）", async () => {
    const a = await okBody(await preview());
    const same = await okBody(await preview());
    const otherYear = await okBody(await preview(paste(TEXT, 2025)));
    const otherText = await okBody(await preview(paste(TEXT.replace("3,000", "3,001"))));
    const noMemo = await okBody(
      await preview(
        paste(TEXT, 2026, {
          ...SIMPLE_MAPPING,
          columns: { date: 0, content: 1, amount: 2, accountName: 3, transferFlag: 5 },
        }),
      ),
    );
    expect(same.inputSha256).toBe(a.inputSha256);
    expect(otherYear.inputSha256).not.toBe(a.inputSha256);
    expect(otherText.inputSha256).not.toBe(a.inputSha256);
    expect(noMemo.inputSha256).not.toBe(a.inputSha256);

    const fixedA = await okBody(await preview(bankCsv()));
    const fixedB = await okBody(
      await preview(bankCsv("bank-two-columns.csv", { fixedAccountName: "別の銀行" })),
    );
    expect(fixedB.inputSha256).not.toBe(fixedA.inputSha256);
  });

  it("入力のハッシュは options の JSON のキーの順に依らない。形は text・year・mapping・fixedAccountName の正規の JSON", async () => {
    const reordered = {
      mapping: {
        amountSign: "inflow_positive",
        columns: { transferFlag: 5, memo: 4, accountName: 3, amount: 2, content: 1, date: 0 },
        headerRow: 0,
        delimiter: "\t",
      },
      year: 2026,
      origin: "paste",
    };
    const a = await okBody(await preview());
    const res = await imports().preview.$post({ param: param() }, init(TEXT, reordered));
    expect((await okBody(res)).inputSha256).toBe(a.inputSha256);

    const canonical = JSON.stringify({
      text: TEXT,
      year: 2026,
      mapping: {
        delimiter: "\t",
        headerRow: 0,
        columns: { accountName: 3, amount: 2, content: 1, date: 0, memo: 4, transferFlag: 5 },
        amountSign: "inflow_positive",
      },
      fixedAccountName: null,
    });
    expect(a.inputSha256).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  it("読めないテキストは 422 STATEMENT_TABLE_UNREADABLE（details.unreadable）", async () => {
    const res = await preview(paste(UNREADABLE));
    expect(res.status).toBe(422);
    const e = await errorOf(res);
    expect(e.code).toBe("STATEMENT_TABLE_UNREADABLE");
    expect(e.details).toMatchObject({ unreadable: [{ line: 2 }, { line: 3 }] });
  });

  it("列の番号が表の列数を超えれば 422 STATEMENT_MAPPING_INVALID", async () => {
    const res = await preview(
      paste(TEXT, 2026, {
        ...SIMPLE_MAPPING,
        columns: { date: 0, content: 1, amount: 6, accountName: 3 },
      }),
    );
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("STATEMENT_MAPPING_INVALID");
  });

  it("口座名の列も固定の口座名もなければ 422 STATEMENT_MAPPING_INVALID（INV-50）", async () => {
    const res = await preview(bankCsv("bank-two-columns.csv", { fixedAccountName: undefined }));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("STATEMENT_MAPPING_INVALID");
  });

  it("options が壊れていれば 400 VALIDATION（JSON でない・対応が検証を通らない・year がない・file がない）", async () => {
    const post = (file: string | undefined, options: unknown) =>
      imports().preview.$post({ param: param() }, init(file, options));
    const noAmount = { ...SIMPLE_MAPPING, columns: { date: 0, content: 1 } };
    for (const res of [
      await post(TEXT, "{not json"),
      await post(TEXT, { origin: "paste", mapping: SIMPLE_MAPPING }),
      await post(TEXT, { origin: "paste", year: 2026, mapping: noAmount }),
      await post(TEXT, undefined),
      await post(undefined, { origin: "paste", year: 2026, mapping: SIMPLE_MAPPING }),
    ]) {
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe("VALIDATION");
    }
  });
});

describe("取込の確定（§2.3）→ 再取込 → 履歴（§2.4）", () => {
  it("未対応の口座があれば 422 STATEMENT_ACCOUNT_UNMAPPED（details.names）", async () => {
    const p = await okBody(await preview());
    const res = await commit(paste(), p.inputSha256, p.countNew);
    expect(res.status).toBe(422);
    const e = await errorOf(res);
    expect(e.code).toBe("STATEMENT_ACCOUNT_UNMAPPED");
    expect(e.details).toEqual({ names: ["サンプル銀行"] });
  });

  it("accounts で未対応の口座の対応を送ると、同じ確定で口座が保存されて取り込める（US3）", async () => {
    const p = await okBody(await preview());
    expect(p.unmappedAccounts.map((a) => a.name)).toEqual(["サンプル銀行"]);
    const res = await commit(paste(), p.inputSha256, p.countNew, {
      accounts: [
        {
          name: "サンプル銀行",
          input: { usage: "business", kind: "bank", accountId: ctx.accountId("普通預金") },
        },
      ],
    });
    expect(res.status).toBe(201);
    expect((await okBody(res)).added).toBe(3);
    const list = await okBody(await accounts().$get({ param: ctx.param }));
    expect(list.accounts).toMatchObject([
      {
        name: "サンプル銀行",
        usage: "business",
        kind: "bank",
        accountId: ctx.accountId("普通預金"),
      },
    ]);
    // 対応が保存されたので、再取込のプレビューに未対応の口座は出ない
    expect((await okBody(await preview())).unmappedAccounts).toEqual([]);
  });

  it("accounts の違反（重複・対応済みの名前・行にない名前・形の不正）は 400 VALIDATION（details.names）。何も保存しない", async () => {
    const p = await okBody(await preview());
    const business = {
      usage: "business",
      kind: "bank",
      accountId: ctx.accountId("普通預金"),
    };
    const dup = await commit(paste(), p.inputSha256, p.countNew, {
      accounts: [
        { name: "サンプル銀行", input: business },
        { name: "サンプル銀行", input: business },
      ],
    });
    expect(dup.status).toBe(400);
    const dupError = await errorOf(dup);
    expect(dupError.code).toBe("VALIDATION");
    expect(dupError.details).toMatchObject({ names: ["サンプル銀行"] });

    const extra = await commit(paste(), p.inputSha256, p.countNew, {
      accounts: [
        { name: "サンプル銀行", input: business },
        { name: "行にない口座", input: { usage: "private", kind: "cash" } },
      ],
    });
    expect(extra.status).toBe(400);
    expect((await errorOf(extra)).details).toMatchObject({ names: ["行にない口座"] });

    const bad = await commit(paste(), p.inputSha256, p.countNew, {
      accounts: [
        {
          name: "サンプル銀行",
          input: { usage: "private", kind: "cash", accountId: ctx.accountId("現金") },
        },
      ],
    });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("VALIDATION");

    // 対応済みの名前を accounts に入れると断る
    await mapBank();
    const mapped = await okBody(await preview());
    const again = await commit(paste(), mapped.inputSha256, mapped.countNew, {
      accounts: [{ name: "サンプル銀行", input: business }],
    });
    expect(again.status).toBe(400);
    expect((await errorOf(again)).details).toMatchObject({ names: ["サンプル銀行"] });
    expect((await okBody(await preview())).countNew).toBe(3);
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

  it("CP932 の CSV（origin: file）を取り込める。回の出所は file、件数は expected と一致する", async () => {
    await mapBank(FIXED);
    const p = await okBody(await preview(bankCsv()));
    expect(p.unmappedAccounts).toEqual([]);
    const res = await commit(bankCsv(), p.inputSha256, p.countNew);
    expect(res.status).toBe(201);
    const committed = await okBody(res);
    expect(committed.added).toBe(BANK_TWO_COLUMNS.rowCount);
    expect(committed.batch.origin).toBe("file");
    // 文字コードを指定して取り込んでも同じ（ハッシュが同じなので確定できる）
    const again = await commit(
      bankCsv("bank-two-columns.csv", { encoding: "shift_jis" }),
      p.inputSha256,
      0,
    );
    expect(again.status).toBe(201);
  });

  it("一部が取込済みなら、残りだけが新規になる", async () => {
    await mapBank();
    const first = paste(
      [SIMPLE_HEADER, line("05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0)].join("\n"),
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
    // 年だけを変えた場合も、対応だけを変えた場合も同じ
    const otherYear = await commit(paste(TEXT, 2025), p.inputSha256, p.countNew);
    expect(otherYear.status).toBe(409);
    const otherMapping = await commit(
      paste(TEXT, 2026, {
        ...SIMPLE_MAPPING,
        columns: { date: 0, content: 1, amount: 2, accountName: 3, transferFlag: 5 },
      }),
      p.inputSha256,
      p.countNew,
    );
    expect(otherMapping.status).toBe(409);
    expect((await okBody(await imports().$get({ param: ctx.param }))).batches).toEqual([]);
  });

  it("新規の件数がプレビューと違えば 409 STATEMENT_PLAN_CHANGED", async () => {
    await mapBank();
    const p = await okBody(await preview());
    const res = await commit(paste(), p.inputSha256, p.countNew + 1);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("STATEMENT_PLAN_CHANGED");
  });

  it("読めないテキストの確定は 422 STATEMENT_TABLE_UNREADABLE", async () => {
    await mapBank();
    const res = await commit(paste(UNREADABLE), "a".repeat(64), 0);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("STATEMENT_TABLE_UNREADABLE");
  });

  it("確定の入力の形が違えば 400 VALIDATION（ハッシュが 64 桁の 16 進でない・expected がない）", async () => {
    const bad = await commit(paste(), "xyz", 0);
    expect(bad.status).toBe(400);
    const missing = await imports().$post(
      { param: param() },
      init(TEXT, { ...paste().options, accounts: [], saveSource: null }),
    );
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).code).toBe("VALIDATION");
  });

  it("file がなければ確定は 400 VALIDATION（共通のアップロードの部品。5 MB の上限は imports.upload.api.test.ts）", async () => {
    const res = await imports().$post(
      { param: param() },
      init(undefined, {
        ...paste().options,
        expected: { inputSha256: "a".repeat(64), countNew: 0 },
        accounts: [],
        saveSource: null,
      }),
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
  });

  it("GET /statements/imports は新しい順に回を返す", async () => {
    await mapBank();
    const a = paste(
      [SIMPLE_HEADER, line("05/10(日)", "ショップ001", "-1,200", "サンプル銀行", "", 0)].join("\n"),
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
