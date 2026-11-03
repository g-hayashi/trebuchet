import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { receiptValuesOf, replayReceiptHistory } from "../../src/receipts/history.ts";
import { addReceipt, type ReceiptDeps } from "../../src/usecases/receipts.ts";
import { jpegBytes } from "../fixtures/receipts/sample-files.ts";
import { receiptInputArb } from "../receipt-arbitraries.ts";
import { FaultInjectingReceiptUnitOfWork, receiptSnapshotOf } from "../receipt-fault-injection.ts";
import { setupReceipts } from "../receipt-setup.ts";

// INV-62（追加は全部か無か・重複なし）と INV-63 の create の履歴（data-model §4）

/** 種を小さくして、同じ内容の繰り返しが起きるようにする。failAt はその呼び出しの DB の書き込みの失敗 */
const attemptsArb = fc.array(
  fc.record({
    input: receiptInputArb,
    seed: fc.nat({ max: 4 }),
    failAt: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
    channel: fc.constantFrom("local" as const, "remote" as const),
  }),
  { maxLength: 14 },
);

describe("INV-62: 追加の列（同じ内容の繰り返し・DB の失敗を含む）", () => {
  it("sha256 は一意、2 回目は作らない、失敗は行もファイルも残さない、行ごとにファイルがある", () => {
    fc.assert(
      fc.property(attemptsArb, (attempts) => {
        const setup = setupReceipts();
        const fault = new FaultInjectingReceiptUnitOfWork(setup.uow);
        const deps: ReceiptDeps = { ...setup.deps, uow: fault };
        const { files, uow } = setup;

        for (const [n, attempt] of attempts.entries()) {
          const bytes = jpegBytes({ seed: attempt.seed });
          const sha = files.digest(bytes);
          const knownBefore = uow.receipts.state.files.some((f) => f.sha256 === sha);
          const before = receiptSnapshotOf(uow);
          const namesBefore = [...files.files.keys()].sort();
          const receiptsBefore = uow.receipts.state.receipts.length;
          fault.failAt = attempt.failAt;
          setup.clock.value = `2026-10-31T09:00:${String(n).padStart(2, "0")}.000Z`;

          let outcome: "ok" | "err" | "threw";
          let code: string | undefined;
          try {
            const result = addReceipt(deps, {
              bytes,
              originalName: "r.jpg",
              channel: attempt.channel,
              options: attempt.input,
              probe: { width: 4000, height: 3000, fullColor: true },
            });
            outcome = result.ok ? "ok" : "err";
            code = result.ok ? undefined : result.error.code;
          } catch {
            outcome = "threw";
          }

          if (knownBefore) {
            // 同じ内容: 2 回目は作らない（失敗の注入には届かない）
            expect(outcome).toBe("err");
            expect(code).toBe("RECEIPT_DUPLICATE");
          }
          if (outcome === "ok") {
            expect(uow.receipts.state.receipts).toHaveLength(receiptsBefore + 1);
            expect(files.has(sha)).toBe(true);
          } else {
            // ③ 失敗した追加は行も、その呼び出しが作ったファイルも残さない
            expect(receiptSnapshotOf(uow)).toEqual(before);
            expect([...files.files.keys()].sort()).toEqual(namesBefore);
          }
        }

        const rows = uow.receipts.state.files;
        // ① sha256 は一意
        expect(new Set(rows.map((f) => f.sha256)).size).toBe(rows.length);
        // ④ 各行にファイルがあり、読むと sha256 に一致する
        for (const row of rows) {
          expect(files.digest(files.read(row.sha256))).toBe(row.sha256);
        }
        // ファイルは行のあるものだけ（孤立したファイルを残さない）
        expect([...files.files.keys()].sort()).toEqual(rows.map((f) => f.sha256).sort());
      }),
    );
  });
});

describe("INV-63: create の履歴", () => {
  it("どの追加の後も、replayReceiptHistory は追加した直後の値と一致する（原本の sha256 を含む）", () => {
    fc.assert(
      fc.property(attemptsArb, (attempts) => {
        const { deps, uow, files, clock } = setupReceipts();
        for (const [n, attempt] of attempts.entries()) {
          clock.value = `2026-10-31T09:00:${String(n).padStart(2, "0")}.000Z`;
          addReceipt(deps, {
            bytes: jpegBytes({ seed: attempt.seed }),
            originalName: "r.jpg",
            channel: attempt.channel,
            options: attempt.input,
            probe: null,
          });
        }
        for (const row of uow.receipts.state.receipts) {
          const points = replayReceiptHistory(uow.receipts.listAudit(row.id));
          expect(points).toHaveLength(1);
          expect(points[0]).toMatchObject({ action: "create", occurredAt: row.receivedAt });
          expect(points[0]?.values).toEqual(receiptValuesOf(row));
          expect(files.has(row.currentSha256)).toBe(true);
        }
        // 履歴は追加ごとに 1 件
        expect(uow.receipts.state.audits).toHaveLength(uow.receipts.state.receipts.length);
      }),
    );
  });
});
