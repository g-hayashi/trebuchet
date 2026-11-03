import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  needsReason,
  type ReceiptValues,
  receiptValuesOf,
  replayReceiptHistory,
} from "../../src/receipts/history.ts";
import type { Result } from "../../src/types.ts";
import { linkReceipt, unlinkReceipt } from "../../src/usecases/receipt-links.ts";
import {
  addReceipt,
  deleteReceipt,
  type ReceiptDeps,
  replaceReceiptFile,
  updateReceipt,
} from "../../src/usecases/receipts.ts";
import { jpegBytes } from "../fixtures/receipts/sample-files.ts";
import { type ReceiptOp, receiptInputArb, receiptOpArb } from "../receipt-arbitraries.ts";
import { FaultInjectingReceiptUnitOfWork, receiptSnapshotOf } from "../receipt-fault-injection.ts";
import { addBareJournal, setupReceiptsWithLedger } from "../receipt-setup.ts";

// INV-63（履歴の完全性）と INV-62（差し替えの重複・失敗）。data-model §4、research R7・R10、SC-005。
// 操作の列（入力・訂正・差し替え・削除・結びつけ・解除）を、途中の DB の失敗を混ぜて実行する

/** 同じ内容の繰り返しが起きるよう、ファイルの種を小さくする */
const SEEDS = 6;
/** 仕訳の添字 2 は取り消し済み（結びつきは残り journal_voided になる。削除は RECEIPT_LINKED） */
const JOURNAL_IDS = ["j-0", "j-1", "j-2"] as const;

const stepsArb = fc.array(
  fc.record({
    op: receiptOpArb,
    failAt: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
  }),
  { maxLength: 25 },
);

function build() {
  const ctx = setupReceiptsWithLedger();
  for (const [n, id] of JOURNAL_IDS.entries()) {
    addBareJournal(ctx.uow, { id, ...(n === 2 ? { status: "voided" as const } : {}) });
  }
  const fault = new FaultInjectingReceiptUnitOfWork(ctx.uow);
  const deps: ReceiptDeps = { ...ctx.deps, uow: fault };
  return { ctx, fault, deps };
}

type Ctx = ReturnType<typeof build>;

const bytesOf = (seed: number) => jpegBytes({ seed: seed % SEEDS });

/** 失敗のコード。成功は undefined */
const codeOf = (r: Result<unknown>) => (r.ok ? undefined : r.error.code);

/**
 * 1 つの操作を実行する。`expected` は失敗の注入がないときに決まるエラーのコード（モデル。
 * undefined は成功か、注入した DB の失敗）。`null` はモデルを持たない（結びつけ・解除）
 */
function execute(
  { ctx, deps }: Ctx,
  op: ReceiptOp,
): { run: () => Result<unknown>; expected: string | undefined | null } | undefined {
  const rows = ctx.uow.receipts.state.receipts;
  const hasSha = (sha: string) => ctx.uow.receipts.state.files.some((f) => f.sha256 === sha);
  if (op.kind === "add") {
    const bytes = bytesOf(op.seed);
    return {
      expected: hasSha(ctx.files.digest(bytes)) ? "RECEIPT_DUPLICATE" : undefined,
      run: () =>
        addReceipt(deps, {
          bytes,
          originalName: "r.jpg",
          channel: "local",
          options: op.input,
          probe: null,
        }),
    };
  }
  if (op.kind === "read" || rows.length === 0) return undefined;
  const row = rows[op.target % rows.length];
  if (row === undefined) return undefined;
  const deleted = row.deletedAt !== null;
  switch (op.kind) {
    case "update":
      return {
        expected: deleted
          ? "RECEIPT_DELETED"
          : needsReason(row, { ...op.changes, version: row.version }) && op.reason === undefined
            ? "REASON_REQUIRED"
            : undefined,
        run: () =>
          updateReceipt(deps, row.id, {
            ...op.changes,
            version: row.version,
            ...(op.reason === undefined ? {} : { reason: op.reason }),
          }),
      };
    case "replace": {
      const bytes = bytesOf(op.seed);
      return {
        expected: deleted
          ? "RECEIPT_DELETED"
          : hasSha(ctx.files.digest(bytes))
            ? "RECEIPT_DUPLICATE"
            : undefined,
        run: () =>
          replaceReceiptFile(deps, row.id, {
            bytes,
            originalName: "retake.jpg",
            channel: "remote",
            reason: op.reason,
            version: row.version,
            probe: null,
          }),
      };
    }
    case "delete":
      return {
        expected: deleted
          ? "RECEIPT_DELETED"
          : ctx.uow.receipts.getActiveLink(row.id) !== undefined
            ? "RECEIPT_LINKED"
            : undefined,
        run: () => deleteReceipt(deps, row.id, { reason: op.reason, version: row.version }),
      };
    case "link":
      return {
        expected: null,
        run: () =>
          linkReceipt(deps, row.id, {
            journalId: JOURNAL_IDS[op.journal % JOURNAL_IDS.length] as string,
            replace: op.replace,
            reason: op.reason,
          }),
      };
    case "unlink":
      return { expected: null, run: () => unlinkReceipt(deps, row.id, { reason: op.reason }) };
  }
}

