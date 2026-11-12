import { describe, expect, it } from "vitest";
import type { ReceiptReadingRequest } from "../../src/ports.ts";
import { RECEIPT_AI_MAX_PX } from "../../src/receipts/reading-prompt.ts";
import { domainError, err, type JournalDraft, ok, type Result } from "../../src/types.ts";
import { createJournalFromReceipt } from "../../src/usecases/receipt-links.ts";
import { type ReceiptReadingDeps, readReceipt } from "../../src/usecases/receipt-reading.ts";
import {
  addReceipt,
  deleteReceipt,
  replaceReceiptFile,
  updateReceipt,
} from "../../src/usecases/receipts.ts";
import { FakeImageTool, FakeReceiptReader } from "../fakes.ts";
import { jpegBytes, jpegSegments, pdfBytes, readExif } from "../fixtures/receipts/sample-files.ts";
import { FaultInjectingReceiptUnitOfWork, receiptSnapshotOf } from "../receipt-fault-injection.ts";
import { setupReceiptsWithLedger } from "../receipt-setup.ts";
import { codeOf, must } from "../result.ts";

// T033: 証憑の読み取りのユースケース（contracts/domain-module.md §3、research R13・R14、FR-014〜017、INV-66・67）。
// AI・sips は呼ばない（偽の ReceiptReader・ReceiptImageTool）

const PROBE = { width: 4032, height: 3024, fullColor: true };

/** `read` の最中に UnitOfWork が開いていないこと（AI をトランザクションの外で呼ぶ。R13）を確かめる偽の reader */
class OutsideTransactionReader extends FakeReceiptReader {
  hook: (() => void) | undefined;
  private readonly check: () => void;
  constructor(check: () => void) {
    super();
    this.check = check;
  }
  override async read(request: ReceiptReadingRequest): Promise<Result<unknown>> {
    this.check();
    this.hook?.();
    return super.read(request);
  }
}

function setup(options: { bytes?: Uint8Array; withReader?: boolean } = {}) {
  const ctx = setupReceiptsWithLedger();
  const images = new FakeImageTool();
  const reader = new OutsideTransactionReader(() => {
    // 入れ子の run は例外になる。開いていなければ通る
    ctx.uow.run(() => ok(undefined));
  });
  const accountCode = ctx.masters.listAccounts().find((a) => a.name === "消耗品費")?.code;
  if (accountCode === undefined) throw new Error("消耗品費がない");
  const deps: ReceiptReadingDeps = {
    ...ctx.deps,
    images,
    reader: options.withReader === false ? undefined : reader,
  };
  const added = must(
    addReceipt(ctx.deps, {
      bytes: options.bytes ?? jpegBytes({ orientation: 6, gps: true, comment: "SENTINEL_NAME" }),
      originalName: "receipt-sentinel.jpg",
      channel: "local",
      options: { category: "electronic" },
      probe: PROBE,
    }),
  );
  const answer = (over: Record<string, unknown> = {}) =>
    reader.respondWith(
      ok(
        JSON.stringify({
          transactionDate: "2026-10-20",
          amount: 1100,
          partnerName: "合成の店",
          accountCode,
          taxCategory: "OUT_OF_SCOPE",
          confidence: 85,
          reason: "文具の購入",
          ...over,
        }),
      ),
    );
  answer();
  return { ...ctx, images, reader, deps, receipt: added, accountCode, answer };
}
type Ctx = ReturnType<typeof setup>;

const readings = (ctx: Ctx) => ctx.uow.receipts.state.readings;

