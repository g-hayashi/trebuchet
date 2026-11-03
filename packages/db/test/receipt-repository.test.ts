import { randomUUIDv7 } from "node:crypto";
import {
  auditEntry,
  domainError,
  err,
  ok,
  type ReceiptAuditEntry,
  RepositoryConflictError,
} from "@trebuchet/domain";
import { ReceiptQuery, type ReceiptQueryInput } from "@trebuchet/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempDataDir, useTempDataDir } from "../src/testing.ts";
import { NOW } from "./receipt-db-setup.ts";
import {
  fakeSha,
  makeFile,
  makeLink,
  makeReading,
  makeReceipt,
  setupReceiptDb,
} from "./receipt-repo-setup.ts";

// ReceiptStore（receipt-repository.ts）。実際の DB（foreign_keys=ON）と drizzleUnitOfWork で確かめる。
// 検索の SQL と matchesReceiptQuery の一致（INV-65）は receipt-search.property.test.ts

let tmp: TempDataDir;
let s: ReturnType<typeof setupReceiptDb>;
beforeEach(() => {
  tmp = useTempDataDir("receipt-repository");
  s = setupReceiptDb();
});
afterEach(() => tmp.cleanup());

const query = (input: ReceiptQueryInput = {}) => ReceiptQuery.parse(input);
const count = (table: string) => Number(s.raw.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n);

describe("追加・読み取り・版", () => {
  it("追加（insertReceipt → insertFile）の往復。列の型（boolean・null）が戻る", () => {
    const { receipt, file } = s.add(
      {
        transactionDate: "2026-10-20",
        amount: 1100,
        partnerName: "ｶﾌｪ ABC",
        memo: "メモ",
        channel: "remote",
      },
      { fullColor: false, width: null, height: null, mediaType: "application/pdf" },
    );
    s.inUow((r) => {
      expect(r.getReceipt(receipt.id)).toEqual(receipt);
      expect(r.listFiles(receipt.id)).toEqual([file]);
      expect(r.findFileBySha(file.sha256)).toEqual(file);
      expect(r.getReceipt(randomUUIDv7())).toBeUndefined();
      expect(r.findFileBySha(fakeSha(999))).toBeUndefined();
    });
    s.add({ currentSha256: fakeSha(2) }, { fullColor: null });
    s.inUow((r) => {
      expect(r.findFileBySha(fakeSha(2))?.fullColor).toBeNull();
    });
  });

  it("updateReceipt は版が合えば書き、版は row.version になる。受領日時・経路は変えられない", () => {
    const { receipt } = s.add();
    const next = {
      ...receipt,
      version: 2,
      amount: 500,
      memo: "更新",
      updatedAt: "2026-11-03T00:00:00.000Z",
    };
    s.inUow((r) => r.updateReceipt(next, 1));
    s.inUow((r) => {
      expect(r.getReceipt(receipt.id)).toEqual(next);
    });
    expect(() => s.inUow((r) => r.updateReceipt({ ...next, receivedAt: "2027-01-01" }, 2))).toThrow(
      /immutable/,
    );
  });

  it("版が合わなければ RepositoryConflictError で何も変えない", () => {
    const { receipt } = s.add();
    expect(() => s.inUow((r) => r.updateReceipt({ ...receipt, version: 4, amount: 1 }, 3))).toThrow(
      RepositoryConflictError,
    );
    s.inUow((r) => {
      expect(r.getReceipt(receipt.id)?.amount).toBeNull();
    });
    // ない証憑は版の衝突ではなく例外
    const missing = makeReceipt();
    expect(() => s.inUow((r) => r.updateReceipt(missing, 1))).toThrow(/not found/);
  });

  it("削除（deleted_at）は 1 回だけ。削除の取り消しはトリガーで止まる", () => {
    const { receipt } = s.add();
    const deleted = {
      ...receipt,
      version: 2,
      deletedAt: "2026-11-03T00:00:00.000Z",
      deletedReason: "誤り",
    };
    s.inUow((r) => r.updateReceipt(deleted, 1));
    expect(() =>
      s.inUow((r) =>
        r.updateReceipt({ ...deleted, version: 3, deletedAt: null, deletedReason: null }, 2),
      ),
    ).toThrow();
  });

  it("listFiles は版の昇順。findFileBySha は削除済み・差し替え前の版も返す", () => {
    const { receipt } = s.add({ currentSha256: fakeSha(1) });
    s.inUow((r) => {
      r.insertFile(makeFile(receipt.id, { sha256: fakeSha(2), fileVersion: 2 }));
      r.updateReceipt({ ...receipt, version: 2, currentSha256: fakeSha(2) }, 1);
    });
    s.inUow((r) => {
      expect(r.listFiles(receipt.id).map((f) => f.fileVersion)).toEqual([1, 2]);
      expect(r.findFileBySha(fakeSha(1))?.fileVersion).toBe(1);
    });
  });

  it("重複の sha256 は UNIQUE（PRIMARY KEY）で拒む。版の重複も拒む", () => {
    const { receipt } = s.add();
    expect(() => s.inUow((r) => r.insertFile(makeFile(receipt.id, { fileVersion: 2 })))).toThrow(
      /UNIQUE|constraint/i,
    );
    expect(() =>
      s.inUow((r) => r.insertFile(makeFile(receipt.id, { sha256: fakeSha(5), fileVersion: 1 }))),
    ).toThrow(/UNIQUE|constraint/i);
    // 別の証憑が同じ sha256 のファイルを足すことも拒む
    expect(() => s.add({ currentSha256: fakeSha(1) })).toThrow(/UNIQUE|constraint/i);
    expect(count("receipts")).toBe(1);
  });
});