describe("INV-63: 操作の列の後の履歴の完全性", () => {
  it("行は減らず既存の版・履歴は変わらない、版は連番で今の版は最大、履歴を当てると各時点の値と原本に戻る", () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        const built = build();
        const { ctx, fault } = built;
        const { uow, files } = ctx;
        /** モデル: 証憑ごとに、値を変えた操作の直後の値（古い順） */
        const timeline = new Map<string, ReceiptValues[]>();

        for (const [n, { op, failAt }] of steps.entries()) {
          const step = execute(built, op);
          if (step === undefined) continue;
          ctx.clock.value = `2026-11-01T00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`;
          fault.failAt = failAt;
          const before = receiptSnapshotOf(uow);
          const namesBefore = [...files.files.keys()].sort();

          let result: Result<unknown> | undefined;
          try {
            result = step.run();
          } catch (e) {
            expect(String(e)).toMatch(/injected failure/);
          }
          fault.failAt = null;
          const after = uow.receipts.state;

          if (result === undefined || !result.ok) {
            // 失敗（DB の失敗・業務のエラー）は行も履歴も、その呼び出しが置いたファイルも残さない
            expect(receiptSnapshotOf(uow)).toEqual(before);
            expect([...files.files.keys()].sort()).toEqual(namesBefore);
          }
          if (step.expected !== null) {
            if (step.expected !== undefined) {
              expect(result === undefined ? "threw" : codeOf(result)).toBe(step.expected);
            } else if (result === undefined) {
              expect(failAt).not.toBeNull();
            } else {
              expect(codeOf(result)).toBeUndefined();
            }
          }

          // 5 表の行数は減らず、ファイルの版と履歴の既存の行は変わらない
          const b = before.receipts;
          expect(after.receipts.length).toBeGreaterThanOrEqual(b.receipts.length);
          expect(after.links.length).toBeGreaterThanOrEqual(b.links.length);
          expect(after.readings.length).toBeGreaterThanOrEqual(b.readings.length);
          expect(after.files.slice(0, b.files.length)).toEqual(b.files);
          expect(after.audits.slice(0, b.audits.length)).toEqual(b.audits);

          // モデルを進める: 値が変わった証憑だけ、その直後の値を足す
          for (const row of after.receipts) {
            const values = receiptValuesOf(row);
            const seen = timeline.get(row.id) ?? [];
            const last = seen.at(-1);
            if (last === undefined || JSON.stringify(last) !== JSON.stringify(values)) {
              timeline.set(row.id, [...seen, values]);
            }
          }
        }

        const state = uow.receipts.state;
        for (const row of state.receipts) {
          // 版は 1 から連番、今の版は最大の版
          const versions = state.files
            .filter((f) => f.receiptId === row.id)
            .sort((x, y) => x.fileVersion - y.fileVersion);
          expect(versions.map((f) => f.fileVersion)).toEqual(versions.map((_, i) => i + 1));
          expect(row.currentSha256).toBe(versions.at(-1)?.sha256);
          // 履歴を当てると、どの時点の値も操作の直後の値と一致し、その時点の原本を読める（SC-005）
          const points = replayReceiptHistory(uow.receipts.listAudit(row.id));
          expect(points.map((p) => p.values)).toEqual(timeline.get(row.id));
          expect(points[0]?.action).toBe("create");
          for (const point of points) {
            const sha = point.values.currentSha256;
            expect(files.digest(files.read(sha))).toBe(sha);
          }
          // 削除済みの証憑は有効な結びつきを持たない（INV-64）
          if (row.deletedAt !== null) {
            expect(state.links.some((l) => l.receiptId === row.id && l.unlinkedAt === null)).toBe(
              false,
            );
          }
        }
      }),
    );
  });
});

