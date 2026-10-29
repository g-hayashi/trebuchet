import { describe, expect, it } from "vitest";
import {
  ACCOUNT_CUES,
  inferStatementAccount,
  KIND_ACCOUNT_CODES,
} from "../../src/statements/account-inference.ts";

// 007 T014（R9、FR-013〜015、SC-004）。口座の名前と大項目から、種類・科目・補助科目・用途の案を決める

const account = (code: string, over: { isActive?: boolean } = {}) => ({
  id: `acc-${code}`,
  code,
  isActive: over.isActive ?? true,
});
const ACCOUNTS = [account("1010"), account("1020"), account("2020"), account("4010")];
const sub = (id: string, accountCode: string, name: string, isActive = true) => ({
  id,
  accountId: `acc-${accountCode}`,
  name,
  isActive,
});

const infer = (
  name: string,
  majors: readonly string[] = [],
  accounts = ACCOUNTS,
  subs: ReturnType<typeof sub>[] = [],
) => inferStatementAccount(name, majors, accounts, subs);

describe("KIND_ACCOUNT_CODES・ACCOUNT_CUES", () => {
  it("種類と科目のコード（未払金・普通預金・現金）と、手がかりの語の表", () => {
    expect(KIND_ACCOUNT_CODES).toEqual({ card: "2020", bank: "1020", cash: "1010" });
    expect(ACCOUNT_CUES.card).toContain("カード");
    expect(ACCOUNT_CUES.bank).toContain("銀行");
    expect(ACCOUNT_CUES.cash).toContain("現金");
  });
});

describe("inferStatementAccount（名前）", () => {
  it("「カード」を含めば card・未払金。手がかりの語を返す。用途は推定しない", () => {
    expect(infer("テストカードA")).toEqual({
      kind: "card",
      accountId: "acc-2020",
      subAccountId: null,
      usage: null,
      cues: ["カード"],
    });
  });

  it("「銀行」「普通」を含めば bank・普通預金", () => {
    expect(infer("サンプル銀行")).toMatchObject({
      kind: "bank",
      accountId: "acc-1020",
      cues: ["銀行"],
    });
    expect(infer("テスト 普通")).toMatchObject({ kind: "bank", cues: ["普通"] });
  });

  it("「現金」「財布」を含めば cash・現金", () => {
    expect(infer("テスト現金")).toMatchObject({
      kind: "cash",
      accountId: "acc-1010",
      cues: ["現金"],
    });
    expect(infer("サイフ")).toMatchObject({ kind: "cash", cues: ["サイフ"] });
  });

  it("NFKC と英字の大小を無視する（全角の英字・半角カナ・小文字）", () => {
    expect(infer("ｔｅｓｔ　ＶＩＳＡ")).toMatchObject({ kind: "card", cues: ["VISA"] });
    expect(infer("test bank")).toMatchObject({ kind: "bank", cues: ["BANK"] });
    expect(infer("ﾃｽﾄｶｰﾄﾞ")).toMatchObject({ kind: "card", cues: ["カード"] });
  });

  it("2 つ以上の種類の語が当たれば推定しない（種類だけ other の案にもしない）", () => {
    expect(infer("サンプル銀行デビットカード")).toBeNull();
  });

  it("どれも当たらない・電子マネーは推定しない", () => {
    expect(infer("テスト口座")).toBeNull();
    expect(infer("Suica")).toBeNull();
    expect(infer("PayPay")).toBeNull();
    expect(infer("")).toBeNull();
  });

  it("同じ種類の語が複数当たれば、すべてを手がかりにする", () => {
    expect(infer("テストカード VISA")).toMatchObject({ kind: "card", cues: ["カード", "VISA"] });
  });
});

describe("inferStatementAccount（大項目）", () => {
  it("名前で決まらないときだけ、大項目を同じ表で見る。手がかりは「大項目: <名前>」", () => {
    expect(infer("テスト口座", ["クレジットカード"])).toMatchObject({
      kind: "card",
      accountId: "acc-2020",
      cues: ["大項目: クレジットカード"],
    });
  });

  it("名前で決まれば大項目は見ない（名前が優先）", () => {
    expect(infer("サンプル銀行", ["クレジットカード"])).toMatchObject({
      kind: "bank",
      cues: ["銀行"],
    });
  });

  it("名前が 2 種類に当たって決まらないときは、大項目で救わない", () => {
    expect(infer("サンプル銀行デビットカード", ["現金"])).toBeNull();
  });

  it("大項目が複数の種類に当たれば推定しない。当たらなければ推定しない", () => {
    expect(infer("テスト口座", ["クレジットカード", "現金"])).toBeNull();
    expect(infer("テスト口座", ["食費", "交通費"])).toBeNull();
  });

  it("同じ種類の大項目が複数でも決まる（手がかりは当たった大項目すべて）", () => {
    expect(infer("テスト口座", ["クレジットカード", "カード払い"])).toMatchObject({
      kind: "card",
      cues: ["大項目: クレジットカード", "大項目: カード払い"],
    });
  });
});

