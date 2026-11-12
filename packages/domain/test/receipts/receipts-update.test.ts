import { RECEIPT_MAX_BYTES, type ReceiptCreateOptions } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import type { ReceiptProbe } from "../../src/ports.ts";
import { receiptValuesOf, replayReceiptHistory } from "../../src/receipts/history.ts";
import type { ReceiptRow } from "../../src/types.ts";
import { linkReceipt, unlinkReceipt } from "../../src/usecases/receipt-links.ts";
import {
  addReceipt,
  deleteReceipt,
  getReceipt,
  getReceiptHistory,
  type ReceiptDeps,
  readReceiptFile,
  replaceReceiptFile,
  updateReceipt,
} from "../../src/usecases/receipts.ts";
import { jpegBytes, pdfBytes } from "../fixtures/receipts/sample-files.ts";
import { FaultInjectingReceiptUnitOfWork, receiptSnapshotOf } from "../receipt-fault-injection.ts";
import { addBareJournal, setupReceipts } from "../receipt-setup.ts";
import { codeOf } from "../result.ts";

// T027: 訂正・差し替え・削除・履歴（contracts/domain-module.md §3、research R7・R10、data-model §2.2・§2.5、
// FR-018・019）。入力部（未入力を埋める）は receipts-fill.test.ts

const FULL: ReceiptCreateOptions = {
  category: "electronic",
  transactionDate: "2026-10-20",
  amount: 1100,
  partnerName: "合成の店",
  memo: "会議",
};
const PROBE: ReceiptProbe = { width: 4032, height: 3024, fullColor: true };

function setup(options: ReceiptCreateOptions = FULL) {
  const base = setupReceipts();
  const added = addReceipt(base.deps, {
    bytes: jpegBytes({ seed: 1 }),
    originalName: "receipt.jpg",
    channel: "local",
    options,
    probe: PROBE,
  });
  if (!added.ok) throw new Error(added.error.message);
  return { ...base, receipt: added.value };
}

const replaceInput = (over: Partial<Parameters<typeof replaceReceiptFile>[2]> = {}) => ({
  bytes: jpegBytes({ seed: 2 }),
  originalName: "retake.jpg",
  channel: "remote" as const,
  reason: "撮り直し",
  version: 1,
  probe: PROBE,
  ...over,
});

/** 最初の証憑の今の行 */
const firstRow = (uow: ReturnType<typeof setupReceipts>["uow"]): ReceiptRow => {
  const row = uow.receipts.state.receipts[0];
  if (row === undefined) throw new Error("no receipt");
  return row;
};

