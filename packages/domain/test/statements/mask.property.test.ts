import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildAiPayload,
  buildJournalEntryPayload,
  maskContent,
} from "../../src/statements/mask.ts";
import type { StatementRecord } from "../../src/types.ts";

// 006 T023（R11、INV-45）。AI に送る内容は許可した項目だけで、マスクした内容に 4 桁以上の数字・振込の名義がなく、
// 口座の名前・メモ・明細の ID はどこにも出ない

const DIGIT_RUN = /\p{Nd}{4,}/u;
const TRANSFER_PREFIXES = ["振込", "ﾌﾘｺﾐ", "フリコミ", "振替"] as const;

const statement = (over: Partial<StatementRecord> = {}): StatementRecord => ({
  id: "st-1",
  batchId: "b-1",
  statementAccountId: "sa-1",
  stableKey: "k",
  externalId: null,
  date: "2026-05-10",
  amount: -1200,
  content: "ショップ",
  normalizedContent: "ショップ",
  categoryMajor: "食費",
  categoryMinor: "外食",
  memo: null,
  transferFlag: false,
  changedJson: null,
  changedAckAt: null,
  excludedAt: null,
  excludedReason: null,
  createdAt: "2026-05-10T00:00:00.000Z",
  ...over,
});
const account = { name: "サンプル銀行", usage: "business", kind: "bank" } as const;

const digitsArb = fc
  .array(fc.constantFrom("0", "1", "2", "9", "０", "５", "８"), { minLength: 4, maxLength: 16 })
  .map((a) => a.join(""));
const contentArb = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 12 }),
      digitsArb,
      fc.constantFrom(" ", "-", "ABC", "ｱｲｳ", "foo@example.com", "03-1234-5678", "株式会社"),
    ),
    { maxLength: 8 },
  )
  .map((a) => a.join(""));
const uuidArb = fc.uuid();

describe("maskContent", () => {
  it("4 桁以上の数字の並び（全角を含む）を #### にする", () => {
    expect(maskContent("カード 1234567890123456 利用")).toBe("カード #### 利用");
    expect(maskContent("口座１２３４５６")).toBe("口座####");
    expect(maskContent("ショップ123")).toBe("ショップ123");
  });

  it("メールアドレス・電話番号の形を [連絡先] にする", () => {
    expect(maskContent("連絡 taro.y+1@example.co.jp まで")).toBe("連絡 [連絡先] まで");
    expect(maskContent("TEL 03-1234-5678")).toBe("TEL [連絡先]");
    expect(maskContent("090-1234-5678 宛")).toBe("[連絡先] 宛");
  });

  it("振込・振替で始まるときは、後ろの名義を [名義] にする", () => {
    expect(maskContent("振込 ヤマダ タロウ")).toBe("振込 [名義]");
    expect(maskContent("ﾌﾘｺﾐ ﾔﾏﾀﾞ")).toBe("ﾌﾘｺﾐ [名義]");
    expect(maskContent("フリコミ サトウ")).toBe("フリコミ [名義]");
    expect(maskContent("振替 山田太郎")).toBe("振替 [名義]");
    expect(maskContent("振込")).toBe("振込");
  });

  it("先頭が振込でなければ名義の置き換えはしない", () => {
    expect(maskContent("ショップ 振込 手数料")).toBe("ショップ 振込 手数料");
  });

  it("性質: どんな内容でも 4 桁以上の数字が残らない。冪等", () => {
    fc.assert(
      fc.property(contentArb, (content) => {
        const masked = maskContent(content);
        expect(masked).not.toMatch(DIGIT_RUN);
        expect(maskContent(masked)).toBe(masked);
      }),
    );
  });
});

describe("buildAiPayload（INV-45）", () => {
  it("許可した項目だけを持つ", () => {
    const payload = buildAiPayload(statement(), account);
    expect(payload).toEqual({
      scene: "statement",
      date: "2026-05-10",
      amount: 1200,
      direction: "out",
      content: "ショップ",
      categoryMajor: "食費",
      categoryMinor: "外食",
      accountKind: "bank",
      accountUsage: "business",
    });
    expect(buildAiPayload(statement({ amount: 300 }), account).direction).toBe("in");
  });

  it("性質: 内容の項目に 4 桁以上の数字・振込の名義がなく、口座の名前・メモ・明細の ID はどこにも出ない", () => {
    fc.assert(
      fc.property(
        contentArb,
        uuidArb,
        uuidArb,
        uuidArb,
        fc.constantFrom(...TRANSFER_PREFIXES),
        fc.boolean(),
        (content, accountId, name, memo, prefix, asTransfer) => {
          const holder = `名義${name}`;
          const text = asTransfer ? `${prefix} ${holder} ${content}` : content;
          const accountName = `口座${accountId}`;
          // 口座は名前を持つ実物（余分な項目が payload に漏れないことを確かめる）
          const holderAccount = { name: accountName, usage: "mixed", kind: "card" } as const;
          const payload = buildAiPayload(
            statement({ id: `id${accountId}`, content: text, memo: `メモ${memo}` }),
            holderAccount,
          );
          expect(payload.content).not.toMatch(DIGIT_RUN);
          if (asTransfer) expect(payload.content).not.toContain(holder);
          const json = JSON.stringify(payload);
          expect(json).not.toContain(accountName);
          expect(json).not.toContain(`メモ${memo}`);
          expect(json).not.toContain(`id${accountId}`);
          expect(Object.keys(payload).sort()).toEqual([
            "accountKind",
            "accountUsage",
            "amount",
            "categoryMajor",
            "categoryMinor",
            "content",
            "date",
            "direction",
            "scene",
          ]);
        },
      ),
    );
  });
});

describe("buildJournalEntryPayload（011 T042。INV-45）", () => {
  it("scene・日付・金額・マスクした摘要だけを持つ", () => {
    const payload = buildJournalEntryPayload({
      date: "2026-05-10",
      amount: 3300,
      memo: "カード 1234567890 03-1234-5678",
    });
    expect(payload).toEqual({
      scene: "journal_entry",
      date: "2026-05-10",
      amount: 3300,
      memo: "カード #### [連絡先]",
    });
  });

  it("性質: 摘要に 4 桁以上の数字・振込の名義がなく、取引先・口座の名前などの余分な項目が漏れない", () => {
    fc.assert(
      fc.property(
        contentArb,
        uuidArb,
        fc.constantFrom(...TRANSFER_PREFIXES),
        fc.boolean(),
        fc.integer({ min: 1, max: 999_999_999_999 }),
        (content, name, prefix, asTransfer, amount) => {
          const holder = `名義${name}`;
          const memo = asTransfer ? `${prefix} ${holder} ${content}` : content;
          // 余分な項目を持つ入力（取引先・口座の名前）を渡しても、payload には出ない
          const input = {
            date: "2026-05-10",
            amount,
            memo,
            partnerName: `取引先${name}`,
            accountName: `口座${name}`,
          };
          const payload = buildJournalEntryPayload(input);
          expect(payload.memo).not.toMatch(DIGIT_RUN);
          if (asTransfer) expect(payload.memo).not.toContain(holder);
          const json = JSON.stringify(payload);
          expect(json).not.toContain(`取引先${name}`);
          expect(json).not.toContain(`口座${name}`);
          expect(Object.keys(payload).sort()).toEqual(["amount", "date", "memo", "scene"]);
          expect(payload.scene).toBe("journal_entry");
          expect(payload.amount).toBe(amount);
        },
      ),
    );
  });
});
