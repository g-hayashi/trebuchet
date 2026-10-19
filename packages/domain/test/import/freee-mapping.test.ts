import { describe, expect, it } from "vitest";
import { proposeMappings, resolveLineAccount } from "../../src/import/freee/mapping.ts";
import { FREEE_TAX_PROPOSALS } from "../../src/seed/freee-aliases.ts";
import { TAX_CATEGORIES } from "../../src/seed/tax-categories.ts";
import { EXPECTED_ACCOUNT_MAPPING, EXPECTED_JOURNAL } from "../fixtures/freee/expected.ts";
import { ACCOUNTS, accountId, sub, withInactive } from "./import-setup.ts";

const none = { accounts: [], taxes: [] };
const accountsOnly = (names: string[]) => ({ accounts: names, taxes: [] });

function rowOf(rows: readonly { sourceName: string }[], name: string) {
  const row = rows.find((r) => r.sourceName === name);
  if (row === undefined) throw new Error(`行がない: ${name}`);
  return row;
}

describe("proposeMappings（research R13）", () => {
  it("フィクスチャの科目は、損益を除いてすべて expected.ts の対応先になる", () => {
    const result = proposeMappings(
      accountsOnly([...EXPECTED_JOURNAL.accountNames]),
      none,
      ACCOUNTS,
      [],
      TAX_CATEGORIES,
    );
    expect(result.accounts.map((r) => r.sourceName)).toEqual(EXPECTED_JOURNAL.accountNames);
    for (const [name, expected] of Object.entries(EXPECTED_ACCOUNT_MAPPING)) {
      const row = rowOf(result.accounts, name);
      expect(row, name).toMatchObject({ status: "proposed", accountId: accountId(expected.code) });
      if (expected.subAccountName !== undefined) {
        expect(row, name).toMatchObject({ subAccountName: expected.subAccountName });
      }
    }
    expect(rowOf(result.accounts, "損益")).toEqual({ sourceName: "損益", status: "unmapped" });
  });

  it("保存済み > 同名 > 言い換え > カード > 未定", () => {
    const saved = {
      accounts: [{ sourceName: "現金", accountId: accountId("1020") }],
      taxes: [],
    };
    const result = proposeMappings(
      accountsOnly([
        "現金",
        "売上高",
        "交際費",
        "その他口座",
        "事務用品費",
        "XYZカード",
        "謎の科目",
      ]),
      saved,
      ACCOUNTS,
      [],
      TAX_CATEGORIES,
    );
    expect(result.accounts).toEqual([
      { sourceName: "現金", status: "saved", accountId: accountId("1020") },
      { sourceName: "売上高", status: "proposed", accountId: accountId("4010") },
      { sourceName: "交際費", status: "proposed", accountId: accountId("5140") },
      { sourceName: "その他口座", status: "proposed", accountId: accountId("1020") },
      { sourceName: "事務用品費", status: "proposed", accountId: accountId("5170") },
      {
        sourceName: "XYZカード",
        status: "proposed",
        accountId: accountId("2020"),
        subAccountName: "XYZカード",
      },
      { sourceName: "謎の科目", status: "unmapped" },
    ]);
  });

  it("同名の科目は言い換えより優先する（帳簿に「交際費」があればそれを使う）", () => {
    const accounts = [
      ...ACCOUNTS,
      {
        ...ACCOUNTS[0],
        id: "acc-custom",
        code: "5999",
        name: "交際費",
      } as (typeof ACCOUNTS)[number],
    ];
    const result = proposeMappings(accountsOnly(["交際費"]), none, accounts, [], TAX_CATEGORIES);
    expect(result.accounts[0]).toMatchObject({ status: "proposed", accountId: "acc-custom" });
  });

  it("カードの補助科目が既にあれば、その ID を使う", () => {
    const subs = [sub("sub-abc", "2020", "ABCカード")];
    const result = proposeMappings(
      accountsOnly(["ABCカード"]),
      none,
      ACCOUNTS,
      subs,
      TAX_CATEGORIES,
    );
    expect(result.accounts).toEqual([
      {
        sourceName: "ABCカード",
        status: "proposed",
        accountId: accountId("2020"),
        subAccountId: "sub-abc",
      },
    ]);
  });

  it("「損益」は保存済みの対応があっても常に未定", () => {
    const saved = { accounts: [{ sourceName: "損益", accountId: accountId("3020") }], taxes: [] };
    const result = proposeMappings(accountsOnly(["損益"]), saved, ACCOUNTS, [], TAX_CATEGORIES);
    expect(result.accounts).toEqual([{ sourceName: "損益", status: "unmapped" }]);
  });

  it("使用停止の科目は案に出さない（同名・言い換え・カード）", () => {
    const accounts = withInactive(["4010", "5140", "2020"]);
    const result = proposeMappings(
      accountsOnly(["売上高", "交際費", "ABCカード"]),
      none,
      accounts,
      [],
      TAX_CATEGORIES,
    );
    expect(result.accounts.map((r) => r.status)).toEqual(["unmapped", "unmapped", "unmapped"]);
  });

  it("保存済みの対応先の科目がなくなっていれば、保存済みとして扱わない", () => {
    const saved = { accounts: [{ sourceName: "売上高", accountId: "acc-gone" }], taxes: [] };
    const result = proposeMappings(accountsOnly(["売上高"]), saved, ACCOUNTS, [], TAX_CATEGORIES);
    expect(result.accounts[0]).toMatchObject({ status: "proposed", accountId: accountId("4010") });
  });

  it("保存済みの subAccountName は、同名の補助科目ができていればその ID にする", () => {
    const saved = {
      accounts: [
        { sourceName: "ABCカード", accountId: accountId("2020"), subAccountName: "ＡＢＣカード" },
      ],
      taxes: [],
    };
    const subs = [sub("sub-abc", "2020", "ABCカード")];
    const result = proposeMappings(
      accountsOnly(["ABCカード"]),
      saved,
      ACCOUNTS,
      subs,
      TAX_CATEGORIES,
    );
    expect(result.accounts[0]).toEqual({
      sourceName: "ABCカード",
      status: "saved",
      accountId: accountId("2020"),
      subAccountId: "sub-abc",
    });
  });

  it("税区分の初期案は research R13 の5つ。全角・半角の違いは NFKC で吸収、それ以外は未定", () => {
    expect(Object.keys(FREEE_TAX_PROPOSALS)).toHaveLength(5);
    const result = proposeMappings(
      {
        accounts: [],
        taxes: [
          "対象外",
          "課税売上10%",
          "課税売上８％（軽）",
          "課対仕入10%",
          "課対仕入8%（軽）",
          "非課売上",
        ],
      },
      { accounts: [], taxes: [{ sourceName: "課対仕入10%", taxCategory: "PURCHASE_8R" }] },
      ACCOUNTS,
      [],
      TAX_CATEGORIES,
    );
    expect(result.taxes).toEqual([
      { sourceName: "対象外", status: "proposed", taxCategory: "OUT_OF_SCOPE" },
      { sourceName: "課税売上10%", status: "proposed", taxCategory: "SALES_10" },
      { sourceName: "課税売上8%(軽)", status: "proposed", taxCategory: "SALES_8R" },
      { sourceName: "課対仕入10%", status: "saved", taxCategory: "PURCHASE_8R" },
      { sourceName: "課対仕入8%(軽)", status: "proposed", taxCategory: "PURCHASE_8R" },
      { sourceName: "非課売上", status: "unmapped" },
    ]);
  });

  it("名前は NFKC で正規化し、重複を除いて初出の順に並べる", () => {
    const result = proposeMappings(
      accountsOnly(["ＡＢＣカード", "ABCカード", " 現金 "]),
      none,
      ACCOUNTS,
      [],
      TAX_CATEGORIES,
    );
    expect(result.accounts.map((r) => r.sourceName)).toEqual(["ABCカード", "現金"]);
  });
});

