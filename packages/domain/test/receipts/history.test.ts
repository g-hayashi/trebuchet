import { describe, expect, it } from "vitest";
import { auditEntry } from "../../src/audit.ts";
import {
  linkStateOf,
  needsReason,
  RECEIPT_REASON_AUTO_VOIDED,
  type ReceiptValues,
  receiptValuesOf,
  replayReceiptHistory,
} from "../../src/receipts/history.ts";
import { FixedClock, SequentialIds } from "../fakes.ts";
import { fakeSha, makeReceiptLinkRow, makeReceiptRow } from "../receipt-setup.ts";

// T004: 履歴・結びつきの状態・理由の要否（research R5・R7、data-model §2.2・§2.5）

describe("linkStateOf", () => {
  it("有効な結びつきがなければ none（仕訳の状態は見ない）", () => {
    expect(linkStateOf(undefined, undefined)).toBe("none");
    expect(linkStateOf(undefined, "voided")).toBe("none");
  });

  it("結びつきがあって仕訳が active なら linked、voided なら journal_voided", () => {
    expect(linkStateOf(makeReceiptLinkRow(), "active")).toBe("linked");
    expect(linkStateOf(makeReceiptLinkRow(), "voided")).toBe("journal_voided");
  });

  it("閉じた結びつきは有効ではない（none）", () => {
    const closed = makeReceiptLinkRow({
      unlinkedAt: "2026-10-30T00:00:00.000Z",
      unlinkReason: "x",
    });
    expect(linkStateOf(closed, "active")).toBe("none");
  });
});

describe("RECEIPT_REASON_AUTO_VOIDED", () => {
  it("自動で閉じる結びつきの理由", () => {
    expect(RECEIPT_REASON_AUTO_VOIDED).toBe("結びついた仕訳が取り消されたため");
  });
});

describe("needsReason", () => {
  const before = makeReceiptRow({
    transactionDate: "2026-10-20",
    amount: 1100,
    partnerName: "カフェ",
    category: "paper_scan",
    memo: "会議",
  });
  const empty = makeReceiptRow({
    transactionDate: null,
    amount: null,
    partnerName: null,
    memo: null,
  });

  it("値のある欄を別の値に変えると要る（4 項目）", () => {
    expect(needsReason(before, { version: 1, transactionDate: "2026-10-21" })).toBe(true);
    expect(needsReason(before, { version: 1, amount: 1200 })).toBe(true);
    expect(needsReason(before, { version: 1, partnerName: "文具店" })).toBe(true);
    expect(needsReason(before, { version: 1, category: "electronic" })).toBe(true);
  });

  it("値のある欄を空にする（null）のも訂正", () => {
    expect(needsReason(before, { version: 1, transactionDate: null })).toBe(true);
    expect(needsReason(before, { version: 1, amount: null })).toBe(true);
    expect(needsReason(before, { version: 1, partnerName: null })).toBe(true);
  });

  it("未入力の欄を初めて埋めるときは要らない", () => {
    expect(needsReason(empty, { version: 1, transactionDate: "2026-10-21" })).toBe(false);
    expect(needsReason(empty, { version: 1, amount: 500 })).toBe(false);
    expect(needsReason(empty, { version: 1, partnerName: "カフェ" })).toBe(false);
    expect(
      needsReason(empty, {
        version: 1,
        transactionDate: "2026-10-21",
        amount: 500,
        partnerName: "カフェ",
      }),
    ).toBe(false);
  });

  it("未入力の欄を null のままにするのは変更ではない", () => {
    expect(needsReason(empty, { version: 1, amount: null })).toBe(false);
  });

  it("メモだけの変更は要らない（値のあるメモを変えても、空にしても）", () => {
    expect(needsReason(before, { version: 1, memo: "別のメモ" })).toBe(false);
    expect(needsReason(before, { version: 1, memo: null })).toBe(false);
    expect(needsReason(empty, { version: 1, memo: "新しいメモ" })).toBe(false);
  });

  it("同じ値の再送・指定なしは変更ではない", () => {
    expect(needsReason(before, { version: 1 })).toBe(false);
    expect(
      needsReason(before, {
        version: 1,
        transactionDate: "2026-10-20",
        amount: 1100,
        partnerName: "カフェ",
        category: "paper_scan",
      }),
    ).toBe(false);
  });

  it("埋める欄と訂正する欄が混ざれば要る", () => {
    expect(
      needsReason(makeReceiptRow({ amount: 1100, partnerName: null }), {
        version: 1,
        amount: 1200,
        partnerName: "カフェ",
      }),
    ).toBe(true);
  });

  it("理由の有無は判定に使わない", () => {
    expect(needsReason(before, { version: 1, amount: 1200, reason: "誤記" })).toBe(true);
    expect(needsReason(before, { version: 1, memo: "x", reason: "不要" })).toBe(false);
  });
});