describe("readReceipt: 成功", () => {
  it("AI の候補を返し、読み取りの記録と履歴 read を書く。証憑の値は変えない（INV-67）", async () => {
    const ctx = setup();
    ctx.clock.value = "2026-11-02T01:00:00.000Z";
    const before = structuredClone(ctx.uow.receipts.state.receipts);
    const result = must(await readReceipt(ctx.deps, ctx.receipt.id));
    expect(result).toMatchObject({
      status: "succeeded",
      errorCode: null,
      model: "fake-model",
      confidence: 85,
      reason: "文具の購入",
      readAt: "2026-11-02T01:00:00.000Z",
      candidates: {
        transactionDate: "2026-10-20",
        amount: 1100,
        partnerName: "合成の店",
        accountCode: ctx.accountCode,
        taxCategory: "OUT_OF_SCOPE",
      },
    });
    // 証憑の行は変わらない（候補は返すだけ。保存は利用者の更新だけ）
    expect(ctx.uow.receipts.state.receipts).toEqual(before);
    expect(readings(ctx)).toHaveLength(1);
    expect(readings(ctx)[0]).toMatchObject({
      id: result.id,
      receiptId: ctx.receipt.id,
      fileSha256: ctx.receipt.currentFile.sha256,
      model: "fake-model",
      status: "succeeded",
      errorCode: null,
      candDate: "2026-10-20",
      candAmount: 1100,
      candPartner: "合成の店",
      candAccountCode: ctx.accountCode,
      candTaxCategory: "OUT_OF_SCOPE",
      confidence: 85,
      comparedAt: null,
      dateMatch: null,
      amountMatch: null,
      partnerMatch: null,
      accountMatch: null,
      taxMatch: null,
    });
    const audit = ctx.uow.receipts.state.audits.at(-1);
    expect(audit).toMatchObject({
      targetType: "receipt_reading",
      targetId: result.id,
      action: "read",
    });
    // 履歴には日時・モデル名・状態だけ（候補の値・説明は入れない）
    expect(JSON.parse(audit?.afterJson ?? "null")).toEqual({
      receiptId: ctx.receipt.id,
      model: "fake-model",
      status: "succeeded",
    });
    expect(audit?.occurredAt).toBe("2026-11-02T01:00:00.000Z");
  });

  it("送る要求は固定の指示文・科目と税区分の一覧・メタデータを除いた画像 1 枚だけ（INV-66）", async () => {
    const ctx = setup();
    must(await readReceipt(ctx.deps, ctx.receipt.id));
    expect(ctx.reader.calls).toHaveLength(1);
    const request = ctx.reader.calls[0] as ReceiptReadingRequest;
    expect(request.choices).toContain(`${ctx.accountCode} 消耗品費`);
    expect(request.choices).toContain("PURCHASE_10");
    // GPS・コメントは除かれ、向きだけが残る
    expect(jpegSegments(request.image.bytes)).not.toContain("COM");
    expect(readExif(request.image.bytes)).toEqual({ orientation: 6, hasGps: false });
    // 取引先・ファイル名・コメントは要求に出ない
    const text = JSON.stringify({ ...request, image: undefined });
    expect(text).not.toContain("合成の店");
    expect(text).not.toContain("receipt-sentinel");
    expect(text).not.toContain("SENTINEL_NAME");
    expect(ctx.images.calls.filter((c) => c.method === "toAiJpeg")).toEqual([
      { method: "toAiJpeg", mediaType: "image/jpeg" },
    ]);
    expect(RECEIPT_AI_MAX_PX).toBe(2048);
  });

  it("PDF は media type をそのまま変換器へ渡す", async () => {
    const ctx = setup({ bytes: pdfBytes({ seed: 2 }) });
    must(await readReceipt(ctx.deps, ctx.receipt.id));
    expect(ctx.images.calls.find((c) => c.method === "toAiJpeg")?.mediaType).toBe(
      "application/pdf",
    );
  });

  it("AI の出力の一部が検証を通らなければ、その項目だけ候補なしで記録する（FR-016）", async () => {
    const ctx = setup();
    ctx.answer({ amount: "千円", accountCode: "9999" });
    const result = must(await readReceipt(ctx.deps, ctx.receipt.id));
    expect(result).toMatchObject({
      status: "succeeded",
      candidates: { amount: null, accountCode: null, partnerName: "合成の店" },
    });
    expect(readings(ctx)[0]).toMatchObject({ candAmount: null, candAccountCode: null });
  });

  it("同じ証憑を何度でも読める（読み取りごとに記録が増える）", async () => {
    const ctx = setup();
    must(await readReceipt(ctx.deps, ctx.receipt.id));
    must(await readReceipt(ctx.deps, ctx.receipt.id));
    expect(readings(ctx)).toHaveLength(2);
    expect(ctx.uow.receipts.state.audits.filter((a) => a.action === "read")).toHaveLength(2);
  });
});

