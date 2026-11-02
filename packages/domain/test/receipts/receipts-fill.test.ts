import type { ReceiptCreateOptions, ReceiptUpdateInput } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { replayReceiptHistory } from "../../src/receipts/history.ts";
import { addReceipt, type ReceiptDeps, updateReceipt } from "../../src/usecases/receipts.ts";
import { jpegBytes } from "../fixtures/receipts/sample-files.ts";
import { FaultInjectingReceiptUnitOfWork, receiptSnapshotOf } from "../receipt-fault-injection.ts";
import { setupReceipts } from "../receipt-setup.ts";

// T017b: 理由なしで未入力の値を埋める経路（contracts/domain-module.md §3 の updateReceipt の US1 の段、D1）

const EMPTY: ReceiptCreateOptions = { category: "paper_scan" };
const FULL: ReceiptCreateOptions = {
  category: "electronic",
  transactionDate: "2026-10-20",
  amount: 1100,
  partnerName: "合成の店",
  memo: "会議",
};

function setup(options: ReceiptCreateOptions = EMPTY) {
  const base = setupReceipts();
  const added = addReceipt(base.deps, {
    bytes: jpegBytes({ seed: 1 }),
    originalName: "receipt.jpg",
    channel: "local",
    options,
    probe: { width: 4032, height: 3024, fullColor: true },
  });
  if (!added.ok) throw new Error(added.error.message);
  return { ...base, receipt: added.value };
}

const update = (deps: ReceiptDeps, id: string, input: ReceiptUpdateInput) =>
  updateReceipt(deps, id, input);

describe("updateReceipt: 未入力の値を埋める（理由なし）", () => {
  it("取引年月日・金額・取引先・メモを入れると、値が変わり version が +1 になる", () => {
    const { deps, receipt, clock } = setup();
    clock.value = "2026-11-01T00:00:00.000Z";
    const result = update(deps, receipt.id, {
      version: receipt.version,
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "  合成の店  ",
      memo: "会議",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        id: receipt.id,
        version: receipt.version + 1,
        transactionDate: "2026-10-20",
        amount: 1100,
        partnerName: "合成の店",
        memo: "会議",
      },
    });
  });

  it("入れた分だけ FIELDS_MISSING の警告が減る", () => {
    const { deps, receipt } = setup();
    const codes = (w: { code: string }[]) => w.map((x) => x.code);
    expect(codes(receipt.warnings)).toContain("FIELDS_MISSING");
    const result = update(deps, receipt.id, {
      version: 1,
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(codes(result.value.warnings)).not.toContain("FIELDS_MISSING");
  });

  it("partnerKey を正規化して保存する（検索に使う）", () => {
    const { deps, receipt, uow } = setup();
    const result = update(deps, receipt.id, { version: 1, partnerName: "ａｂｃ 商店" });
    expect(result.ok).toBe(true);
    expect(uow.receipts.state.receipts[0]?.partnerKey).toBe("ABC商店");
  });

  it("履歴 update を 1 件書く（理由なし、before・after に全体の値）", () => {
    const { deps, receipt, uow } = setup();
    update(deps, receipt.id, { version: 1, amount: 500 });
    const audits = uow.receipts.state.audits.filter((a) => a.action === "update");
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit).toMatchObject({ targetType: "receipt", targetId: receipt.id, reason: null });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({ amount: null });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({
      amount: 500,
      category: "paper_scan",
    });
    // 履歴を順に当てると今の値になる（INV-63）
    const points = replayReceiptHistory(uow.receipts.state.audits);
    expect(points.at(-1)?.values).toMatchObject({ amount: 500 });
  });

  it("メモは入力済みでも理由なしで変えられる", () => {
    const { deps, receipt } = setup({ ...FULL, memo: "古いメモ" });
    const result = update(deps, receipt.id, { version: 1, memo: "新しいメモ" });
    expect(result).toMatchObject({ ok: true, value: { memo: "新しいメモ", version: 2 } });
    const cleared = update(deps, receipt.id, { version: 2, memo: null });
    expect(cleared).toMatchObject({ ok: true, value: { memo: null, version: 3 } });
  });

  it("入力済みの値と同じ値を送っても訂正にならず通る", () => {
    const { deps, receipt } = setup(FULL);
    const result = update(deps, receipt.id, {
      version: 1,
      amount: 1100,
      transactionDate: "2026-10-20",
      partnerName: "合成の店",
      category: "electronic",
    });
    expect(result.ok).toBe(true);
  });

  it("何も変わらなければ書かない（version も履歴も増えない）", () => {
    const { deps, receipt, uow } = setup(FULL);
    const before = receiptSnapshotOf(uow);
    const result = update(deps, receipt.id, { version: 1, amount: 1100 });
    expect(result).toMatchObject({ ok: true, value: { version: 1 } });
    expect(receiptSnapshotOf(uow)).toEqual(before);
  });
});

