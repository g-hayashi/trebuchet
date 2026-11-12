import {
  RECEIPT_MAX_BYTES,
  type ReceiptCreateOptions,
  ReceiptDetail,
  type ReceiptQueryInput,
} from "@trebuchet/schema";
import { describe, expect, it } from "vitest";
import type { ReceiptProbe } from "../../src/ports.ts";
import type { ReceiptReadingRow } from "../../src/types.ts";
import {
  addReceipt,
  getReceipt,
  listReceipts,
  type ReceiptDeps,
  readReceiptFile,
} from "../../src/usecases/receipts.ts";
import { FakeReceiptFileStore } from "../fakes.ts";
import {
  heicBytes,
  jpegBytes,
  mislabeledSamples,
  pdfBytes,
  pngBytes,
} from "../fixtures/receipts/sample-files.ts";
import { FaultInjectingReceiptUnitOfWork, receiptSnapshotOf } from "../receipt-fault-injection.ts";
import {
  addBareJournal,
  fakeSha,
  makeReceiptFileRow,
  makeReceiptLinkRow,
  makeReceiptQuery,
  setupReceipts,
} from "../receipt-setup.ts";
import { must } from "../result.ts";

// T012: addReceipt・listReceipts・getReceipt・readReceiptFile（contracts/domain-module.md §3、R10、FR-001〜005・007）

const PROBE: ReceiptProbe = { width: 4032, height: 3024, fullColor: true };
const FULL: ReceiptCreateOptions = {
  category: "electronic",
  transactionDate: "2026-10-20",
  amount: 1100,
  partnerName: "合成の店",
  memo: "会議",
};

type AddInput = Partial<Omit<Parameters<typeof addReceipt>[1], "options">> & {
  options?: Partial<ReceiptCreateOptions> & { category?: ReceiptCreateOptions["category"] };
};

function add(deps: ReceiptDeps, input: AddInput = {}) {
  const { options, ...rest } = input;
  return addReceipt(deps, {
    bytes: jpegBytes(),
    originalName: "receipt.jpg",
    channel: "local",
    probe: PROBE,
    ...rest,
    options: { ...FULL, ...options },
  });
}

