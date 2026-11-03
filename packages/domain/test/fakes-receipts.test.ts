import { RECEIPT_MAX_PIXELS } from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import { type ReceiptStore, RepositoryConflictError } from "../src/ports.ts";
import { domainError, err, ok } from "../src/types.ts";
import {
  FakeImageTool,
  FakeReceiptFileStore,
  FakeReceiptReader,
  FakeReceiptStore,
  fakeReceiptUnitOfWork,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
} from "./fakes.ts";
import { jpegBytes, pdfBytes, pngBytes } from "./fixtures/receipts/sample-files.ts";
import { FaultInjectingReceiptUnitOfWork, receiptSnapshotOf } from "./receipt-fault-injection.ts";
import {
  fakeSha,
  makeReceiptFileRow,
  makeReceiptLinkRow,
  makeReceiptQuery,
  makeReceiptRow,
} from "./receipt-setup.ts";
import { NOW } from "./test-dates.ts";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("FakeReceiptFileStore", () => {
  it("digest は SHA-256 の 16 進（既知のベクトル）", () => {
    const files = new FakeReceiptFileStore();
    expect(files.digest(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(files.digest(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // 56 バイト（パディングがブロックをまたぐ境目）
    expect(files.digest(new TextEncoder().encode("a".repeat(56)))).toBe(
      "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
    );
  });

  it("put → has → read で同じ内容が戻り、同じ名前の put は何もしない", () => {
    const files = new FakeReceiptFileStore();
    const bytes = jpegBytes({ seed: 1 });
    const sha = files.digest(bytes);
    expect(files.has(sha)).toBe(false);
    files.put(sha, bytes);
    files.put(sha, bytes);
    expect(files.has(sha)).toBe(true);
    expect(hex(files.read(sha))).toBe(hex(bytes));
    expect(files.puts).toEqual([sha]);
  });

  it("read は読んだ内容の SHA-256 が名前と違う（改ざん）か、ファイルがなければ失敗する", () => {
    const files = new FakeReceiptFileStore();
    const bytes = pngBytes({ seed: 2 });
    const sha = files.digest(bytes);
    expect(() => files.read(sha)).toThrow();
    files.put(sha, bytes);
    files.tamper(sha);
    expect(() => files.read(sha)).toThrow();
  });

  it("discard で消え、消した記録が残る。failOnPut なら put は何も残さず失敗する", () => {
    const files = new FakeReceiptFileStore();
    const bytes = jpegBytes({ seed: 3 });
    const sha = files.digest(bytes);
    files.put(sha, bytes);
    files.discard(sha);
    expect(files.has(sha)).toBe(false);
    expect(files.discarded).toEqual([sha]);
    files.failOnPut = true;
    expect(() => files.put(sha, bytes)).toThrow();
    expect(files.has(sha)).toBe(false);
  });
});

describe("FakeReceiptStore", () => {
  it("証憑を入れて取り出せ、同じ ID は入らない", () => {
    const store = new FakeReceiptStore();
    store.insertReceipt(makeReceiptRow());
    expect(store.getReceipt("receipt-1")).toEqual(makeReceiptRow());
    expect(store.getReceipt("none")).toBeUndefined();
    expect(() => store.insertReceipt(makeReceiptRow())).toThrow();
  });

  it("updateReceipt は版が違えば RepositoryConflictError、受領日時・経路の変更と削除の取り消しは拒む", () => {
    const store = new FakeReceiptStore();
    store.insertReceipt(makeReceiptRow());
    expect(() => store.updateReceipt(makeReceiptRow({ version: 2 }), 5)).toThrow(
      RepositoryConflictError,
    );
    expect(() =>
      store.updateReceipt(
        makeReceiptRow({ version: 2, receivedAt: "2026-01-01T00:00:00.000Z" }),
        1,
      ),
    ).toThrow();
    expect(() =>
      store.updateReceipt(makeReceiptRow({ version: 2, channel: "remote" }), 1),
    ).toThrow();
    store.updateReceipt(makeReceiptRow({ version: 2, amount: 2000 }), 1);
    expect(store.getReceipt("receipt-1")?.amount).toBe(2000);
    expect(store.getReceipt("receipt-1")?.version).toBe(2);
    store.updateReceipt(makeReceiptRow({ version: 3, deletedAt: NOW, deletedReason: "重複" }), 2);
    expect(() => store.updateReceipt(makeReceiptRow({ version: 4 }), 3)).toThrow();
  });

  it("ファイルの版は 1 から連番で、sha256 は事業体の中で一意", () => {
    const store = new FakeReceiptStore();
    store.insertReceipt(makeReceiptRow());
    expect(() => store.insertFile(makeReceiptFileRow({ fileVersion: 2 }))).toThrow();
    store.insertFile(makeReceiptFileRow({ sha256: fakeSha(1), fileVersion: 1 }));
    store.insertFile(makeReceiptFileRow({ sha256: fakeSha(2), fileVersion: 2 }));
    expect(() =>
      store.insertFile(makeReceiptFileRow({ sha256: fakeSha(2), fileVersion: 3 })),
    ).toThrow();
    expect(() =>
      store.insertFile(makeReceiptFileRow({ sha256: fakeSha(3), fileVersion: 2 })),
    ).toThrow();
    expect(store.listFiles("receipt-1").map((f) => f.fileVersion)).toEqual([1, 2]);
    expect(store.findFileBySha(fakeSha(2))?.fileVersion).toBe(2);
    expect(store.findFileBySha(fakeSha(9))).toBeUndefined();
    // 別の証憑の版は別に数える
    store.insertFile(makeReceiptFileRow({ sha256: fakeSha(4), receiptId: "receipt-2" }));
  });

  it("有効な結びつきは証憑ごとに 1 件。閉じれば次が入り、閉じ済みは閉じられない", () => {
    const store = new FakeReceiptStore();
    store.insertLink(makeReceiptLinkRow({ id: "l1", journalId: "j1" }));
    expect(() => store.insertLink(makeReceiptLinkRow({ id: "l2", journalId: "j2" }))).toThrow();
    expect(store.getActiveLink("receipt-1")?.id).toBe("l1");
    store.closeLink("l1", NOW, "付け替え");
    expect(store.getActiveLink("receipt-1")).toBeUndefined();
    expect(() => store.closeLink("l1", NOW, "もう一度")).toThrow();
    expect(() => store.closeLink("none", NOW, "x")).toThrow();
    store.insertLink(makeReceiptLinkRow({ id: "l2", journalId: "j2" }));
    expect(store.getActiveLink("receipt-1")?.journalId).toBe("j2");
  });

  it("仕訳ごとの有効な結びつきと、その件数（0 件の仕訳は載せない）", () => {
    const store = new FakeReceiptStore();
    store.insertLink(makeReceiptLinkRow({ id: "l1", receiptId: "a", journalId: "j1" }));
    store.insertLink(makeReceiptLinkRow({ id: "l2", receiptId: "b", journalId: "j1" }));
    store.insertLink(makeReceiptLinkRow({ id: "l3", receiptId: "c", journalId: "j2" }));
    store.closeLink("l3", NOW, "x");
    expect(store.listActiveLinksByJournal("j1").map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(store.countActiveLinksByJournal(["j1", "j2", "j3"])).toEqual(new Map([["j1", 2]]));
  });

  it("読み取りの記録の比べは、NULL の列だけに書く（列ごとに 1 回）", () => {
    const store = new FakeReceiptStore();
    store.insertReading(readingRow());
    store.setReadingOutcome("rd1", { dateMatch: true }, "2026-10-31T01:00:00.000Z");
    store.setReadingOutcome(
      "rd1",
      { dateMatch: false, accountMatch: true },
      "2026-10-31T02:00:00.000Z",
    );
    const [row] = store.listReadings("receipt-1");
    expect(row?.dateMatch).toBe(true);
    expect(row?.accountMatch).toBe(true);
    expect(row?.amountMatch).toBeNull();
    expect(row?.comparedAt).toBe("2026-10-31T01:00:00.000Z");
  });

  it("履歴は証憑ごとに古い順で引ける（結びつき・読み取りの記録も、値の中の receiptId で）", () => {
    const store = new FakeReceiptStore();
    const entry = (id: string, over: object) => ({
      id,
      occurredAt: NOW,
      targetType: "receipt" as const,
      targetId: "receipt-1",
      action: "create" as const,
      reason: null,
      beforeJson: null,
      afterJson: null,
      ...over,
    });
    store.appendAudit(entry("a1", {}));
    store.appendAudit(entry("a2", { targetId: "receipt-2" }));
    store.appendAudit(
      entry("a3", {
        targetType: "receipt_link",
        targetId: "link-9",
        action: "link",
        afterJson: JSON.stringify({ receiptId: "receipt-1", journalId: "j1" }),
      }),
    );
    store.appendAudit(
      entry("a4", {
        targetType: "receipt_link",
        targetId: "link-9",
        action: "unlink",
        beforeJson: JSON.stringify({ receiptId: "receipt-1", journalId: "j1" }),
        afterJson: JSON.stringify({ unlinkedAt: NOW }),
      }),
    );
    expect(store.listAudit("receipt-1").map((e) => e.id)).toEqual(["a1", "a3", "a4"]);
    expect(store.listAudit("receipt-2").map((e) => e.id)).toEqual(["a2"]);
  });
});

describe("FakeReceiptStore.search", () => {
  const setup = () => {
    const ledger = new InMemoryLedgerRepository();
    const uow = fakeReceiptUnitOfWork(ledger, new InMemoryMasterRepository());
    const store = uow.receipts;
    const at = (n: number) => `2026-10-${String(10 + n).padStart(2, "0")}T00:00:00.000Z`;
    for (let i = 1; i <= 5; i += 1) {
      store.insertReceipt(
        makeReceiptRow({
          id: `r${i}`,
          receivedAt: i === 5 ? at(4) : at(i),
          currentSha256: fakeSha(i),
          partnerName: i % 2 === 0 ? "Ｃａｆｅ" : "文具店",
          amount: i * 1000,
        }),
      );
      store.insertFile(makeReceiptFileRow({ sha256: fakeSha(i), receiptId: `r${i}` }));
    }
    return { ledger, uow, store };
  };

  it("受領日時の新しい順（同じなら ID の降順）で、条件に合うものだけ返す", () => {
    const { store } = setup();
    const all = store.search(makeReceiptQuery());
    expect(all.rows.map((r) => r.receipt.id)).toEqual(["r5", "r4", "r3", "r2", "r1"]);
    expect(all.nextCursor).toBeNull();
    const cafe = store.search(makeReceiptQuery({ partner: "ｃａｆｅ" }));
    expect(cafe.rows.map((r) => r.receipt.id)).toEqual(["r4", "r2"]);
    expect(cafe.rows[0]?.currentFile.sha256).toBe(fakeSha(4));
  });

  it("カーソルで続きを取り、重複も抜けもない", () => {
    const { store } = setup();
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = store.search(
        makeReceiptQuery({ limit: 2, ...(cursor === undefined ? {} : { cursor }) }),
      );
      ids.push(...result.rows.map((r) => r.receipt.id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(ids).toEqual(["r5", "r4", "r3", "r2", "r1"]);
  });

  it("結びつきと仕訳の状態（取消）を含み、link で絞れる", () => {
    const { ledger, store } = setup();
    ledger.state.journals.push(journalOf("j1", "active"), journalOf("j2", "voided"));
    store.insertLink(makeReceiptLinkRow({ id: "l1", receiptId: "r1", journalId: "j1" }));
    store.insertLink(makeReceiptLinkRow({ id: "l2", receiptId: "r2", journalId: "j2" }));
    const linked = store.search(makeReceiptQuery({ link: "linked" }));
    expect(linked.rows.map((r) => r.receipt.id)).toEqual(["r1"]);
    expect(linked.rows[0]?.journal?.id).toBe("j1");
    const voided = store.search(makeReceiptQuery({ link: "journal_voided" }));
    expect(voided.rows.map((r) => r.receipt.id)).toEqual(["r2"]);
    expect(store.search(makeReceiptQuery({ link: "none" })).rows).toHaveLength(3);
  });
});

describe("fakeReceiptUnitOfWork と FaultInjectingReceiptUnitOfWork", () => {
  const write = (tx: { receipts: ReceiptStore }) => {
    tx.receipts.insertReceipt(makeReceiptRow());
    tx.receipts.insertFile(makeReceiptFileRow());
    tx.receipts.appendAudit({
      id: "a1",
      occurredAt: NOW,
      targetType: "receipt",
      targetId: "receipt-1",
      action: "create",
      reason: null,
      beforeJson: null,
      afterJson: "{}",
    });
  };

  it("uow.ledger で帳簿を参照できる", () => {
    const ledger = new InMemoryLedgerRepository();
    const uow = fakeReceiptUnitOfWork(ledger, new InMemoryMasterRepository());
    expect(uow.ledger).toBe(ledger);
  });

  it("err を返すと証憑の書き込みがすべて巻き戻る", () => {
    const uow = fakeReceiptUnitOfWork();
    const result = uow.run((tx) => {
      write(tx);
      return err(domainError("VALIDATION", "x"));
    });
    expect(result.ok).toBe(false);
    expect(uow.receipts.state.receipts).toEqual([]);
    expect(uow.receipts.state.files).toEqual([]);
    expect(uow.receipts.state.audits).toEqual([]);
  });

  it("failAt 回目の書き込みで例外になり、帳簿・マスタ・証憑がすべて元に戻る", () => {
    for (const failAt of [1, 2, 3]) {
      const uow = fakeReceiptUnitOfWork();
      const before = receiptSnapshotOf(uow);
      const faulty = new FaultInjectingReceiptUnitOfWork(uow);
      faulty.failAt = failAt;
      expect(() =>
        faulty.run((tx) => {
          write(tx);
          return ok(undefined);
        }),
      ).toThrow(/injected failure/);
      expect(faulty.writes).toBe(failAt);
      expect(receiptSnapshotOf(uow)).toEqual(before);
    }
  });

  it("failAt が null なら成功し、書き込みの回数を数える（close・set も書き込み）", () => {
    const uow = fakeReceiptUnitOfWork();
    const faulty = new FaultInjectingReceiptUnitOfWork(uow);
    const result = faulty.run((tx) => {
      write(tx);
      tx.receipts.insertLink(makeReceiptLinkRow());
      tx.receipts.closeLink("link-1", NOW, "x");
      tx.receipts.insertReading(readingRow());
      tx.receipts.setReadingOutcome("rd1", { dateMatch: true }, NOW);
      // 読み取りは数えない
      tx.receipts.getReceipt("receipt-1");
      tx.receipts.search(makeReceiptQuery());
      return ok(undefined);
    });
    expect(result.ok).toBe(true);
    expect(faulty.writes).toBe(7);
    expect(uow.receipts.state.receipts).toHaveLength(1);
  });
});

describe("FakeImageTool", () => {
  it("JPEG・PNG は寸法を返し、PDF は調べられない（ok(undefined)）", async () => {
    const tool = new FakeImageTool();
    const jpeg = await tool.probe(jpegBytes({ width: 300, height: 200 }), "image/jpeg");
    expect(jpeg).toEqual(ok({ width: 300, height: 200, fullColor: true }));
    const png = await tool.probe(pngBytes({ width: 10, height: 20 }), "image/png");
    expect(png).toEqual(ok({ width: 10, height: 20, fullColor: true }));
    expect(await tool.probe(pdfBytes(), "application/pdf")).toEqual(ok(undefined));
    expect(tool.calls.map((c) => c.method)).toEqual(["probe", "probe", "probe"]);
  });

  it("画素数が上限を超えれば VALIDATION（details.maxPixels）", async () => {
    const tool = new FakeImageTool();
    const result = await tool.probe(jpegBytes({ width: 20000, height: 20000 }), "image/jpeg");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.details).toEqual({ maxPixels: RECEIPT_MAX_PIXELS });
    }
  });

  it("respondProbe で結果を差し替えられる。表示用・AI 用は JPEG を返す", async () => {
    const tool = new FakeImageTool();
    tool.respondProbe(ok({ width: 100, height: 100, fullColor: false }));
    expect(await tool.probe(pdfBytes(), "application/pdf")).toEqual(
      ok({ width: 100, height: 100, fullColor: false }),
    );
    const display = await tool.toDisplay(pngBytes(), "image/png");
    expect(display.ok && display.value.mediaType).toBe("image/png");
    const ai = await tool.toAiJpeg(pdfBytes(), "application/pdf", 2048);
    expect(ai.ok && ai.value[0]).toBe(0xff);
    tool.respondAiJpeg(err(domainError("RECEIPT_READ_UNSUPPORTED", "描けない")));
    const failed = await tool.toAiJpeg(pdfBytes(), "application/pdf", 2048);
    expect(failed.ok).toBe(false);
  });
});

describe("FakeReceiptReader", () => {
  const request = {
    system: "s",
    choices: "c",
    image: { mediaType: "image/jpeg" as const, bytes: jpegBytes() },
    schema: {},
  };

  it("既定は読めない。respondWith の応答を返し、渡された要求を記録する", async () => {
    const reader = new FakeReceiptReader();
    expect((await reader.read(request)).ok).toBe(false);
    reader.respondWith(ok('{"amount":1}'));
    expect(await reader.read(request)).toEqual(ok('{"amount":1}'));
    expect(reader.calls).toHaveLength(2);
    expect(reader.calls[0]?.system).toBe("s");
  });

  it("モデル名を返す（undefined にもできる）。throwOnCall なら例外", async () => {
    const reader = new FakeReceiptReader({ model: "m1" });
    expect(await reader.model()).toBe("m1");
    reader.setModel(undefined);
    expect(await reader.model()).toBeUndefined();
    reader.throwOnCall = true;
    await expect(reader.read(request)).rejects.toThrow();
  });
});

function readingRow() {
  return {
    id: "rd1",
    receiptId: "receipt-1",
    fileSha256: fakeSha(1),
    readAt: NOW,
    model: "m",
    status: "succeeded" as const,
    errorCode: null,
    candDate: "2026-10-20",
    candAmount: 1100,
    candPartner: "カフェ",
    candAccountCode: null,
    candTaxCategory: null,
    confidence: 80,
    comparedAt: null,
    dateMatch: null,
    amountMatch: null,
    partnerMatch: null,
    accountMatch: null,
    taxMatch: null,
  };
}

function journalOf(id: string, status: "active" | "voided") {
  return {
    id,
    journalNo: id === "j1" ? 1 : 2,
    date: "2026-10-20",
    fiscalPeriodId: "p",
    memo: null,
    correctsJournalId: null,
    source: "manual" as const,
    status,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [],
  };
}