describe("updateReceipt: 訂正（理由つき）", () => {
  it("入力済みの値を理由つきで変えられる。version +1、履歴 update に理由（前後の空白を除く）", () => {
    const { deps, receipt, uow, clock } = setup();
    clock.value = "2026-11-01T00:00:00.000Z";
    const result = updateReceipt(deps, receipt.id, {
      version: 1,
      amount: 2000,
      partnerName: "別の店",
      reason: "  誤入力の訂正  ",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { version: 2, amount: 2000, partnerName: "別の店" },
    });
    const audit = uow.receipts.state.audits.at(-1);
    expect(audit).toMatchObject({
      targetType: "receipt",
      targetId: receipt.id,
      action: "update",
      reason: "誤入力の訂正",
      occurredAt: "2026-11-01T00:00:00.000Z",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toMatchObject({
      amount: 1100,
      partnerName: "合成の店",
    });
    expect(JSON.parse(audit?.afterJson ?? "null")).toMatchObject({
      amount: 2000,
      partnerName: "別の店",
    });
    expect(uow.receipts.state.receipts[0]?.partnerKey).toBe("別の店");
  });

  it("区分の変更・値を空にする（null）も理由つきなら通る。履歴を当てると各時点の値に戻る", () => {
    const { deps, receipt, uow } = setup();
    const first = updateReceipt(deps, receipt.id, {
      version: 1,
      category: "paper_scan",
      reason: "区分の誤り",
    });
    expect(first).toMatchObject({ ok: true, value: { category: "paper_scan", version: 2 } });
    const afterFirst = receiptValuesOf(firstRow(uow));
    const second = updateReceipt(deps, receipt.id, {
      version: 2,
      amount: null,
      transactionDate: null,
      reason: "読み違い",
    });
    expect(second).toMatchObject({
      ok: true,
      value: { amount: null, transactionDate: null, version: 3 },
    });
    const points = replayReceiptHistory(uow.receipts.listAudit(receipt.id));
    expect(points.map((p) => p.action)).toEqual(["create", "update", "update"]);
    expect(points[0]?.values).toMatchObject({ category: "electronic", amount: 1100 });
    expect(points[1]?.values).toEqual(afterFirst);
    expect(points[2]?.values).toEqual(receiptValuesOf(firstRow(uow)));
  });

  it("理由がない・空白だけ・500 文字を超える訂正は REASON_REQUIRED で、何も書かない", () => {
    const { deps, receipt, uow } = setup();
    const before = receiptSnapshotOf(uow);
    for (const reason of [undefined, "", "   ", "あ".repeat(501)]) {
      const result = updateReceipt(deps, receipt.id, {
        version: 1,
        amount: 2000,
        ...(reason === undefined ? {} : { reason }),
      });
      expect(codeOf(result), String(reason)).toBe("REASON_REQUIRED");
    }
    expect(receiptSnapshotOf(uow)).toEqual(before);
  });

  it("未入力を埋めるだけなら理由は要らない。添えた理由は履歴に残す", () => {
    const { deps, receipt, uow } = setup({ category: "paper_scan" });
    const result = updateReceipt(deps, receipt.id, {
      version: 1,
      amount: 500,
      reason: "後から入力",
    });
    expect(result).toMatchObject({ ok: true, value: { amount: 500 } });
    expect(uow.receipts.state.audits.at(-1)).toMatchObject({
      action: "update",
      reason: "後から入力",
    });
  });

  it("結びつきのある証憑も訂正できる（結びつきはそのまま）", () => {
    const { deps, receipt, uow } = setup();
    addBareJournal(uow, { id: "j-1" });
    expect(linkReceipt(deps, receipt.id, { journalId: "j-1" }).ok).toBe(true);
    const result = updateReceipt(deps, receipt.id, { version: 1, amount: 3000, reason: "訂正" });
    expect(result).toMatchObject({ ok: true, value: { linkState: "linked", amount: 3000 } });
  });

  it("DB の書き込みが失敗したら、値も履歴も残さない", () => {
    const base = setup();
    const fault = new FaultInjectingReceiptUnitOfWork(base.uow);
    const deps: ReceiptDeps = { ...base.deps, uow: fault };
    const before = receiptSnapshotOf(base.uow);
    for (const failAt of [1, 2]) {
      fault.failAt = failAt;
      expect(() =>
        updateReceipt(deps, base.receipt.id, { version: 1, amount: 9, reason: "訂正" }),
      ).toThrow(/injected failure/);
      expect(receiptSnapshotOf(base.uow)).toEqual(before);
    }
  });
});

describe("replaceReceiptFile: 差し替え", () => {
  it("版 +1 のファイル、今の版の更新、証憑の version +1、履歴 replace_file（前後の版と理由）", () => {
    const { deps, receipt, uow, files, clock } = setup();
    clock.value = "2026-11-01T00:00:00.000Z";
    const bytes = jpegBytes({ seed: 2 });
    const sha = files.digest(bytes);
    const result = replaceReceiptFile(deps, receipt.id, replaceInput({ bytes }));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toMatchObject({
      version: 2,
      channel: "local", // 証憑の経路は最初の受け取りのまま
      currentFile: {
        sha256: sha,
        fileVersion: 2,
        originalName: "retake.jpg",
        channel: "remote",
        addedAt: "2026-11-01T00:00:00.000Z",
      },
    });
    expect(result.value.files.map((f) => f.fileVersion)).toEqual([1, 2]);
    expect(files.has(sha)).toBe(true);
    const audit = uow.receipts.state.audits.at(-1);
    expect(audit).toMatchObject({
      targetType: "receipt",
      targetId: receipt.id,
      action: "replace_file",
      reason: "撮り直し",
    });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toEqual({
      sha256: receipt.currentFile.sha256,
      fileVersion: 1,
    });
    expect(JSON.parse(audit?.afterJson ?? "null")).toEqual({ sha256: sha, fileVersion: 2 });
    // 差し替え前の版も取り出せる。履歴を当てると追加したときの原本に戻る
    expect(readReceiptFile(deps, receipt.id, receipt.currentFile.sha256).ok).toBe(true);
    const points = replayReceiptHistory(uow.receipts.listAudit(receipt.id));
    expect(points.map((p) => p.values.currentSha256)).toEqual([receipt.currentFile.sha256, sha]);
  });

  it("2 回目の差し替えは版 3（最新の版の次）", () => {
    const { deps, receipt } = setup();
    expect(replaceReceiptFile(deps, receipt.id, replaceInput()).ok).toBe(true);
    const result = replaceReceiptFile(
      deps,
      receipt.id,
      replaceInput({ bytes: pdfBytes({ seed: 3 }), version: 2, probe: null }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { version: 3, currentFile: { fileVersion: 3, mediaType: "application/pdf" } },
    });
  });

  it("警告（解像度・階調）が出ても差し替える", () => {
    const { deps, receipt } = setup({ ...FULL, category: "paper_scan" });
    const result = replaceReceiptFile(
      deps,
      receipt.id,
      replaceInput({ probe: { width: 1000, height: 800, fullColor: false } }),
    );
    if (!result.ok) throw new Error(result.error.message);
    const codes = result.value.warnings.map((w) => w.code);
    expect(codes).toContain("RESOLUTION_BELOW_GUIDE");
    expect(codes).toContain("NOT_FULL_COLOR");
  });

  it("同じ内容（今の版・前の版・別の証憑・削除済みの証憑）は RECEIPT_DUPLICATE で、何も書かない", () => {
    const { deps, receipt, uow, files } = setup();
    const other = addReceipt(deps, {
      bytes: jpegBytes({ seed: 7 }),
      originalName: "o.jpg",
      channel: "local",
      options: FULL,
      probe: null,
    });
    if (!other.ok) throw new Error(other.error.message);
    expect(deleteReceipt(deps, other.value.id, { reason: "不要", version: 1 }).ok).toBe(true);
    expect(replaceReceiptFile(deps, receipt.id, replaceInput()).ok).toBe(true);
    const before = receiptSnapshotOf(uow);
    const putsBefore = [...files.puts];
    const cases: [number, string, boolean][] = [
      [2, receipt.id, false], // 今の版
      [1, receipt.id, false], // 差し替え前の版
      [7, other.value.id, true], // 削除済みの別の証憑
    ];
    for (const [seed, owner, deleted] of cases) {
      expect(
        replaceReceiptFile(
          deps,
          receipt.id,
          replaceInput({ bytes: jpegBytes({ seed }), version: 2 }),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: "RECEIPT_DUPLICATE", details: { receiptId: owner, deleted } },
      });
    }
    expect(receiptSnapshotOf(uow)).toEqual(before);
    expect(files.puts).toEqual(putsBefore);
    expect(files.discarded).toEqual([]);
  });

  it("エラー: なし・削除済み・version・理由・形式・大きさ。何も書かない", () => {
    const { deps, receipt, uow, files } = setup();
    const big = new Uint8Array(RECEIPT_MAX_BYTES + 1);
    big.set(jpegBytes({ seed: 9 }), 0);
    const before = receiptSnapshotOf(uow);
    expect(codeOf(replaceReceiptFile(deps, "nope", replaceInput()))).toBe("RECEIPT_NOT_FOUND");
    expect(codeOf(replaceReceiptFile(deps, receipt.id, replaceInput({ version: 5 })))).toBe(
      "VERSION_CONFLICT",
    );
    expect(codeOf(replaceReceiptFile(deps, receipt.id, replaceInput({ reason: " " })))).toBe(
      "REASON_REQUIRED",
    );
    expect(
      codeOf(replaceReceiptFile(deps, receipt.id, replaceInput({ bytes: new Uint8Array(8) }))),
    ).toBe("RECEIPT_FORMAT_UNSUPPORTED");
    expect(codeOf(replaceReceiptFile(deps, receipt.id, replaceInput({ bytes: big })))).toBe(
      "FILE_TOO_LARGE",
    );
    expect(receiptSnapshotOf(uow)).toEqual(before);
    expect(files.puts).toHaveLength(1);

    expect(deleteReceipt(deps, receipt.id, { reason: "不要", version: 1 }).ok).toBe(true);
    const afterDelete = receiptSnapshotOf(uow);
    expect(replaceReceiptFile(deps, receipt.id, replaceInput({ version: 99 }))).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_DELETED" },
    });
    expect(receiptSnapshotOf(uow)).toEqual(afterDelete);
    expect(files.puts).toHaveLength(1);
  });

  it("DB の書き込みが失敗したら、行も履歴も、この呼び出しが置いたファイルも残さない", () => {
    const base = setup();
    const fault = new FaultInjectingReceiptUnitOfWork(base.uow);
    const deps: ReceiptDeps = { ...base.deps, uow: fault };
    const before = receiptSnapshotOf(base.uow);
    const bytes = jpegBytes({ seed: 2 });
    const sha = base.files.digest(bytes);
    for (const failAt of [1, 2, 3]) {
      fault.failAt = failAt;
      expect(() => replaceReceiptFile(deps, base.receipt.id, replaceInput({ bytes }))).toThrow(
        /injected failure/,
      );
      expect(receiptSnapshotOf(base.uow)).toEqual(before);
      expect(base.files.has(sha)).toBe(false);
    }
    expect(base.files.has(base.receipt.currentFile.sha256)).toBe(true);
  });

  it("前の異常終了で残った同じ内容のファイルは使い回し、失敗しても消さない", () => {
    const base = setup();
    const bytes = jpegBytes({ seed: 2 });
    const sha = base.files.digest(bytes);
    base.files.put(sha, bytes);
    const fault = new FaultInjectingReceiptUnitOfWork(base.uow);
    fault.failAt = 1;
    const deps: ReceiptDeps = { ...base.deps, uow: fault };
    expect(() => replaceReceiptFile(deps, base.receipt.id, replaceInput({ bytes }))).toThrow();
    expect(base.files.has(sha)).toBe(true);
    expect(base.files.discarded).toEqual([]);
  });
});