describe("addReceipt: 成功", () => {
  it("暗号化前のバイト列を put し、証憑・版 1・履歴 create を作って ReceiptDetail を返す", () => {
    const { deps, files, uow } = setupReceipts();
    const bytes = jpegBytes({ seed: 3 });
    const detail = must(add(deps, { bytes, originalName: "領収書.jpg", channel: "remote" }));

    const sha = files.digest(bytes);
    expect(ReceiptDetail.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({
      receivedAt: "2026-10-31T09:00:00.000Z",
      channel: "remote",
      category: "electronic",
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
      memo: "会議",
      mediaType: "image/jpeg",
      deleted: false,
      linkState: "none",
      journal: null,
      warnings: [],
      version: 1,
      deletedAt: null,
      deletedReason: null,
      readings: [],
    });
    expect(detail.currentFile).toEqual({
      sha256: sha,
      fileVersion: 1,
      mediaType: "image/jpeg",
      sizeBytes: bytes.length,
      originalName: "領収書.jpg",
      width: 4032,
      height: 3024,
      fullColor: true,
      addedAt: "2026-10-31T09:00:00.000Z",
      channel: "remote",
    });
    expect(detail.files).toEqual([detail.currentFile]);

    expect(files.puts).toEqual([sha]);
    expect(files.read(sha)).toEqual(bytes);
    const { receipts, files: fileRows, audits } = uow.receipts.state;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id: detail.id, currentSha256: sha, version: 1 });
    expect(fileRows.map((f) => f.sha256)).toEqual([sha]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      targetType: "receipt",
      targetId: detail.id,
      action: "create",
      reason: null,
      beforeJson: null,
      occurredAt: detail.receivedAt,
    });
    expect(JSON.parse(audits[0]?.afterJson ?? "null")).toMatchObject({
      category: "electronic",
      transactionDate: "2026-10-20",
      amount: 1100,
      partnerName: "合成の店",
      memo: "会議",
      sha256: sha,
      deletedAt: null,
    });
  });

  it("4 形式を受け付ける（中身で判定し、拡張子は見ない）", () => {
    const { deps } = setupReceipts();
    const samples: [Uint8Array, string][] = [
      [jpegBytes({ seed: 1 }), "image/jpeg"],
      [pngBytes({ seed: 1 }), "image/png"],
      [pdfBytes({ seed: 1 }), "application/pdf"],
      [heicBytes({ major: "heic", compatible: ["mif1"] }), "image/heic"],
    ];
    for (const [bytes, mediaType] of samples) {
      const detail = must(add(deps, { bytes, originalName: "x.dat", probe: null }));
      expect(detail.mediaType).toBe(mediaType);
    }
  });

  it("probe がなければ寸法・色は null（PDF など）", () => {
    const { deps } = setupReceipts();
    const detail = must(add(deps, { bytes: pdfBytes(), probe: null }));
    expect(detail.currentFile).toMatchObject({ width: null, height: null, fullColor: null });
  });

  it("値は省ける（null）。未入力の警告が付き、取引先は前後の空白を除いて正規化した key を持つ", () => {
    const { deps, uow } = setupReceipts();
    const empty = must(
      add(deps, {
        options: { transactionDate: null, amount: null, partnerName: null, memo: null },
      }),
    );
    expect(empty.warnings).toEqual([{ code: "FIELDS_MISSING" }]);
    expect(empty).toMatchObject({ transactionDate: null, amount: null, partnerName: null });

    const named = must(
      add(deps, { bytes: jpegBytes({ seed: 9 }), options: { partnerName: "  ＡＢＣ 商店 " } }),
    );
    expect(named.partnerName).toBe("ＡＢＣ 商店");
    expect(uow.receipts.state.receipts.find((r) => r.id === named.id)?.partnerKey).toBe("ABC商店");
  });

  it("ちょうど上限（20 MB）の大きさは受け付ける", () => {
    const { deps } = setupReceipts();
    const bytes = new Uint8Array(RECEIPT_MAX_BYTES);
    bytes.set(jpegBytes(), 0);
    expect(add(deps, { bytes, probe: null }).ok).toBe(true);
  });
});

describe("addReceipt: 拒否（何も書かない）", () => {
  const nothingWritten = (setup: ReturnType<typeof setupReceipts>) => {
    expect(setup.files.puts).toEqual([]);
    expect(setup.uow.receipts.state).toEqual({
      receipts: [],
      files: [],
      links: [],
      readings: [],
      audits: [],
    });
  };

  it("対応しない形式は 422 RECEIPT_FORMAT_UNSUPPORTED（拡張子が jpg でも中身で判定）", () => {
    for (const sample of mislabeledSamples().filter((s) => s.actual === "text")) {
      const setup = setupReceipts();
      const result = add(setup.deps, { bytes: sample.bytes, originalName: sample.originalName });
      expect(result).toMatchObject({ ok: false, error: { code: "RECEIPT_FORMAT_UNSUPPORTED" } });
      nothingWritten(setup);
    }
    const setup = setupReceipts();
    expect(add(setup.deps, { bytes: new Uint8Array(0) })).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_FORMAT_UNSUPPORTED" },
    });
    nothingWritten(setup);
  });

  it("20 MB + 1 バイトは 413 FILE_TOO_LARGE（形式の判定より先でも後でもよいが、何も書かない）", () => {
    const setup = setupReceipts();
    const bytes = new Uint8Array(RECEIPT_MAX_BYTES + 1);
    bytes.set(jpegBytes(), 0);
    expect(add(setup.deps, { bytes })).toMatchObject({
      ok: false,
      error: { code: "FILE_TOO_LARGE", details: { maxBytes: RECEIPT_MAX_BYTES } },
    });
    nothingWritten(setup);
  });

  it("値の検査（日付・金額・取引先・メモ）は 422 VALIDATION", () => {
    const bad: Partial<ReceiptCreateOptions>[] = [
      { transactionDate: "2026-02-30" },
      { amount: 0 },
      { amount: 1_000_000_000_000 },
      { amount: 12.5 },
      { partnerName: "   " },
      { partnerName: "あ".repeat(101) },
      { memo: "あ".repeat(501) },
    ];
    for (const options of bad) {
      const setup = setupReceipts();
      expect(add(setup.deps, { options }), JSON.stringify(options)).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" },
      });
      nothingWritten(setup);
    }
  });
});