describe("updateReceipt: 訂正はまだ受けない（US5 の T027 まで）", () => {
  it("入力済みの値の変更は 422 REASON_REQUIRED で、何も書かない", () => {
    const { deps, receipt, uow } = setup(FULL);
    const before = receiptSnapshotOf(uow);
    const inputs: Partial<ReceiptUpdateInput>[] = [
      { amount: 2000 },
      { transactionDate: "2026-10-21" },
      { partnerName: "別の店" },
      { category: "paper_scan" },
      { amount: null },
    ];
    for (const input of inputs) {
      expect(
        update(deps, receipt.id, { version: 1, ...input }),
        JSON.stringify(input),
      ).toMatchObject({
        ok: false,
        error: { code: "REASON_REQUIRED" },
      });
    }
    expect(receiptSnapshotOf(uow)).toEqual(before);
  });

  it("reason を添えても、この段では訂正として受けない（REASON_REQUIRED）", () => {
    const { deps, receipt } = setup(FULL);
    expect(update(deps, receipt.id, { version: 1, amount: 2000, reason: "誤入力" })).toMatchObject({
      ok: false,
      error: { code: "REASON_REQUIRED" },
    });
  });

  it("未入力を埋めながら入力済みを変えるなら、全体を拒む（一部だけ通さない）", () => {
    const { deps, receipt, uow } = setup({ category: "electronic", amount: 1100 });
    const before = receiptSnapshotOf(uow);
    expect(
      update(deps, receipt.id, { version: 1, amount: 2000, partnerName: "合成の店" }),
    ).toMatchObject({ ok: false, error: { code: "REASON_REQUIRED" } });
    expect(receiptSnapshotOf(uow)).toEqual(before);
  });
});

describe("updateReceipt: エラー", () => {
  it("存在しない証憑は RECEIPT_NOT_FOUND", () => {
    const { deps } = setup();
    expect(update(deps, "nope", { version: 1, amount: 1 })).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_NOT_FOUND" },
    });
  });

  it("削除済みは RECEIPT_DELETED（version の不一致より先）", () => {
    const { deps, receipt, uow } = setup();
    const row = uow.receipts.state.receipts[0];
    if (row === undefined) throw new Error("no row");
    row.deletedAt = "2026-10-31T10:00:00.000Z";
    row.deletedReason = "不要";
    expect(update(deps, receipt.id, { version: 99, amount: 1 })).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_DELETED" },
    });
  });

  it("version の不一致は 409 VERSION_CONFLICT（details.currentVersion）", () => {
    const { deps, receipt } = setup();
    expect(update(deps, receipt.id, { version: 5, amount: 1 })).toMatchObject({
      ok: false,
      error: { code: "VERSION_CONFLICT", details: { currentVersion: 1 } },
    });
  });

  it("値の検査: 日付・金額・取引先・メモは VALIDATION", () => {
    const bad: Partial<ReceiptUpdateInput>[] = [
      { transactionDate: "2026-02-30" },
      { amount: 0 },
      { amount: 1_000_000_000_000 },
      { amount: 12.5 },
      { partnerName: "   " },
      { partnerName: "あ".repeat(101) },
      { memo: "あ".repeat(501) },
    ];
    for (const input of bad) {
      const { deps, receipt, uow } = setup();
      const before = receiptSnapshotOf(uow);
      expect(
        update(deps, receipt.id, { version: 1, ...input }),
        JSON.stringify(input),
      ).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" },
      });
      expect(receiptSnapshotOf(uow)).toEqual(before);
    }
  });

  it("DB の書き込みが失敗したら、値も履歴も残さない", () => {
    const base = setup();
    const fault = new FaultInjectingReceiptUnitOfWork(base.uow);
    const deps: ReceiptDeps = { ...base.deps, uow: fault };
    const before = receiptSnapshotOf(base.uow);
    for (const failAt of [1, 2]) {
      fault.failAt = failAt;
      expect(() => update(deps, base.receipt.id, { version: 1, amount: 500 })).toThrow(
        /injected failure/,
      );
      expect(receiptSnapshotOf(base.uow)).toEqual(before);
    }
  });
});