describe("deleteReceipt: 論理削除", () => {
  it("deleted_at・理由・version +1、履歴 delete（前は値、後は deletedAt）。行・ファイルは残る", () => {
    const { deps, receipt, uow, files, clock } = setup();
    clock.value = "2026-11-02T00:00:00.000Z";
    const result = deleteReceipt(deps, receipt.id, { reason: " 重複のため ", version: 1 });
    expect(result).toMatchObject({
      ok: true,
      value: {
        deleted: true,
        deletedAt: "2026-11-02T00:00:00.000Z",
        deletedReason: "重複のため",
        version: 2,
        warnings: [],
      },
    });
    const audit = uow.receipts.state.audits.at(-1);
    expect(audit).toMatchObject({ action: "delete", reason: "重複のため" });
    expect(JSON.parse(audit?.beforeJson ?? "null")).toEqual(
      receiptValuesOf({ ...firstRow(uow), deletedAt: null }),
    );
    expect(JSON.parse(audit?.afterJson ?? "null")).toEqual({
      deletedAt: "2026-11-02T00:00:00.000Z",
    });
    expect(uow.receipts.state.receipts).toHaveLength(1);
    expect(files.has(receipt.currentFile.sha256)).toBe(true);
    // 削除の後も表示・取り出し・履歴はできる
    expect(getReceipt(deps, receipt.id)).toMatchObject({ ok: true, value: { deleted: true } });
    expect(readReceiptFile(deps, receipt.id, receipt.currentFile.sha256).ok).toBe(true);
    const points = replayReceiptHistory(uow.receipts.listAudit(receipt.id));
    expect(points.at(-1)?.values).toEqual(receiptValuesOf(firstRow(uow)));
  });

  it("削除の後は訂正・差し替え・削除が RECEIPT_DELETED", () => {
    const { deps, receipt } = setup();
    expect(deleteReceipt(deps, receipt.id, { reason: "不要", version: 1 }).ok).toBe(true);
    expect(codeOf(updateReceipt(deps, receipt.id, { version: 2, memo: "x" }))).toBe(
      "RECEIPT_DELETED",
    );
    expect(codeOf(replaceReceiptFile(deps, receipt.id, replaceInput({ version: 2 })))).toBe(
      "RECEIPT_DELETED",
    );
    expect(codeOf(deleteReceipt(deps, receipt.id, { reason: "不要", version: 2 }))).toBe(
      "RECEIPT_DELETED",
    );
  });

  it("有効な結びつき（仕訳が取り消されていても）があれば RECEIPT_LINKED（details.journalId）。解除すれば削除できる", () => {
    const { deps, receipt, uow } = setup();
    addBareJournal(uow, { id: "j-1" });
    expect(linkReceipt(deps, receipt.id, { journalId: "j-1" }).ok).toBe(true);
    const before = receiptSnapshotOf(uow);
    expect(deleteReceipt(deps, receipt.id, { reason: "不要", version: 1 })).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_LINKED", details: { journalId: "j-1" } },
    });
    // 失敗した run は状態を複製で戻すので、仕訳はその都度引き直す
    const setStatus = (status: "active" | "voided") => {
      const journal = uow.ledger.state.journals.find((j) => j.id === "j-1");
      if (journal === undefined) throw new Error("journal");
      journal.status = status;
    };
    setStatus("voided");
    expect(codeOf(deleteReceipt(deps, receipt.id, { reason: "不要", version: 1 }))).toBe(
      "RECEIPT_LINKED",
    );
    setStatus("active");
    expect(receiptSnapshotOf(uow)).toEqual(before);
    expect(unlinkReceipt(deps, receipt.id, { reason: "誤り" }).ok).toBe(true);
    expect(deleteReceipt(deps, receipt.id, { reason: "不要", version: 1 }).ok).toBe(true);
  });

  it("エラー: なし・version・理由。何も書かない", () => {
    const { deps, receipt, uow } = setup();
    const before = receiptSnapshotOf(uow);
    expect(codeOf(deleteReceipt(deps, "nope", { reason: "x", version: 1 }))).toBe(
      "RECEIPT_NOT_FOUND",
    );
    expect(deleteReceipt(deps, receipt.id, { reason: "x", version: 3 })).toMatchObject({
      ok: false,
      error: { code: "VERSION_CONFLICT", details: { currentVersion: 1 } },
    });
    expect(codeOf(deleteReceipt(deps, receipt.id, { reason: "  ", version: 1 }))).toBe(
      "REASON_REQUIRED",
    );
    expect(receiptSnapshotOf(uow)).toEqual(before);
  });

  it("DB の書き込みが失敗したら何も残さない", () => {
    const base = setup();
    const fault = new FaultInjectingReceiptUnitOfWork(base.uow);
    const deps: ReceiptDeps = { ...base.deps, uow: fault };
    const before = receiptSnapshotOf(base.uow);
    for (const failAt of [1, 2]) {
      fault.failAt = failAt;
      expect(() => deleteReceipt(deps, base.receipt.id, { reason: "x", version: 1 })).toThrow(
        /injected failure/,
      );
      expect(receiptSnapshotOf(base.uow)).toEqual(before);
    }
  });
});