describe("addReceipt: 重複（FR-004）", () => {
  it("同じ内容は 409 RECEIPT_DUPLICATE（details.receiptId・deleted）。新しい行もファイルも作らない", () => {
    const { deps, files, uow } = setupReceipts();
    const bytes = jpegBytes({ seed: 5 });
    const first = must(add(deps, { bytes }));
    const before = structuredClone(uow.receipts.state);

    const second = add(deps, { bytes, originalName: "other.jpg", channel: "remote" });
    expect(second).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_DUPLICATE", details: { receiptId: first.id, deleted: false } },
    });
    expect(uow.receipts.state).toEqual(before);
    expect(files.puts).toHaveLength(1);
    expect(files.discarded).toEqual([]);
  });

  it("削除済みの証憑も重複として扱う（deleted: true）", () => {
    const { deps, uow } = setupReceipts();
    const bytes = jpegBytes({ seed: 6 });
    const first = must(add(deps, { bytes }));
    const row = uow.receipts.state.receipts[0];
    if (row === undefined) throw new Error("no row");
    row.deletedAt = "2026-10-31T10:00:00.000Z";
    row.deletedReason = "重複";
    expect(add(deps, { bytes })).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_DUPLICATE", details: { receiptId: first.id, deleted: true } },
    });
  });

  it("差し替え前の版と同じ内容も重複（その証憑の ID を返す）", () => {
    const { deps, uow, files } = setupReceipts();
    const first = must(add(deps, { bytes: jpegBytes({ seed: 7 }) }));
    const old = jpegBytes({ seed: 8 });
    const oldSha = files.digest(old);
    uow.receipts.insertFile(
      makeReceiptFileRow({ sha256: oldSha, receiptId: first.id, fileVersion: 2 }),
    );
    expect(add(deps, { bytes: old })).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_DUPLICATE", details: { receiptId: first.id } },
    });
  });
});

describe("addReceipt: 失敗の後始末（INV-62 ③）", () => {
  function injected() {
    const setup = setupReceipts();
    const fault = new FaultInjectingReceiptUnitOfWork(setup.uow);
    const deps: ReceiptDeps = { ...setup.deps, uow: fault };
    return { ...setup, fault, deps };
  }

  it("DB の書き込みが失敗したら、自分が put したファイルだけ discard して例外を投げ直す", () => {
    for (const failAt of [1, 2, 3]) {
      const { deps, fault, files, uow } = injected();
      const bytes = jpegBytes({ seed: failAt });
      const before = receiptSnapshotOf(uow);
      fault.failAt = failAt;
      expect(() => add(deps, { bytes }), `failAt ${failAt}`).toThrow(/injected failure/);
      const sha = files.digest(bytes);
      expect(files.discarded).toEqual([sha]);
      expect(files.has(sha)).toBe(false);
      expect(receiptSnapshotOf(uow)).toEqual(before);
    }
  });

  it("前から同じ名前のファイルがあれば put せず、失敗しても discard しない", () => {
    const { deps, fault, files, uow } = injected();
    const bytes = jpegBytes({ seed: 11 });
    const sha = files.digest(bytes);
    files.put(sha, bytes);
    files.puts.length = 0;
    fault.failAt = 2;
    expect(() => add(deps, { bytes })).toThrow(/injected failure/);
    expect(files.puts).toEqual([]);
    expect(files.discarded).toEqual([]);
    expect(files.has(sha)).toBe(true);
    expect(uow.receipts.state.receipts).toEqual([]);
  });

  it("ファイルの書き込み（put）が失敗したら、行を作らず例外のまま", () => {
    const { deps, files, uow } = injected();
    files.failOnPut = true;
    expect(() => add(deps)).toThrow(/injected failure: put/);
    expect(files.discarded).toEqual([]);
    expect(uow.receipts.state.receipts).toEqual([]);
  });
});

