import { createHash, randomUUIDv7 } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createReceiptFileStore,
  decryptReceipt,
  encryptReceipt,
  ReceiptFileUnreadableError,
  sealReceipt,
} from "../src/receipt-files.ts";
import {
  clearDataKey,
  dataDir,
  InvalidEntityIdError,
  InvalidReceiptHashError,
  receiptFile,
  receiptsDir,
  setDataKey,
  VaultLockedError,
} from "../src/tenant-store.ts";
import { TEST_DATA_KEY, type TempDataDir, useTempDataDir } from "../src/testing.ts";

// 証憑のファイルの暗号化（TRC1。R8・R9、data-model §1.8、INV-61）。名前 = 平文の SHA-256

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("receipt-files");
});
afterEach(() => tmp.cleanup());

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dk = () => Buffer.from(TEST_DATA_KEY);
const sample = () => Buffer.from("receipt-bytes-for-test-0123456789", "utf8");

describe("encryptReceipt / decryptReceipt（TRC1）", () => {
  it("形式は TRC1 | salt(16) | nonce(12) | 暗号文 | タグ(16)。往復で元に戻る", () => {
    const entityId = randomUUIDv7();
    const plain = sample();
    const file = encryptReceipt(plain, entityId, dk());
    expect(file.subarray(0, 4).toString("ascii")).toBe("TRC1");
    expect(file.length).toBe(4 + 16 + 12 + plain.length + 16);
    expect(file.includes(plain)).toBe(false);
    const back = decryptReceipt(file, entityId, sha(plain), dk());
    expect(Buffer.from(back).equals(plain)).toBe(true);
  });

  it("同じ内容でも暗号文は毎回違う（salt・nonce が乱数）", () => {
    const entityId = randomUUIDv7();
    const a = encryptReceipt(sample(), entityId, dk());
    const b = encryptReceipt(sample(), entityId, dk());
    expect(a.equals(b)).toBe(false);
  });

  it("空のバイト列も往復する", () => {
    const entityId = randomUUIDv7();
    const file = encryptReceipt(new Uint8Array(0), entityId, dk());
    expect(decryptReceipt(file, entityId, sha(new Uint8Array(0)), dk()).length).toBe(0);
  });

  it("別の DK・別の事業体・別の名前では ReceiptFileUnreadableError", () => {
    const entityId = randomUUIDv7();
    const plain = sample();
    const file = encryptReceipt(plain, entityId, dk());
    expect(() => decryptReceipt(file, entityId, sha(plain), Buffer.alloc(32, 1))).toThrow(
      ReceiptFileUnreadableError,
    );
    expect(() => decryptReceipt(file, randomUUIDv7(), sha(plain), dk())).toThrow(
      ReceiptFileUnreadableError,
    );
    expect(() => decryptReceipt(file, entityId, "0".repeat(64), dk())).toThrow(
      ReceiptFileUnreadableError,
    );
  });

  it("事業体の ID の大文字・小文字は同じ事業体として扱う", () => {
    const entityId = randomUUIDv7();
    const plain = sample();
    const file = encryptReceipt(plain, entityId.toUpperCase(), dk());
    expect(decryptReceipt(file, entityId, sha(plain), dk()).length).toBe(plain.length);
  });

  it("GCM が通っても、平文の SHA-256 が名前と違えば失敗する（名前の取り違え）", () => {
    const entityId = randomUUIDv7();
    const other = "f".repeat(64);
    // 名前 other の AAD で別の中身を封じた（作為的な差し替え）
    const file = sealReceipt(sample(), entityId, other, dk());
    expect(() => decryptReceipt(file, entityId, other, dk())).toThrow(ReceiptFileUnreadableError);
  });

  it("短すぎる・形式が違うファイルは失敗する", () => {
    const entityId = randomUUIDv7();
    expect(() => decryptReceipt(Buffer.alloc(0), entityId, "0".repeat(64), dk())).toThrow(
      ReceiptFileUnreadableError,
    );
    expect(() => decryptReceipt(Buffer.alloc(100), entityId, "0".repeat(64), dk())).toThrow(
      ReceiptFileUnreadableError,
    );
  });

  it("DK は 32 バイトだけ", () => {
    expect(() => encryptReceipt(sample(), randomUUIDv7(), Buffer.alloc(16))).toThrow(RangeError);
  });
});

describe("置き場所（receiptsDir・receiptFile）", () => {
  it("<データ場所>/receipts/<entityId 小文字>/<sha256>.trc。tenants/ の下に置かない", () => {
    const entityId = randomUUIDv7();
    const hash = "ab".repeat(32);
    expect(receiptsDir(entityId.toUpperCase())).toBe(join(dataDir(), "receipts", entityId));
    expect(receiptFile(entityId, hash)).toBe(join(dataDir(), "receipts", entityId, `${hash}.trc`));
  });

  it("entityId と sha256 の形を検査する（パストラバーサル）", () => {
    expect(() => receiptsDir("../x")).toThrow(InvalidEntityIdError);
    expect(() => receiptFile(randomUUIDv7(), "../../etc/passwd")).toThrow(InvalidReceiptHashError);
    expect(() => receiptFile(randomUUIDv7(), "A".repeat(64))).toThrow(InvalidReceiptHashError);
    expect(() => receiptFile(randomUUIDv7(), "a".repeat(63))).toThrow(InvalidReceiptHashError);
  });
});

