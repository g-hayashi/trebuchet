import { createHash } from "node:crypto";
import { fc } from "@trebuchet/domain/testing";
import { describe, expect, it } from "vitest";
import {
  decryptReceipt,
  encryptReceipt,
  ReceiptFileUnreadableError,
} from "../src/receipt-files.ts";

// INV-61: 往復で元に戻り、1 バイトの変更・切り詰め・別の DK・別の事業体・別の名前では平文を返さない

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesArb = fc.uint8Array({ minLength: 0, maxLength: 600 });
const dkArb = fc.uint8Array({ minLength: 32, maxLength: 32 });
const entityArb = fc.uuid();

describe("INV-61（ファイルの暗号化）", () => {
  it("decrypt(encrypt(bytes)) = bytes", () => {
    fc.assert(
      fc.property(bytesArb, entityArb, dkArb, (bytes, entityId, dk) => {
        const file = encryptReceipt(bytes, entityId, dk);
        const back = decryptReceipt(file, entityId, sha(bytes), dk);
        expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
      }),
    );
  });

  it("暗号文のどの 1 バイトを変えても失敗する", () => {
    fc.assert(
      fc.property(
        bytesArb,
        entityArb,
        dkArb,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (bytes, entityId, dk, at, mask) => {
          const file = Buffer.from(encryptReceipt(bytes, entityId, dk));
          const i = at % file.length;
          file[i] = (file[i] ?? 0) ^ mask;
          expect(() => decryptReceipt(file, entityId, sha(bytes), dk)).toThrow(
            ReceiptFileUnreadableError,
          );
        },
      ),
    );
  });

  it("どこで切り詰めても失敗する", () => {
    fc.assert(
      fc.property(bytesArb, entityArb, dkArb, fc.nat(), (bytes, entityId, dk, at) => {
        const file = encryptReceipt(bytes, entityId, dk);
        const cut = file.subarray(0, at % file.length);
        expect(() => decryptReceipt(cut, entityId, sha(bytes), dk)).toThrow(
          ReceiptFileUnreadableError,
        );
      }),
    );
  });

  it("別の DK・別の事業体・別の名前では失敗する", () => {
    fc.assert(
      fc.property(bytesArb, entityArb, entityArb, dkArb, dkArb, (bytes, a, b, dk1, dk2) => {
        fc.pre(a !== b && !Buffer.from(dk1).equals(Buffer.from(dk2)));
        const file = encryptReceipt(bytes, a, dk1);
        const name = sha(bytes);
        expect(() => decryptReceipt(file, a, name, dk2)).toThrow(ReceiptFileUnreadableError);
        expect(() => decryptReceipt(file, b, name, dk1)).toThrow(ReceiptFileUnreadableError);
        const other = name.startsWith("0") ? `1${name.slice(1)}` : `0${name.slice(1)}`;
        expect(() => decryptReceipt(file, a, other, dk1)).toThrow(ReceiptFileUnreadableError);
      }),
    );
  });
});