describe("getReceiptHistory", () => {
  it("古い順。値の操作と結びつけ・解除を含み、before・after は値、理由つき", () => {
    const { deps, receipt, uow, clock } = setup();
    addBareJournal(uow, { id: "j-1" });
    const at = (n: number) => `2026-11-01T00:00:0${n}.000Z`;
    clock.value = at(1);
    updateReceipt(deps, receipt.id, { version: 1, amount: 2000, reason: "訂正" });
    clock.value = at(2);
    linkReceipt(deps, receipt.id, { journalId: "j-1" });
    clock.value = at(3);
    unlinkReceipt(deps, receipt.id, { reason: "誤り" });
    clock.value = at(4);
    replaceReceiptFile(deps, receipt.id, replaceInput({ version: 2 }));
    clock.value = at(5);
    deleteReceipt(deps, receipt.id, { reason: "不要", version: 3 });

    const result = getReceiptHistory(deps, receipt.id);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.map((e) => [e.targetType, e.action, e.reason])).toEqual([
      ["receipt", "create", null],
      ["receipt", "update", "訂正"],
      ["receipt_link", "link", null],
      ["receipt_link", "unlink", "誤り"],
      ["receipt", "replace_file", "撮り直し"],
      ["receipt", "delete", "不要"],
    ]);
    expect(result.value[0]).toMatchObject({ before: null, after: { amount: 1100 } });
    expect(result.value[1]).toMatchObject({
      occurredAt: at(1),
      before: { amount: 1100 },
      after: { amount: 2000 },
    });
    expect(result.value[2]).toMatchObject({
      after: { receiptId: receipt.id, journalId: "j-1" },
    });
    expect(result.value[5]).toMatchObject({ after: { deletedAt: at(5) } });
  });

  it("ない証憑は RECEIPT_NOT_FOUND", () => {
    const { deps } = setup();
    expect(codeOf(getReceiptHistory(deps, "nope"))).toBe("RECEIPT_NOT_FOUND");
  });
});