describe("resolveLineAccount（freee の補助科目）", () => {
  const subs = [sub("sub-bank-a", "1020", "A銀行"), sub("sub-card", "2020", "ABCカード")];

  it("対応表の行に補助科目がなく、freee の補助科目名が科目名と違えば、対応先の科目の同名の補助科目に対応させる", () => {
    const row = {
      sourceName: "その他口座",
      status: "proposed" as const,
      accountId: accountId("1020"),
    };
    expect(resolveLineAccount(row, "その他口座", "A銀行", subs)).toEqual({
      accountId: accountId("1020"),
      subAccountId: "sub-bank-a",
    });
    expect(resolveLineAccount(row, "その他口座", "B銀行", subs)).toEqual({
      accountId: accountId("1020"),
      subAccountName: "B銀行",
    });
  });

  it("freee の補助科目名が科目名と同じなら、補助科目を付けない", () => {
    const row = {
      sourceName: "その他口座",
      status: "proposed" as const,
      accountId: accountId("1020"),
    };
    expect(resolveLineAccount(row, "その他口座", "その他口座", subs)).toEqual({
      accountId: accountId("1020"),
    });
    expect(resolveLineAccount(row, "その他口座", undefined, subs)).toEqual({
      accountId: accountId("1020"),
    });
  });

  it("対応表の行の補助科目を優先する", () => {
    const row = {
      sourceName: "ABCカード",
      status: "proposed" as const,
      accountId: accountId("2020"),
      subAccountName: "ABCカード",
    };
    expect(resolveLineAccount(row, "ABCカード", "ABCカード", subs)).toEqual({
      accountId: accountId("2020"),
      subAccountId: "sub-card",
    });
    expect(
      resolveLineAccount({ ...row, subAccountName: "新カード" }, "ABCカード", "XX", subs),
    ).toEqual({
      accountId: accountId("2020"),
      subAccountName: "新カード",
    });
  });

  it("未定の行は undefined", () => {
    expect(
      resolveLineAccount({ sourceName: "損益", status: "unmapped" }, "損益", undefined, subs),
    ).toBeUndefined();
  });
});