describe("循環の外部キー（DEFERRABLE INITIALLY DEFERRED。I1）", () => {
  it("追加（insertReceipt → insertFile）と差し替え（insertFile → updateReceipt）が通る", () => {
    const { receipt } = s.add();
    s.inUow((r) => {
      r.insertFile(makeFile(receipt.id, { sha256: fakeSha(2), fileVersion: 2 }));
      r.updateReceipt({ ...receipt, version: 2, currentSha256: fakeSha(2) }, 1);
    });
    expect(count("receipt_files")).toBe(2);
    s.inUow((r) => {
      expect(r.getReceipt(receipt.id)?.currentSha256).toBe(fakeSha(2));
    });
  });

  it("途中で例外なら全部戻る（追加も差し替えも）", () => {
    const receipt = makeReceipt();
    expect(() =>
      s.inUow((r) => {
        r.insertReceipt(receipt);
        r.insertFile(makeFile(receipt.id));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count("receipts")).toBe(0);
    expect(count("receipt_files")).toBe(0);

    const { receipt: kept } = s.add({ currentSha256: fakeSha(7) });
    expect(() =>
      s.inUow((r) => {
        r.insertFile(makeFile(kept.id, { sha256: fakeSha(8), fileVersion: 2 }));
        r.updateReceipt({ ...kept, version: 2, currentSha256: fakeSha(8) }, 1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count("receipt_files")).toBe(1);
    s.inUow((r) => {
      expect(r.getReceipt(kept.id)?.currentSha256).toBe(fakeSha(7));
    });
  });

  it("err を返しても全部戻る", () => {
    const receipt = makeReceipt();
    const result = s.uow.run((tx) => {
      tx.receipts.insertReceipt(receipt);
      tx.receipts.insertFile(makeFile(receipt.id));
      return err(domainError("VALIDATION", "x"));
    });
    expect(result.ok).toBe(false);
    expect(count("receipts")).toBe(0);
    expect(count("receipt_files")).toBe(0);
  });

  it("insertFile を欠いたまま run を終えるとコミットで外部キーの違反になり、何も残らない", () => {
    const receipt = makeReceipt();
    expect(() =>
      s.uow.run((tx) => {
        tx.receipts.insertReceipt(receipt);
        return ok(undefined);
      }),
    ).toThrow(/FOREIGN KEY/i);
    expect(count("receipts")).toBe(0);

    // 差し替えで updateReceipt だけ（insertFile なし）も同じ
    const { receipt: kept } = s.add({ currentSha256: fakeSha(3) });
    expect(() =>
      s.uow.run((tx) => {
        tx.receipts.updateReceipt({ ...kept, version: 2, currentSha256: fakeSha(4) }, 1);
        return ok(undefined);
      }),
    ).toThrow(/FOREIGN KEY/i);
    s.inUow((r) => {
      expect(r.getReceipt(kept.id)?.currentSha256).toBe(fakeSha(3));
    });
  });
});

describe("結びつき", () => {
  it("insertLink → getActiveLink → closeLink。有効な結びつきは証憑ごとに 1 件", () => {
    const { receipt } = s.add();
    const journalId = s.raw.seedJournal();
    const link = makeLink(receipt.id, journalId);
    s.inUow((r) => r.insertLink(link));
    s.inUow((r) => {
      expect(r.getActiveLink(receipt.id)).toEqual(link);
      expect(r.listActiveLinksByJournal(journalId)).toEqual([link]);
    });
    expect(() => s.inUow((r) => r.insertLink(makeLink(receipt.id, s.raw.seedJournal())))).toThrow(
      /UNIQUE|constraint/i,
    );

    s.inUow((r) => r.closeLink(link.id, "2026-11-03T00:00:00.000Z", "付け替え"));
    s.inUow((r) => {
      expect(r.getActiveLink(receipt.id)).toBeUndefined();
      expect(r.listActiveLinksByJournal(journalId)).toEqual([]);
    });
    expect(
      s.raw.all("SELECT unlinked_at, unlink_reason FROM receipt_links WHERE id = ?", link.id),
    ).toEqual([{ unlinked_at: "2026-11-03T00:00:00.000Z", unlink_reason: "付け替え" }]);

    // 閉じた後は新しい結びつきを足せる
    const next = makeLink(receipt.id, journalId);
    s.inUow((r) => r.insertLink(next));
    s.inUow((r) => {
      expect(r.getActiveLink(receipt.id)?.id).toBe(next.id);
    });
  });

  it("closeLink は 1 回だけ。ない・閉じ済みなら例外", () => {
    const { receipt } = s.add();
    const link = makeLink(receipt.id, s.raw.seedJournal());
    s.inUow((r) => r.insertLink(link));
    s.inUow((r) => r.closeLink(link.id, NOW, "理由"));
    expect(() => s.inUow((r) => r.closeLink(link.id, NOW, "理由"))).toThrow();
    expect(() => s.inUow((r) => r.closeLink(randomUUIDv7(), NOW, "理由"))).toThrow();
  });

  it("countActiveLinksByJournal は有効な結びつきのある仕訳だけを数える", () => {
    const j1 = s.raw.seedJournal();
    const j2 = s.raw.seedJournal();
    const j3 = s.raw.seedJournal();
    const a = s.add({ currentSha256: fakeSha(1) }).receipt;
    const b = s.add({ currentSha256: fakeSha(2) }).receipt;
    const c = s.add({ currentSha256: fakeSha(3) }).receipt;
    const closed = makeLink(c.id, j2);
    s.inUow((r) => {
      r.insertLink(makeLink(a.id, j1));
      r.insertLink(makeLink(b.id, j1));
      r.insertLink(closed);
    });
    s.inUow((r) => r.closeLink(closed.id, NOW, "解除"));
    s.inUow((r) => {
      expect(r.countActiveLinksByJournal([j1, j2, j3])).toEqual(new Map([[j1, 2]]));
      expect(r.countActiveLinksByJournal([])).toEqual(new Map());
      expect(r.countActiveLinksByJournal([j3])).toEqual(new Map());
    });
  });
});

describe("読み取りの記録", () => {
  it("insertReading → listReadings（読み取った順）。真偽・null が戻る", () => {
    const { receipt, file } = s.add();
    const first = makeReading(receipt.id, file.sha256, { model: "m1" });
    const failed = makeReading(receipt.id, file.sha256, {
      status: "failed",
      errorCode: "AI_HTTP_ERROR",
      candDate: null,
      candAmount: null,
      candPartner: null,
      candAccountCode: null,
      candTaxCategory: null,
      confidence: null,
    });
    s.inUow((r) => {
      r.insertReading(first);
      r.insertReading(failed);
    });
    s.inUow((r) => {
      expect(r.listReadings(receipt.id)).toEqual([first, failed]);
      expect(r.listReadings(randomUUIDv7())).toEqual([]);
    });
  });

  it("setReadingOutcome は NULL の列だけを書く。別の機会の書き込みは残りの列を書ける（L2）", () => {
    const { receipt, file } = s.add();
    const reading = makeReading(receipt.id, file.sha256);
    s.inUow((r) => r.insertReading(reading));

    // 値の保存の比べ
    s.inUow((r) =>
      r.setReadingOutcome(
        reading.id,
        { dateMatch: true, amountMatch: false, partnerMatch: true },
        "2026-11-03T01:00:00.000Z",
      ),
    );
    // 別の機会（仕訳の登録）の比べ。同じ列をもう一度渡しても、書き済みの列は変わらない
    s.inUow((r) =>
      r.setReadingOutcome(
        reading.id,
        { dateMatch: false, accountMatch: true, taxMatch: false },
        "2026-11-04T01:00:00.000Z",
      ),
    );
    s.inUow((r) => {
      expect(r.listReadings(receipt.id)[0]).toEqual({
        ...reading,
        comparedAt: "2026-11-03T01:00:00.000Z",
        dateMatch: true,
        amountMatch: false,
        partnerMatch: true,
        accountMatch: true,
        taxMatch: false,
      });
    });
  });

  it("書く列がなければ comparedAt も書かない。ない記録は例外", () => {
    const { receipt, file } = s.add();
    const reading = makeReading(receipt.id, file.sha256);
    s.inUow((r) => r.insertReading(reading));
    s.inUow((r) => r.setReadingOutcome(reading.id, {}, NOW));
    s.inUow((r) => {
      expect(r.listReadings(receipt.id)[0]?.comparedAt).toBeNull();
    });
    s.inUow((r) => r.setReadingOutcome(reading.id, { dateMatch: true }, NOW));
    // 全部書き済みの列だけを渡す 2 回目は何も変えない（トリガーにも触れない）
    s.inUow((r) => r.setReadingOutcome(reading.id, { dateMatch: false }, "2027-01-01"));
    s.inUow((r) => {
      expect(r.listReadings(receipt.id)[0]).toMatchObject({ comparedAt: NOW, dateMatch: true });
    });
    expect(() =>
      s.inUow((r) => r.setReadingOutcome(randomUUIDv7(), { dateMatch: true }, NOW)),
    ).toThrow(/not found/);
  });
});

describe("履歴（receipt_audit_log）", () => {
  const ctx = { ids: { next: () => randomUUIDv7() }, clock: { now: () => NOW } };

  it("receipt_id を target_id・receiptId から埋め、証憑ごとに古い順で引ける", () => {
    const a = s.add({ currentSha256: fakeSha(1) });
    const b = s.add({ currentSha256: fakeSha(2) });
    const journalId = s.raw.seedJournal();
    const link = makeLink(a.receipt.id, journalId);
    const reading = makeReading(a.receipt.id, a.file.sha256);
    const entries: ReceiptAuditEntry[] = [
      auditEntry(ctx, {
        targetType: "receipt",
        targetId: a.receipt.id,
        action: "create",
        after: { category: "paper_scan" },
      }),
      auditEntry(ctx, {
        targetType: "receipt",
        targetId: b.receipt.id,
        action: "create",
        after: { category: "electronic" },
      }),
      auditEntry(ctx, {
        targetType: "receipt_link",
        targetId: link.id,
        action: "link",
        after: { receiptId: a.receipt.id, journalId },
      }),
      auditEntry(ctx, {
        targetType: "receipt_reading",
        targetId: reading.id,
        action: "read",
        after: {
          receiptId: a.receipt.id,
          fileSha256: a.file.sha256,
          model: "m",
          status: "succeeded",
        },
      }),
      auditEntry(ctx, {
        targetType: "receipt_link",
        targetId: link.id,
        action: "unlink",
        reason: "解除",
        before: { receiptId: a.receipt.id, journalId },
        after: { unlinkedAt: NOW },
      }),
    ];
    s.inUow((r) => {
      for (const e of entries) r.appendAudit(e);
    });
    s.inUow((r) => {
      expect(r.listAudit(a.receipt.id)).toEqual([entries[0], entries[2], entries[3], entries[4]]);
      expect(r.listAudit(b.receipt.id)).toEqual([entries[1]]);
      expect(r.listAudit(randomUUIDv7())).toEqual([]);
    });
    expect(
      s.raw.all("SELECT receipt_id FROM receipt_audit_log WHERE target_type = 'receipt_link'"),
    ).toEqual([{ receipt_id: a.receipt.id }, { receipt_id: a.receipt.id }]);
  });

  it("証憑の ID を決められない記録・ない証憑の記録は例外。追記のみ", () => {
    const { receipt } = s.add();
    const noId = auditEntry(ctx, {
      targetType: "receipt_link",
      targetId: randomUUIDv7(),
      action: "link",
      after: { journalId: "j" },
    });
    expect(() => s.inUow((r) => r.appendAudit(noId))).toThrow();
    const ghost = auditEntry(ctx, {
      targetType: "receipt",
      targetId: randomUUIDv7(),
      action: "create",
    });
    expect(() => s.inUow((r) => r.appendAudit(ghost))).toThrow();

    const entry = auditEntry(ctx, {
      targetType: "receipt",
      targetId: receipt.id,
      action: "create",
    });
    s.inUow((r) => r.appendAudit(entry));
    expect(() => s.raw.run("UPDATE receipt_audit_log SET reason = 'x'")).toThrow(/append-only/);
  });
});

describe("search", () => {
  /** 受領日時を 1 分ずつずらして追加する（新しい順の並びを確かめる） */
  function seed(n: number, over: (i: number) => Parameters<typeof s.add>[0] = () => ({})) {
    return Array.from({ length: n }, (_, i) =>
      s.add({
        receivedAt: `2026-10-01T00:${String(i).padStart(2, "0")}:00.000Z`,
        currentSha256: fakeSha(100 + i),
        ...over(i),
      }),
    ).map((x) => x.receipt);
  }
  const idsOf = (rows: { receipt: { id: string } }[]) => rows.map((r) => r.receipt.id);

  it("received_at DESC, id DESC。今の版のファイルを添える", () => {
    const rs = seed(3);
    const page = s.inUow((r) => r.search(query()));
    expect(idsOf(page.rows)).toEqual([rs[2]?.id, rs[1]?.id, rs[0]?.id]);
    expect(page.nextCursor).toBeNull();
    expect(page.rows[0]?.currentFile.sha256).toBe(rs[2]?.currentSha256);
    expect(page.rows[0]?.link).toBeUndefined();
    expect(page.rows[0]?.journal).toBeUndefined();
  });

  it("同じ受領日時なら id の降順", () => {
    const rs = seed(3, () => ({ receivedAt: NOW }));
    const page = s.inUow((r) => r.search(query()));
    expect(idsOf(page.rows)).toEqual(
      rs
        .map((x) => x.id)
        .sort()
        .reverse(),
    );
  });

  it("カーソルと limit で続きを引ける（重複・抜けなし）", () => {
    const rs = seed(5);
    const expected = rs.map((x) => x.id).reverse();
    const first = s.inUow((r) => r.search(query({ limit: 2 })));
    expect(idsOf(first.rows)).toEqual(expected.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = s.inUow((r) =>
      r.search(query({ limit: 2, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) })),
    );
    expect(idsOf(second.rows)).toEqual(expected.slice(2, 4));
    const third = s.inUow((r) =>
      r.search(query({ limit: 2, ...(second.nextCursor ? { cursor: second.nextCursor } : {}) })),
    );
    expect(idsOf(third.rows)).toEqual(expected.slice(4));
    expect(third.nextCursor).toBeNull();
    // ちょうど limit 件なら次はない
    const exact = s.inUow((r) => r.search(query({ limit: 5 })));
    expect(exact.nextCursor).toBeNull();
    // 壊れたカーソルは空
    expect(s.inUow((r) => r.search(query({ cursor: "broken" }))).rows).toEqual([]);
  });

  it("日付・金額の範囲は両端を含み、未入力の行は外れる", () => {
    seed(4, (i) => ({
      transactionDate: i === 3 ? null : `2026-10-0${i + 1}`,
      amount: i === 3 ? null : (i + 1) * 100,
    }));
    const dates = (q: ReceiptQueryInput) =>
      s
        .inUow((r) => r.search(query(q)))
        .rows.map((x) => x.receipt.transactionDate)
        .reverse();
    expect(dates({ dateFrom: "2026-10-02", dateTo: "2026-10-03" })).toEqual([
      "2026-10-02",
      "2026-10-03",
    ]);
    expect(dates({ dateFrom: "2026-10-03" })).toEqual(["2026-10-03"]);
    const amounts = (q: ReceiptQueryInput) =>
      s
        .inUow((r) => r.search(query(q)))
        .rows.map((x) => x.receipt.amount)
        .reverse();
    expect(amounts({ amountMin: 200, amountMax: 300 })).toEqual([200, 300]);
    expect(amounts({ amountMax: 100 })).toEqual([100]);
  });

  it("取引先は正規化（全角半角・大文字小文字・空白）して部分一致。% _ \\ は文字として扱う", () => {
    seed(4, (i) => ({
      partnerName: ["ＡＢＣ　カフェ", "100%果汁", "a_b", "x\\y"][i] as string,
    }));
    const names = (partner: string) =>
      s
        .inUow((r) => r.search(query({ partner })))
        .rows.map((x) => x.receipt.partnerName)
        .reverse();
    expect(names("abc ｶﾌｪ")).toEqual(["ＡＢＣ　カフェ"]);
    expect(names("0%")).toEqual(["100%果汁"]);
    expect(names("%")).toEqual(["100%果汁"]);
    expect(names("_")).toEqual(["a_b"]);
    expect(names("a_b")).toEqual(["a_b"]);
    expect(names("\\")).toEqual(["x\\y"]);
    expect(names("zzz")).toEqual([]);
  });

  it("区分・未入力・削除済みの扱い", () => {
    seed(4, (i) => ({
      category: i % 2 === 0 ? "paper_scan" : "electronic",
      transactionDate: i === 0 ? null : "2026-10-10",
      amount: 100,
      partnerName: "店",
      ...(i === 3 ? { deletedAt: NOW, deletedReason: "誤り" } : {}),
    }));
    const cats = (q: ReceiptQueryInput) =>
      s.inUow((r) => r.search(query(q))).rows.map((x) => x.receipt.category);
    expect(cats({})).toHaveLength(3);
    expect(cats({ includeDeleted: true })).toHaveLength(4);
    expect(cats({ category: "electronic" })).toEqual(["electronic"]);
    expect(cats({ category: "electronic", includeDeleted: true })).toEqual([
      "electronic",
      "electronic",
    ]);
    expect(cats({ missing: true })).toEqual(["paper_scan"]);
  });

  it("結びつきと仕訳の状態（none / linked / journal_voided）を JOIN で引く", () => {
    const [none, linked, voided] = seed(3);
    const active = s.raw.seedJournal();
    const cancelled = s.raw.seedJournal();
    const unlinked = s.raw.seedJournal();
    s.inUow((r) => {
      r.insertLink(makeLink(linked?.id as string, active));
      r.insertLink(makeLink(voided?.id as string, cancelled));
    });
    s.raw.run("UPDATE journals SET status = 'voided' WHERE id = ?", cancelled);
    // 閉じた結びつきは無いのと同じ（none）
    const closed = makeLink(none?.id as string, unlinked);
    s.inUow((r) => r.insertLink(closed));
    s.inUow((r) => r.closeLink(closed.id, NOW, "解除"));

    const idsFor = (link?: "none" | "linked" | "journal_voided") =>
      idsOf(s.inUow((r) => r.search(query(link === undefined ? {} : { link }))).rows);
    expect(idsFor("none")).toEqual([none?.id]);
    expect(idsFor("linked")).toEqual([linked?.id]);
    expect(idsFor("journal_voided")).toEqual([voided?.id]);

    const all = s.inUow((r) => r.search(query())).rows;
    const byId = new Map(all.map((x) => [x.receipt.id, x]));
    expect(byId.get(none?.id as string)?.link).toBeUndefined();
    expect(byId.get(linked?.id as string)?.journal).toMatchObject({ id: active, status: "active" });
    expect(byId.get(voided?.id as string)?.journal).toMatchObject({
      id: cancelled,
      status: "voided",
    });
    expect(byId.get(linked?.id as string)?.link?.journalId).toBe(active);
  });
});