describe("readReceipt: 呼べないとき（何も呼ばず、何も書かない）", () => {
  it("reader が undefined（設定で無効）なら AI_NOT_CONFIGURED。変換も AI も 1 回も呼ばない（INV-66）", async () => {
    const ctx = setup({ withReader: false });
    const before = receiptSnapshotOf(ctx.uow);
    const r = await readReceipt(ctx.deps, ctx.receipt.id);
    expect(codeOf(r)).toBe("AI_NOT_CONFIGURED");
    expect(ctx.images.calls).toEqual([]);
    expect(ctx.reader.calls).toEqual([]);
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });

  it("モデル名がなければ（設定がそろっていない）AI_NOT_CONFIGURED。変換も AI も呼ばない", async () => {
    const ctx = setup();
    ctx.reader.setModel(undefined);
    const r = await readReceipt(ctx.deps, ctx.receipt.id);
    expect(codeOf(r)).toBe("AI_NOT_CONFIGURED");
    expect(ctx.images.calls).toEqual([]);
    expect(ctx.reader.calls).toEqual([]);
    expect(readings(ctx)).toEqual([]);
  });

  it("証憑がなければ RECEIPT_NOT_FOUND、削除済みなら RECEIPT_DELETED", async () => {
    const ctx = setup();
    expect(codeOf(await readReceipt(ctx.deps, "r-none"))).toBe("RECEIPT_NOT_FOUND");
    must(deleteReceipt(ctx.deps, ctx.receipt.id, { reason: "誤って追加", version: 1 }));
    const before = receiptSnapshotOf(ctx.uow);
    expect(codeOf(await readReceipt(ctx.deps, ctx.receipt.id))).toBe("RECEIPT_DELETED");
    expect(ctx.images.calls).toEqual([]);
    expect(ctx.reader.calls).toEqual([]);
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });

  it("ファイルを復号できなければ RECEIPT_FILE_UNREADABLE（AI の失敗としては記録しない）", async () => {
    const ctx = setup();
    ctx.files.tamper(ctx.receipt.currentFile.sha256);
    expect(codeOf(await readReceipt(ctx.deps, ctx.receipt.id))).toBe("RECEIPT_FILE_UNREADABLE");
    expect(readings(ctx)).toEqual([]);
    expect(ctx.reader.calls).toEqual([]);
  });
});