describe("inferStatementAccount（科目）", () => {
  it("コードの科目が事業体にないか使用停止なら、案にしない", () => {
    expect(infer("テストカード", [], [account("1010"), account("1020")])).toBeNull();
    expect(
      infer("テストカード", [], [account("2020", { isActive: false }), account("1020")]),
    ).toBeNull();
    // ほかの種類の科目があっても影響しない
    expect(infer("サンプル銀行", [], [account("1020")])).not.toBeNull();
  });
});

describe("inferStatementAccount（補助科目）", () => {
  it("決めた科目の有効な補助科目のうち、名前の包含が 1 つだけなら案にする（補助科目の名前が口座の名前に含まれる）", () => {
    const subs = [sub("s1", "2020", "テストカードA"), sub("s2", "2020", "テストカードB")];
    expect(infer("テストカードA", [], ACCOUNTS, subs)).toMatchObject({ subAccountId: "s1" });
  });

  it("口座の名前が補助科目の名前に含まれる向きも当てる（NFKC・大小を無視）", () => {
    const subs = [sub("s1", "2020", "ＴＥＳＴカード（事業用）")];
    expect(infer("testカード", [], ACCOUNTS, subs)).toMatchObject({ subAccountId: "s1" });
  });

  it("2 つ以上当たる・当たらない・使用停止・別の科目の補助科目・空の名前は案にしない", () => {
    const two = [sub("s1", "2020", "テスト"), sub("s2", "2020", "テストカード")];
    expect(infer("テストカード", [], ACCOUNTS, two)?.subAccountId).toBeNull();
    expect(
      infer("テストカード", [], ACCOUNTS, [sub("s1", "2020", "別のカード")])?.subAccountId,
    ).toBeNull();
    expect(
      infer("テストカード", [], ACCOUNTS, [sub("s1", "2020", "テストカード", false)])?.subAccountId,
    ).toBeNull();
    expect(
      infer("テストカード", [], ACCOUNTS, [sub("s1", "1020", "テストカード")])?.subAccountId,
    ).toBeNull();
    expect(infer("テストカード", [], ACCOUNTS, [sub("s1", "2020", "")])?.subAccountId).toBeNull();
  });
});

describe("inferStatementAccount（用途）", () => {
  it("事業・ビジネス・法人・BUSINESS は business", () => {
    for (const name of [
      "テストカード（事業用）",
      "ビジネスカード",
      "法人カード",
      "business card",
    ]) {
      expect(infer(name)?.usage).toBe("business");
    }
  });

  it("個人用・家計・私用は private", () => {
    for (const name of ["テストカード 個人用", "家計カード", "私用カード"]) {
      expect(infer(name)?.usage).toBe("private");
    }
  });

  it("手がかりがない・両方ある場合は推定しない（null）。種類の案は残る", () => {
    expect(infer("テストカード")?.usage).toBeNull();
    expect(infer("事業用 家計 カード")).toMatchObject({ kind: "card", usage: null });
  });

  it("用途は名前だけで決める（大項目の語は見ない）", () => {
    expect(infer("テスト口座", ["クレジットカード", "事業"])?.usage).toBeNull();
  });
});

// SC-004: 合成の口座名の一覧で、手がかりの語のある口座の 9 割以上に種類・科目の案が入る
describe("SC-004（合成の口座名）", () => {
  const WITH_CUES = [
    "サンプルカード",
    "テストカードA",
    "テストカードB（事業用）",
    "サンプルクレジット",
    "ダミーVISA",
    "ダミーMASTER 個人用",
    "テストJCB",
    "サンプルAMEX",
    "ダミーダイナース",
    "サンプル銀行 普通",
    "テスト銀行",
    "サンプル信用金庫",
    "テスト信金",
    "サンプル信用組合",
    "サンプル労働金庫",
    "ゆうちょ",
    "テスト普通預金",
    "サンプルBANK",
    "テスト現金",
    "サンプル財布",
    "テストサイフ",
    "法人カード",
    // 決まらない（2 つ以上の種類）
    "サンプル銀行デビットカード",
    "テスト銀行・現金",
  ];
  const WITHOUT_CUES = ["Suica", "PASMO", "PayPay", "テスト口座", "サンプル"];

  it("手がかりの語のある口座の 9 割以上に、種類と科目の案が入る", () => {
    expect(WITH_CUES.length).toBeGreaterThanOrEqual(20);
    const inferred = WITH_CUES.filter((n) => infer(n) !== null);
    expect(inferred.length / WITH_CUES.length).toBeGreaterThanOrEqual(0.9);
  });

  it("手がかりのない口座は案が入らない（未選択のまま残る）", () => {
    for (const name of WITHOUT_CUES) expect(infer(name)).toBeNull();
  });
});
