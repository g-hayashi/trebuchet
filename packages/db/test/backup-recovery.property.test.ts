import { randomBytes } from "node:crypto";
import { fc } from "@trebuchet/domain/testing";
import { describe, expect, it } from "vitest";
import { decryptBackupWithRecoveryKey, encryptBackup } from "../src/backup/crypto.ts";
import { recoveryFixture } from "./backup-fixtures.ts";

const VERSION = { registry: 3, tenant: 5 };
const archive = Buffer.from("アーカイブの平文 ".repeat(20));
const base = { appVersion: VERSION, macId: "mac-0001", createdAt: "2026-10-31T09:00:00.000Z" };

const dkArb = fc.uint8Array({ minLength: 32, maxLength: 32 });

/**
 * INV-54: バックアップは、そのときの回復キーでも、取った時点の回復キーでも復号できる。
 * 誤った鍵では本体を 1 バイトも使わずに失敗する
 */
describe("INV-54: 回復キーでの復号", () => {
  it("取った時点の回復キー（ヘッダーの包み）でも、再発行後の今の回復キー（今の包み）でも復号できる", () => {
    fc.assert(
      fc.property(dkArb, (dkBytes) => {
        const dk = Buffer.from(dkBytes);
        const atBackup = recoveryFixture(dk);
        const reissued = recoveryFixture(dk); // 再発行後の回復キー（DK は同じ）
        const file = encryptBackup(archive, dk, { ...base, recoveryWrap: atBackup.wrap });

        const byOld = decryptBackupWithRecoveryKey(file, atBackup.text, VERSION);
        expect(byOld.ok).toBe(true);
        if (byOld.ok) {
          expect(byOld.value.archive.equals(archive)).toBe(true);
          expect(byOld.value.dk.equals(dk)).toBe(true);
          expect(byOld.value.header.macId).toBe("mac-0001");
        }
        // 再発行後の回復キーは、ヘッダーの包みでは開かない。今の包み（auth.sqlite の recovery）を渡すと開く
        expect(decryptBackupWithRecoveryKey(file, reissued.text, VERSION).ok).toBe(false);
        const byCurrent = decryptBackupWithRecoveryKey(file, reissued.text, VERSION, [
          reissued.wrap,
        ]);
        expect(byCurrent.ok).toBe(true);
        if (byCurrent.ok) {
          expect(byCurrent.value.archive.equals(archive)).toBe(true);
          // どの包みで開けたかを返す（復元後の auth.sqlite の recovery の包みにする）
          expect(Buffer.from(byCurrent.value.recoveryWrap.wrapped)).toEqual(
            Buffer.from(reissued.wrap.wrapped),
          );
        }
      }),
      { numRuns: 30 },
    );
  });

  it("回復キーの表記ゆれ（小文字・区切りなし）も受ける", () => {
    const dk = randomBytes(32);
    const r = recoveryFixture(dk);
    const file = encryptBackup(archive, dk, { ...base, recoveryWrap: r.wrap });
    expect(decryptBackupWithRecoveryKey(file, r.text.toLowerCase(), VERSION).ok).toBe(true);
    expect(decryptBackupWithRecoveryKey(file, r.text.replaceAll("-", " "), VERSION).ok).toBe(true);
  });

  it("誤った回復キー・別の DK の包み・形の違うキーは INVALID で、本体を 1 バイトも返さない", () => {
    fc.assert(
      fc.property(dkArb, dkArb, (a, b) => {
        const dk = Buffer.from(a);
        fc.pre(!dk.equals(Buffer.from(b)));
        const mine = recoveryFixture(dk);
        const stranger = recoveryFixture(dk); // 同じ DK の別のキー（包みは渡さない）
        const otherDk = recoveryFixture(Buffer.from(b)); // 別の DK とそのキー
        const file = encryptBackup(archive, dk, { ...base, recoveryWrap: mine.wrap });
        for (const attempt of [
          decryptBackupWithRecoveryKey(file, stranger.text, VERSION),
          // 別の DK の包みを開けても、本体の鍵が違うので失敗する
          decryptBackupWithRecoveryKey(file, otherDk.text, VERSION, [otherDk.wrap]),
          decryptBackupWithRecoveryKey(file, "not a recovery key", VERSION),
          decryptBackupWithRecoveryKey(file, "", VERSION),
        ]) {
          expect(attempt).toEqual({ ok: false, error: "INVALID" });
        }
      }),
      { numRuns: 30 },
    );
  });

  it("包みや本体を 1 バイトでも書き換えたファイルは、正しい回復キーでも失敗する", () => {
    const dk = randomBytes(32);
    const r = recoveryFixture(dk);
    const file = encryptBackup(archive, dk, { ...base, recoveryWrap: r.wrap });
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }).map((n) => n % file.length),
        fc.integer({ min: 1, max: 255 }),
        (index, mask) => {
          const mutated = Buffer.from(file);
          mutated[index] = (mutated[index] ?? 0) ^ mask;
          const result = decryptBackupWithRecoveryKey(mutated, r.text, VERSION);
          expect(result.ok).toBe(false);
          expect(JSON.stringify(result)).not.toContain("アーカイブ");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("復号が通った後で版が違えば VERSION_MISMATCH。誤った回復キーなら版の違いを教えない", () => {
    const dk = randomBytes(32);
    const r = recoveryFixture(dk);
    const file = encryptBackup(archive, dk, {
      ...base,
      appVersion: { registry: 4, tenant: 5 },
      recoveryWrap: r.wrap,
    });
    expect(decryptBackupWithRecoveryKey(file, r.text, VERSION)).toEqual({
      ok: false,
      error: "VERSION_MISMATCH",
    });
    expect(decryptBackupWithRecoveryKey(file, recoveryFixture(dk).text, VERSION)).toEqual({
      ok: false,
      error: "INVALID",
    });
  });
});