describe("readReceipt: 変換・AI の失敗は記録して ok で返す（R13 の写像）", () => {
  const cases: {
    name: string;
    arrange: (ctx: Ctx) => void;
    status: string;
    errorCode: string;
    aiCalled: boolean;
  }[] = [
    {
      name: "PDF を描けない（RECEIPT_READ_UNSUPPORTED）",
      arrange: (ctx) =>
        ctx.images.respondAiJpeg(
          err(domainError("RECEIPT_READ_UNSUPPORTED", "この形式は読み取れません")),
        ),
      status: "failed",
      errorCode: "RECEIPT_READ_UNSUPPORTED",
      aiCalled: false,
    },
    {
      name: "変換の失敗",
      arrange: (ctx) =>
        ctx.images.respondAiJpeg(err(domainError("RECEIPT_CONVERSION_FAILED", "変換に失敗"))),
      status: "failed",
      errorCode: "RECEIPT_CONVERSION_FAILED",
      aiCalled: false,
    },
    {
      name: "変換が JPEG でないものを返した（メタデータの除去の失敗）",
      arrange: (ctx) => ctx.images.respondAiJpeg(ok(pdfBytes())),
      status: "failed",
      errorCode: "RECEIPT_CONVERSION_FAILED",
      aiCalled: false,
    },
    {
      name: "AI の時間切れ（details.timeout）",
      arrange: (ctx) =>
        ctx.reader.respondWith(err(domainError("VALIDATION", "時間切れ", { timeout: true }))),
      status: "timeout",
      errorCode: "AI_TIMEOUT",
      aiCalled: true,
    },
    {
      name: "AI の通信・HTTP の失敗",
      arrange: (ctx) =>
        ctx.reader.respondWith(err(domainError("VALIDATION", "AI が 500 を返しました"))),
      status: "failed",
      errorCode: "AI_HTTP_ERROR",
      aiCalled: true,
    },
    {
      name: "AI の出力が JSON でない",
      arrange: (ctx) => ctx.reader.respondWith(ok("読み取れませんでした")),
      status: "invalid",
      errorCode: "AI_INVALID_OUTPUT",
      aiCalled: true,
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.status}・${c.errorCode}。候補は全部 null`, async () => {
      const ctx = setup();
      c.arrange(ctx);
      const result = must(await readReceipt(ctx.deps, ctx.receipt.id));
      expect(result).toMatchObject({
        status: c.status,
        errorCode: c.errorCode,
        model: "fake-model",
        confidence: null,
        reason: null,
        candidates: {
          transactionDate: null,
          amount: null,
          partnerName: null,
          accountCode: null,
          taxCategory: null,
        },
      });
      expect(ctx.reader.calls).toHaveLength(c.aiCalled ? 1 : 0);
      expect(readings(ctx)).toHaveLength(1);
      expect(readings(ctx)[0]).toMatchObject({
        status: c.status,
        errorCode: c.errorCode,
        candDate: null,
        candAmount: null,
        candPartner: null,
        candAccountCode: null,
        candTaxCategory: null,
        confidence: null,
      });
      expect(ctx.uow.receipts.state.audits.at(-1)).toMatchObject({ action: "read" });
    });
  }

  it("reader が例外を投げたら（想定外）、何も書かずに例外のまま上げる", async () => {
    const ctx = setup();
    ctx.reader.throwOnCall = true;
    const before = receiptSnapshotOf(ctx.uow);
    await expect(readReceipt(ctx.deps, ctx.receipt.id)).rejects.toThrow("boom");
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
  });
});

describe("readReceipt: 3 段の間に状態が変わったとき", () => {
  it("AI を待つ間に証憑が削除されたら、何も書かず RECEIPT_DELETED", async () => {
    const ctx = setup();
    ctx.reader.hook = () => {
      must(deleteReceipt(ctx.deps, ctx.receipt.id, { reason: "誤って追加", version: 1 }));
    };
    const r = await readReceipt(ctx.deps, ctx.receipt.id);
    expect(codeOf(r)).toBe("RECEIPT_DELETED");
    expect(readings(ctx)).toEqual([]);
    expect(ctx.uow.receipts.state.audits.some((a) => a.action === "read")).toBe(false);
  });

  it("AI を待つ間にファイルが差し替えられても、読んだ版（sha256）で記録する", async () => {
    const ctx = setup();
    const readSha = ctx.receipt.currentFile.sha256;
    ctx.reader.hook = () => {
      must(
        replaceReceiptFile(ctx.deps, ctx.receipt.id, {
          bytes: jpegBytes({ seed: 77 }),
          originalName: "retake.jpg",
          channel: "local",
          reason: "撮り直し",
          version: 1,
          probe: PROBE,
        }),
      );
    };
    must(await readReceipt(ctx.deps, ctx.receipt.id));
    expect(readings(ctx)[0]?.fileSha256).toBe(readSha);
  });

  it("書き込み（読み取りの記録・履歴）のどこで失敗しても、片方だけ残らない（INV-62）", async () => {
    let threw = 0;
    for (const failAt of [1, 2, 3]) {
      const ctx = setup();
      const fault = new FaultInjectingReceiptUnitOfWork(ctx.uow);
      fault.failAt = failAt;
      const before = receiptSnapshotOf(ctx.uow);
      try {
        const r = await readReceipt({ ...ctx.deps, uow: fault }, ctx.receipt.id);
        expect(r.ok).toBe(true);
      } catch {
        threw += 1;
        expect(receiptSnapshotOf(ctx.uow)).toEqual(before);
      }
    }
    expect(threw).toBeGreaterThanOrEqual(2);
  });
});

describe("updateReceipt: 保存した値との比べ（列ごとに 1 回だけ。R14・L2）", () => {
  it("値を保存すると、今の版の最新の succeeded の読み取りに日付・金額・取引先の比べを書く", async () => {
    const ctx = setup();
    const reading = must(await readReceipt(ctx.deps, ctx.receipt.id));
    ctx.clock.value = "2026-11-03T00:00:00.000Z";
    must(
      updateReceipt(ctx.deps, ctx.receipt.id, {
        version: 1,
        transactionDate: "2026-10-20",
        amount: 1200,
        partnerName: "ｶﾌｪ",
      }),
    );
    expect(readings(ctx).find((r) => r.id === reading.id)).toMatchObject({
      comparedAt: "2026-11-03T00:00:00.000Z",
      dateMatch: true,
      amountMatch: false,
      partnerMatch: false,
      accountMatch: null,
      taxMatch: null,
    });
  });

  it("取引先は normalizeReceiptText で比べる（全角・半角・大文字小文字・空白の違いは同じ）", async () => {
    const ctx = setup();
    ctx.answer({ partnerName: "ＡＢＣ ｽﾄｱ" });
    const reading = must(await readReceipt(ctx.deps, ctx.receipt.id));
    must(updateReceipt(ctx.deps, ctx.receipt.id, { version: 1, partnerName: "abc ストア" }));
    expect(readings(ctx).find((r) => r.id === reading.id)?.partnerMatch).toBe(true);
  });

  it("保存していない項目は比べない。後から保存した列は後から書ける。書いた列は書き換えない", async () => {
    const ctx = setup();
    const reading = must(await readReceipt(ctx.deps, ctx.receipt.id));
    ctx.clock.value = "2026-11-03T00:00:00.000Z";
    must(updateReceipt(ctx.deps, ctx.receipt.id, { version: 1, amount: 1100 }));
    expect(readings(ctx)[0]).toMatchObject({
      id: reading.id,
      comparedAt: "2026-11-03T00:00:00.000Z",
      amountMatch: true,
      dateMatch: null,
      partnerMatch: null,
    });
    ctx.clock.value = "2026-11-04T00:00:00.000Z";
    must(
      updateReceipt(ctx.deps, ctx.receipt.id, {
        version: 2,
        transactionDate: "2026-10-21",
        amount: 900,
        reason: "金額の訂正",
      }),
    );
    expect(readings(ctx)[0]).toMatchObject({
      comparedAt: "2026-11-03T00:00:00.000Z", // 最初の比べのまま
      amountMatch: true, // 書いた列は動かない
      dateMatch: false,
      partnerMatch: null,
    });
  });

  it("読み取りがない・失敗した読み取りだけなら何も書かない。古い版の読み取りには書かない", async () => {
    const ctx = setup();
    must(updateReceipt(ctx.deps, ctx.receipt.id, { version: 1, memo: "メモ" })); // 読み取りなし
    ctx.reader.respondWith(err(domainError("VALIDATION", "500")));
    must(await readReceipt(ctx.deps, ctx.receipt.id));
    must(updateReceipt(ctx.deps, ctx.receipt.id, { version: 2, amount: 1100 }));
    expect(readings(ctx)[0]).toMatchObject({
      status: "failed",
      comparedAt: null,
      amountMatch: null,
    });

    // 成功した読み取りの後にファイルを差し替えると、古い版の読み取りは比べない
    ctx.answer();
    must(await readReceipt(ctx.deps, ctx.receipt.id));
    must(
      replaceReceiptFile(ctx.deps, ctx.receipt.id, {
        bytes: jpegBytes({ seed: 31 }),
        originalName: "retake.jpg",
        channel: "local",
        reason: "撮り直し",
        version: 3,
        probe: PROBE,
      }),
    );
    must(updateReceipt(ctx.deps, ctx.receipt.id, { version: 4, partnerName: "合成の店" }));
    expect(readings(ctx)[1]).toMatchObject({ status: "succeeded", comparedAt: null });
  });

  it("読み取りが複数あるときは最新の succeeded だけに書く", async () => {
    const ctx = setup();
    const first = must(await readReceipt(ctx.deps, ctx.receipt.id));
    ctx.answer({ amount: 500 });
    const second = must(await readReceipt(ctx.deps, ctx.receipt.id));
    must(updateReceipt(ctx.deps, ctx.receipt.id, { version: 1, amount: 500 }));
    expect(readings(ctx).find((r) => r.id === first.id)?.amountMatch).toBeNull();
    expect(readings(ctx).find((r) => r.id === second.id)?.amountMatch).toBe(true);
  });

  it("何も変わらない更新・比べる値がない更新（メモだけ）では書かない", async () => {
    const ctx = setup();
    must(await readReceipt(ctx.deps, ctx.receipt.id));
    must(updateReceipt(ctx.deps, ctx.receipt.id, { version: 1, memo: "メモ" }));
    expect(readings(ctx)[0]).toMatchObject({ comparedAt: null, amountMatch: null });
  });
});

describe("createJournalFromReceipt: readingId の比べ（account_match・tax_match）", () => {
  const draftOf = (
    ctx: Ctx,
    tax: "OUT_OF_SCOPE" | "PURCHASE_10" = "OUT_OF_SCOPE",
  ): JournalDraft => ({
    date: "2026-10-20",
    memo: "合成の仕訳",
    lines: [
      { side: "debit", accountId: ctx.accountId("消耗品費"), amount: 1100, taxCategory: tax },
      { side: "credit", accountId: ctx.accountId("普通預金"), amount: 1100 },
    ],
  });

  it("仕訳のどれかの行が候補の科目・税区分と同じなら true、違えば false", async () => {
    const ctx = setup();
    const reading = must(await readReceipt(ctx.deps, ctx.receipt.id));
    ctx.clock.value = "2026-11-03T00:00:00.000Z";
    must(
      createJournalFromReceipt(ctx.deps, ctx.receipt.id, {
        journal: draftOf(ctx),
        readingId: reading.id,
      }),
    );
    expect(readings(ctx)[0]).toMatchObject({
      comparedAt: "2026-11-03T00:00:00.000Z",
      accountMatch: true,
      taxMatch: true,
      dateMatch: null,
    });

    const other = setup();
    other.answer({
      accountCode: other.masters.listAccounts().find((a) => a.name === "旅費交通費")?.code,
    });
    const r2 = must(await readReceipt(other.deps, other.receipt.id));
    must(
      createJournalFromReceipt(other.deps, other.receipt.id, {
        journal: draftOf(other),
        readingId: r2.id,
      }),
    );
    expect(other.uow.receipts.state.readings[0]).toMatchObject({
      accountMatch: false,
      taxMatch: true,
    });
  });

  it("値の保存の比べの後でも、account_match・tax_match を書ける（列ごとに 1 回。L2）", async () => {
    const ctx = setup();
    const reading = must(await readReceipt(ctx.deps, ctx.receipt.id));
    ctx.clock.value = "2026-11-03T00:00:00.000Z";
    must(updateReceipt(ctx.deps, ctx.receipt.id, { version: 1, amount: 1100 }));
    ctx.clock.value = "2026-11-04T00:00:00.000Z";
    must(
      createJournalFromReceipt(ctx.deps, ctx.receipt.id, {
        journal: draftOf(ctx),
        readingId: reading.id,
      }),
    );
    expect(readings(ctx)[0]).toMatchObject({
      comparedAt: "2026-11-03T00:00:00.000Z",
      amountMatch: true,
      accountMatch: true,
      taxMatch: true,
    });
  });

  it("readingId がなければ比べを書かない。ほかの証憑・存在しない readingId は VALIDATION で、仕訳も作らない", async () => {
    const ctx = setup();
    const reading = must(await readReceipt(ctx.deps, ctx.receipt.id));
    const before = receiptSnapshotOf(ctx.uow);
    for (const readingId of ["r-none", "other"]) {
      const r = createJournalFromReceipt(ctx.deps, ctx.receipt.id, {
        journal: draftOf(ctx),
        readingId,
      });
      expect(codeOf(r)).toBe("VALIDATION");
    }
    expect(receiptSnapshotOf(ctx.uow)).toEqual(before);

    must(createJournalFromReceipt(ctx.deps, ctx.receipt.id, { journal: draftOf(ctx) }));
    expect(readings(ctx).find((r) => r.id === reading.id)).toMatchObject({
      comparedAt: null,
      accountMatch: null,
      taxMatch: null,
    });
  });

  it("失敗した読み取り（候補なし）の readingId を渡しても何も書かない", async () => {
    const ctx = setup();
    ctx.reader.respondWith(err(domainError("VALIDATION", "500")));
    const reading = must(await readReceipt(ctx.deps, ctx.receipt.id));
    must(
      createJournalFromReceipt(ctx.deps, ctx.receipt.id, {
        journal: draftOf(ctx),
        readingId: reading.id,
      }),
    );
    expect(readings(ctx)[0]).toMatchObject({
      comparedAt: null,
      accountMatch: null,
      taxMatch: null,
    });
  });
});