describe("createReceiptFileStore", () => {
  it("put → has → read。名前 = 平文の SHA-256 で、ディスクに平文を残さず、.partial も残さない", () => {
    const entityId = randomUUIDv7();
    const store = createReceiptFileStore(entityId);
    const plain = sample();
    const hash = store.digest(plain);
    expect(hash).toBe(sha(plain));
    expect(store.has(hash)).toBe(false);
    store.put(hash, plain);
    expect(store.has(hash)).toBe(true);
    expect(Buffer.from(store.read(hash)).equals(plain)).toBe(true);

    const names = readdirSync(receiptsDir(entityId));
    expect(names).toEqual([`${hash}.trc`]);
    const onDisk = readFileSync(receiptFile(entityId, hash));
    expect(onDisk.includes(plain)).toBe(false);
    expect(onDisk.subarray(0, 4).toString("ascii")).toBe("TRC1");
  });

  it("同じ名前があれば何もしない（ファイルは書き換わらない）", () => {
    const entityId = randomUUIDv7();
    const store = createReceiptFileStore(entityId);
    const plain = sample();
    const hash = store.digest(plain);
    store.put(hash, plain);
    const first = readFileSync(receiptFile(entityId, hash));
    store.put(hash, plain);
    expect(readFileSync(receiptFile(entityId, hash)).equals(first)).toBe(true);
  });

  it("名前と中身のハッシュが違う put は拒み、何も残さない", () => {
    const entityId = randomUUIDv7();
    const store = createReceiptFileStore(entityId);
    expect(() => store.put("e".repeat(64), sample())).toThrow();
    expect(existsSync(receiptFile(entityId, "e".repeat(64)))).toBe(false);
    expect(existsSync(receiptsDir(entityId)) ? readdirSync(receiptsDir(entityId)) : []).toEqual([]);
  });

  it("別の事業体は同じ名前を読めない（置き場所も鍵も別）", () => {
    const a = createReceiptFileStore(randomUUIDv7());
    const b = createReceiptFileStore(randomUUIDv7());
    const plain = sample();
    const hash = a.digest(plain);
    a.put(hash, plain);
    expect(b.has(hash)).toBe(false);
    expect(() => b.read(hash)).toThrow(ReceiptFileUnreadableError);
  });

  it("ファイルの 1 バイトの改ざん・切り詰め・欠けは ReceiptFileUnreadableError", () => {
    const entityId = randomUUIDv7();
    const store = createReceiptFileStore(entityId);
    const plain = sample();
    const hash = store.digest(plain);
    store.put(hash, plain);
    const path = receiptFile(entityId, hash);
    const original = readFileSync(path);

    const flipped = Buffer.from(original);
    flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 0x01;
    writeFileSync(path, flipped);
    expect(() => store.read(hash)).toThrow(ReceiptFileUnreadableError);

    writeFileSync(path, original.subarray(0, original.length - 1));
    expect(() => store.read(hash)).toThrow(ReceiptFileUnreadableError);

    writeFileSync(path, original);
    expect(Buffer.from(store.read(hash)).equals(plain)).toBe(true);

    store.discard(hash);
    expect(store.has(hash)).toBe(false);
    expect(() => store.read(hash)).toThrow(ReceiptFileUnreadableError);
  });

  it("discard は追加の後始末。無い名前でも例外にしない", () => {
    const store = createReceiptFileStore(randomUUIDv7());
    expect(() => store.discard("d".repeat(64))).not.toThrow();
  });

  it("施錠中は has・put・read が VaultLockedError（鍵を作らず、ファイルも触らない）", () => {
    const entityId = randomUUIDv7();
    const store = createReceiptFileStore(entityId);
    const plain = sample();
    const hash = store.digest(plain);
    store.put(hash, plain);
    clearDataKey();
    expect(() => store.has(hash)).toThrow(VaultLockedError);
    expect(() => store.put(store.digest(Buffer.from("x")), Buffer.from("x"))).toThrow(
      VaultLockedError,
    );
    expect(() => store.read(hash)).toThrow(VaultLockedError);
    expect(readdirSync(receiptsDir(entityId))).toEqual([`${hash}.trc`]);
    // 解錠すれば読める（DK は同じ）
    setDataKey(Buffer.from(TEST_DATA_KEY));
    expect(Buffer.from(store.read(hash)).equals(plain)).toBe(true);
  });

  it("別の DK で解錠したら読めない（誤った鍵で平文を返さない）", () => {
    const entityId = randomUUIDv7();
    const store = createReceiptFileStore(entityId);
    const plain = sample();
    const hash = store.digest(plain);
    store.put(hash, plain);
    clearDataKey();
    setDataKey(Buffer.alloc(32, 0x11));
    expect(() => store.read(hash)).toThrow(ReceiptFileUnreadableError);
  });

  it("エラーに鍵・平文を含めない", () => {
    const entityId = randomUUIDv7();
    const store = createReceiptFileStore(entityId);
    let message = "";
    try {
      store.read("c".repeat(64));
    } catch (e) {
      message = String(e instanceof Error ? e.message : e);
    }
    expect(message).not.toContain(Buffer.from(TEST_DATA_KEY).toString("hex"));
    expect(message).not.toContain(Buffer.from(TEST_DATA_KEY).toString("base64"));
  });
});