describe("addReceipt: 警告と日付の境目（dateOf、R2）", () => {
  // 取引 2026-04-21 の紙の証憑の期限は 2026-06-30（JST）
  const paper: Partial<ReceiptCreateOptions> = {
    category: "paper_scan",
    transactionDate: "2026-04-21",
  };

  it("JST の 6/30 23:59:59（UTC 14:59:59）は期限内", () => {
    const { deps } = setupReceipts({ now: "2026-06-30T14:59:59.000Z" });
    expect(must(add(deps, { options: paper })).warnings).toEqual([]);
  });

  it("JST の 7/1 0:00（UTC 15:00:00）は INPUT_PERIOD_EXCEEDED", () => {
    const { deps } = setupReceipts({ now: "2026-06-30T15:00:00.000Z" });
    expect(must(add(deps, { options: paper })).warnings).toEqual([
      { code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-06-30" } },
    ]);
  });

  it("解像度・階調の警告（paper_scan）は probe から", () => {
    const { deps } = setupReceipts();
    const detail = must(
      add(deps, { options: paper, probe: { width: 1000, height: 800, fullColor: false } }),
    );
    expect(detail.warnings.map((w) => w.code)).toContain("RESOLUTION_BELOW_GUIDE");
    expect(detail.warnings.map((w) => w.code)).toContain("NOT_FULL_COLOR");
  });
});

describe("listReceipts", () => {
  function seed(count: number) {
    const setup = setupReceipts();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      setup.clock.value = `2026-10-31T09:00:0${i}.000Z`;
      const detail = must(
        add(setup.deps, { bytes: jpegBytes({ seed: i }), options: { partnerName: `店${i}` } }),
      );
      ids.push(detail.id);
    }
    return { ...setup, ids };
  }
  const list = (deps: ReceiptDeps, query: ReceiptQueryInput = {}) =>
    must(listReceipts(deps, makeReceiptQuery(query)));

  it("受領日時の新しい順。要約には警告・結びつきの状態・仕訳を付ける", () => {
    const { deps, ids } = seed(3);
    const page = list(deps);
    expect(page.receipts.map((r) => r.id)).toEqual([...ids].reverse());
    expect(page.nextCursor).toBeNull();
    expect(page.receipts[0]).toMatchObject({
      linkState: "none",
      journal: null,
      deleted: false,
      mediaType: "image/jpeg",
      warnings: [],
    });
  });

  it("limit とカーソルでページを分ける。検索条件は ReceiptStore.search に渡る", () => {
    const { deps, ids } = seed(5);
    const first = list(deps, { limit: 2 });
    expect(first.receipts).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = list(deps, {
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect([...first.receipts, ...second.receipts].map((r) => r.id)).toEqual(
      [...ids].reverse().slice(0, 4),
    );
    expect(list(deps, { partner: "店９" }).receipts).toEqual([]);
    expect(list(deps, { partner: "店3" }).receipts.map((r) => r.id)).toEqual([ids[3]]);
    expect(list(deps, { partner: "店３" }).receipts.map((r) => r.id)).toEqual([ids[3]]);
  });

  it("結びつきがあれば linked・journal_voided と仕訳を付ける（取消の警告も）", () => {
    const { deps, uow, ids } = seed(2);
    addBareJournal(uow, { id: "journal-a", journalNo: 1 });
    addBareJournal(uow, { id: "journal-b", journalNo: 2, status: "voided" });
    uow.receipts.insertLink(
      makeReceiptLinkRow({ id: "l1", receiptId: ids[0] ?? "", journalId: "journal-a" }),
    );
    uow.receipts.insertLink(
      makeReceiptLinkRow({ id: "l2", receiptId: ids[1] ?? "", journalId: "journal-b" }),
    );
    const byId = Object.fromEntries(list(deps).receipts.map((r) => [r.id, r]));
    expect(byId[ids[0] ?? ""]).toMatchObject({
      linkState: "linked",
      journal: { id: "journal-a", journalNo: 1, status: "active" },
    });
    expect(byId[ids[1] ?? ""]).toMatchObject({
      linkState: "journal_voided",
      journal: { id: "journal-b", status: "voided" },
      warnings: [{ code: "JOURNAL_VOIDED" }],
    });
  });

  it("削除済みは既定で除き、includeDeleted で含める（警告は空）", () => {
    const { deps, uow, ids } = seed(2);
    const row = uow.receipts.state.receipts.find((r) => r.id === ids[0]);
    if (row === undefined) throw new Error("no row");
    row.deletedAt = "2026-10-31T10:00:00.000Z";
    row.deletedReason = "重複";
    row.transactionDate = null;
    expect(list(deps).receipts.map((r) => r.id)).toEqual([ids[1]]);
    const all = list(deps, { includeDeleted: true }).receipts;
    expect(all.map((r) => r.id)).toEqual([ids[1], ids[0]]);
    expect(all[1]).toMatchObject({ deleted: true, warnings: [] });
  });

  it("受領日の判定は dateOf を通す（UTC 15:00 の前後）", () => {
    const setup = setupReceipts({ now: "2026-06-30T14:59:59.000Z" });
    const paper = { category: "paper_scan", transactionDate: "2026-04-21" } as const;
    const early = must(add(setup.deps, { bytes: jpegBytes({ seed: 1 }), options: paper }));
    setup.clock.value = "2026-06-30T15:00:00.000Z";
    const late = must(add(setup.deps, { bytes: jpegBytes({ seed: 2 }), options: paper }));
    const byId = Object.fromEntries(list(setup.deps).receipts.map((r) => [r.id, r.warnings]));
    expect(byId[early.id]).toEqual([]);
    expect(byId[late.id]).toEqual([
      { code: "INPUT_PERIOD_EXCEEDED", details: { deadline: "2026-06-30" } },
    ]);
  });
});

describe("getReceipt", () => {
  it("ない ID は 404 RECEIPT_NOT_FOUND", () => {
    const { deps } = setupReceipts();
    expect(getReceipt(deps, "nope")).toMatchObject({
      ok: false,
      error: { code: "RECEIPT_NOT_FOUND" },
    });
  });

  it("詳細: 版の一覧（古い順）・読み取り（reason は null）・結びつき・警告", () => {
    const { deps, uow, files } = setupReceipts();
    const created = must(add(deps, { options: { amount: null } }));
    const second = jpegBytes({ seed: 77 });
    uow.receipts.insertFile(
      makeReceiptFileRow({
        sha256: files.digest(second),
        receiptId: created.id,
        fileVersion: 2,
        originalName: "again.jpg",
      }),
    );
    const readingId = "00000000-0000-7000-8000-0000000000a1";
    const journalId = "00000000-0000-7000-8000-0000000000b1";
    const reading: ReceiptReadingRow = {
      id: readingId,
      receiptId: created.id,
      fileSha256: created.currentFile.sha256,
      readAt: "2026-10-31T09:30:00.000Z",
      model: "fake-model",
      status: "succeeded",
      errorCode: null,
      candDate: "2026-10-20",
      candAmount: 1100,
      candPartner: "合成の店",
      candAccountCode: "5140",
      candTaxCategory: null,
      confidence: 80,
      comparedAt: null,
      dateMatch: null,
      amountMatch: null,
      partnerMatch: null,
      accountMatch: null,
      taxMatch: null,
    };
    uow.receipts.insertReading(reading);
    addBareJournal(uow, { id: journalId, journalNo: 1, date: "2026-10-21" });
    uow.receipts.insertLink(makeReceiptLinkRow({ id: "l1", receiptId: created.id, journalId }));

    const detail = must(getReceipt(deps, created.id));
    expect(ReceiptDetail.safeParse(detail).success).toBe(true);
    expect(detail.files.map((f) => f.fileVersion)).toEqual([1, 2]);
    expect(detail.currentFile.sha256).toBe(created.currentFile.sha256);
    expect(detail.readings).toEqual([
      {
        id: readingId,
        readAt: "2026-10-31T09:30:00.000Z",
        model: "fake-model",
        status: "succeeded",
        errorCode: null,
        candidates: {
          transactionDate: "2026-10-20",
          amount: 1100,
          partnerName: "合成の店",
          accountCode: "5140",
          taxCategory: null,
        },
        confidence: 80,
        reason: null,
      },
    ]);
    expect(detail.linkState).toBe("linked");
    expect(detail.journal).toEqual({
      id: journalId,
      journalNo: 1,
      date: "2026-10-21",
      status: "active",
    });
    expect(detail.warnings).toEqual([{ code: "FIELDS_MISSING" }]);
  });

  it("削除済みでも表示できる（警告は空、deletedAt・deletedReason を返す）", () => {
    const { deps, uow } = setupReceipts();
    const created = must(add(deps, { options: { amount: null } }));
    const row = uow.receipts.state.receipts[0];
    if (row === undefined) throw new Error("no row");
    row.deletedAt = "2026-10-31T10:00:00.000Z";
    row.deletedReason = "重複";
    const detail = must(getReceipt(deps, created.id));
    expect(detail).toMatchObject({
      deleted: true,
      deletedAt: "2026-10-31T10:00:00.000Z",
      deletedReason: "重複",
      warnings: [],
    });
  });
});

describe("readReceiptFile", () => {
  it("その証憑の版の中身・形式・元の名前を返す（過去の版も）", () => {
    const { deps, uow, files } = setupReceipts();
    const bytes = jpegBytes({ seed: 21 });
    const created = must(add(deps, { bytes, originalName: "first.jpg" }));
    const oldBytes = pdfBytes({ seed: 22 });
    const oldSha = files.digest(oldBytes);
    files.put(oldSha, oldBytes);
    uow.receipts.insertFile(
      makeReceiptFileRow({
        sha256: oldSha,
        receiptId: created.id,
        fileVersion: 2,
        mediaType: "application/pdf",
        originalName: "second.pdf",
      }),
    );
    expect(must(readReceiptFile(deps, created.id, created.currentFile.sha256))).toEqual({
      bytes,
      mediaType: "image/jpeg",
      originalName: "first.jpg",
    });
    expect(must(readReceiptFile(deps, created.id, oldSha))).toEqual({
      bytes: oldBytes,
      mediaType: "application/pdf",
      originalName: "second.pdf",
    });
  });

  it("削除済みの証憑でも取り出せる", () => {
    const { deps, uow } = setupReceipts();
    const created = must(add(deps));
    const row = uow.receipts.state.receipts[0];
    if (row === undefined) throw new Error("no row");
    row.deletedAt = "2026-10-31T10:00:00.000Z";
    row.deletedReason = "重複";
    expect(readReceiptFile(deps, created.id, created.currentFile.sha256).ok).toBe(true);
  });

  it("証憑がない・別の証憑の版・ない sha256 は 404 RECEIPT_NOT_FOUND", () => {
    const { deps } = setupReceipts();
    const a = must(add(deps, { bytes: jpegBytes({ seed: 31 }) }));
    const b = must(add(deps, { bytes: jpegBytes({ seed: 32 }) }));
    for (const [id, sha] of [
      ["nope", a.currentFile.sha256],
      [a.id, b.currentFile.sha256],
      [a.id, fakeSha(999)],
    ] as const) {
      expect(readReceiptFile(deps, id, sha)).toMatchObject({
        ok: false,
        error: { code: "RECEIPT_NOT_FOUND" },
      });
    }
  });

  it("復号・検証に失敗したら 500 RECEIPT_FILE_UNREADABLE（鍵も平文も含めない）", () => {
    const { deps, files } = setupReceipts();
    const created = must(add(deps));
    files.tamper(created.currentFile.sha256);
    const result = readReceiptFile(deps, created.id, created.currentFile.sha256);
    expect(result).toMatchObject({ ok: false, error: { code: "RECEIPT_FILE_UNREADABLE" } });
  });

  it("施錠中などの別の例外は握りつぶさずそのまま投げる", () => {
    const { deps, files } = setupReceipts();
    const created = must(add(deps));
    const locked = new FakeReceiptFileStore();
    locked.read = () => {
      throw new Error("locked");
    };
    const lockedDeps: ReceiptDeps = { ...deps, files: locked };
    expect(() => readReceiptFile(lockedDeps, created.id, created.currentFile.sha256)).toThrow(
      "locked",
    );
    expect(files.has(created.currentFile.sha256)).toBe(true);
  });
});