describe("INV-62: 差し替えの列（同じ内容の繰り返し・DB とファイルの書き込みの失敗を含む）", () => {
  it("sha256 は一意、同じ内容は作らない、失敗は行もファイルも残さない、各行にファイルがある", () => {
    const attemptsArb = fc.array(
      fc.record({
        target: fc.nat({ max: 1 }),
        seed: fc.nat({ max: 5 }),
        failAt: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
        putFails: fc.boolean(),
      }),
      { maxLength: 14 },
    );
    fc.assert(
      fc.property(fc.tuple(receiptInputArb, receiptInputArb), attemptsArb, (inputs, attempts) => {
        const { ctx, fault, deps } = build();
        const { uow, files } = ctx;
        const ids = inputs.map((options, i) => {
          const added = addReceipt(ctx.deps, {
            bytes: jpegBytes({ seed: 100 + i }),
            originalName: "r.jpg",
            channel: "local",
            options,
            probe: null,
          });
          if (!added.ok) throw new Error(added.error.message);
          return added.value.id;
        });

        for (const [n, attempt] of attempts.entries()) {
          const id = ids[attempt.target] as string;
          const row = uow.receipts.getReceipt(id);
          if (row === undefined) throw new Error("receipt");
          const bytes = jpegBytes({ seed: attempt.seed });
          const sha = files.digest(bytes);
          const known = uow.receipts.state.files.some((f) => f.sha256 === sha);
          const before = receiptSnapshotOf(uow);
          const namesBefore = [...files.files.keys()].sort();
          ctx.clock.value = `2026-11-01T01:00:${String(n).padStart(2, "0")}.000Z`;
          fault.failAt = attempt.failAt;
          files.failOnPut = attempt.putFails;

          let result: Result<unknown> | undefined;
          try {
            result = replaceReceiptFile(deps, id, {
              bytes,
              originalName: "retake.jpg",
              channel: "remote",
              reason: "撮り直し",
              version: row.version,
              probe: null,
            });
          } catch (e) {
            expect(String(e)).toMatch(/injected failure/);
          }
          fault.failAt = null;
          files.failOnPut = false;

          if (known) {
            // ② 同じ内容は新しい版を作らない（書き込みに届かない）
            expect(result === undefined ? "threw" : codeOf(result)).toBe("RECEIPT_DUPLICATE");
          }
          if (result?.ok) {
            const files_ = uow.receipts.listFiles(id);
            expect(files_.at(-1)).toMatchObject({ sha256: sha, fileVersion: files_.length });
            expect(uow.receipts.getReceipt(id)?.currentSha256).toBe(sha);
          } else {
            // ③ 失敗は行も、その呼び出しが置いたファイルも残さない
            expect(receiptSnapshotOf(uow)).toEqual(before);
            expect([...files.files.keys()].sort()).toEqual(namesBefore);
          }
        }

        const rows = uow.receipts.state.files;
        // ① sha256 は一意
        expect(new Set(rows.map((f) => f.sha256)).size).toBe(rows.length);
        // ④ 各行にファイルがあり、読むと sha256 に一致する。行のないファイルは残らない
        for (const r of rows) expect(files.digest(files.read(r.sha256))).toBe(r.sha256);
        expect([...files.files.keys()].sort()).toEqual(rows.map((f) => f.sha256).sort());
      }),
    );
  });
});