describe("receiptValuesOf", () => {
  it("履歴に書く証憑の値（partnerKey を含めない）", () => {
    const row = makeReceiptRow({
      partnerName: "カフェ",
      memo: "m",
      category: "paper_scan",
      currentSha256: fakeSha(3),
    });
    expect(receiptValuesOf(row)).toEqual({
      category: "paper_scan",
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "カフェ",
      memo: "m",
      currentSha256: fakeSha(3),
      deletedAt: null,
    });
  });
});

describe("replayReceiptHistory", () => {
  const deps = { ids: new SequentialIds(), clock: new FixedClock("2026-10-20T00:00:00.000Z") };
  const at = (n: number) => `2026-10-${String(20 + n).padStart(2, "0")}T00:00:00.000Z`;

  const v1: ReceiptValues = {
    category: "paper_scan",
    transactionDate: null,
    amount: null,
    partnerName: null,
    memo: null,
    currentSha256: fakeSha(1),
    deletedAt: null,
  };
  const v2: ReceiptValues = {
    ...v1,
    transactionDate: "2026-10-20",
    amount: 1100,
    partnerName: "カフェ",
  };
  const v3: ReceiptValues = { ...v2, amount: 1200 };

  const entries = [
    auditEntry(deps, {
      targetType: "receipt",
      targetId: "r1",
      action: "create",
      after: v1,
      at: at(0),
    }),
    auditEntry(deps, {
      targetType: "receipt",
      targetId: "r1",
      action: "update",
      before: v1,
      after: v2,
      at: at(1),
    }),
    auditEntry(deps, {
      targetType: "receipt_link",
      targetId: "r1",
      action: "link",
      after: { receiptId: "r1", journalId: "j1" },
      at: at(2),
    }),
    auditEntry(deps, {
      targetType: "receipt",
      targetId: "r1",
      action: "update",
      before: v2,
      after: v3,
      reason: "誤記",
      at: at(3),
    }),
    auditEntry(deps, {
      targetType: "receipt",
      targetId: "r1",
      action: "replace_file",
      before: { sha256: fakeSha(1), fileVersion: 1 },
      after: { sha256: fakeSha(2), fileVersion: 2 },
      reason: "撮り直し",
      at: at(4),
    }),
    auditEntry(deps, {
      targetType: "receipt",
      targetId: "r1",
      action: "delete",
      before: { ...v3, currentSha256: fakeSha(2) },
      after: { deletedAt: at(5) },
      reason: "重複",
      at: at(5),
    }),
  ];

  it("追加の値から始め、更新・差し替え・削除を順に当てる（結びつき・読み取りは値を変えない）", () => {
    const points = replayReceiptHistory(entries);
    expect(points.map((p) => p.action)).toEqual([
      "create",
      "update",
      "update",
      "replace_file",
      "delete",
    ]);
    expect(points.map((p) => p.values)).toEqual([
      v1,
      v2,
      v3,
      { ...v3, currentSha256: fakeSha(2) },
      { ...v3, currentSha256: fakeSha(2), deletedAt: at(5) },
    ]);
    expect(points.map((p) => p.occurredAt)).toEqual([at(0), at(1), at(3), at(4), at(5)]);
  });

  it("空の履歴は空", () => {
    expect(replayReceiptHistory([])).toEqual([]);
  });

  it("入力の配列を書き換えない", () => {
    const copy = structuredClone(entries);
    replayReceiptHistory(entries);
    expect(entries).toEqual(copy);
  });
});
