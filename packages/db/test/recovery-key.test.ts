import { fc } from "@trebuchet/domain/testing";
import { describe, expect, it } from "vitest";
import {
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
  RECOVERY_KEY_BYTES,
} from "../src/recovery-key.ts";

// 008 の D1: 回復キーは 160 ビットの乱数（Crockford base32、4 文字区切り）。ハッシュは保存しない

const FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/;

describe("回復キー（D1）", () => {
  it("160 ビット。8 組の 4 文字で表示する", () => {
    const { text, secret } = generateRecoveryKey();
    expect(RECOVERY_KEY_BYTES).toBe(20);
    expect(secret).toHaveLength(20);
    expect(text).toMatch(FORMAT);
  });

  it("性質: 表示と読み取りが往復する", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), (raw) => {
        const secret = Buffer.from(raw);
        const text = formatRecoveryKey(secret);
        expect(text).toMatch(FORMAT);
        expect(parseRecoveryKey(text)?.equals(secret)).toBe(true);
        expect(parseRecoveryKey(text.toLowerCase().replaceAll("-", " "))?.equals(secret)).toBe(
          true,
        );
      }),
    );
  });

  it("作るたびに違う", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateRecoveryKey().text));
    expect(seen.size).toBe(100);
  });

  it("大文字小文字・区切り・空白・読み違えやすい文字（I/L→1、O→0）を正規化する", () => {
    const secret = Buffer.alloc(20, 0);
    secret[19] = 1;
    const text = formatRecoveryKey(secret);
    expect(text).toBe("0000-0000-0000-0000-0000-0000-0000-0001");
    expect(parseRecoveryKey("oooo oooo OOOO-0000 0000_0000 0000 000i")?.equals(secret)).toBe(true);
    expect(parseRecoveryKey("0000-0000-0000-0000-0000-0000-0000-000L")?.equals(secret)).toBe(true);
  });

  it("長さ違い・表にない文字・空は null", () => {
    const { text } = generateRecoveryKey();
    expect(parseRecoveryKey(text.slice(0, -1))).toBeNull();
    expect(parseRecoveryKey(`${text}0`)).toBeNull();
    expect(parseRecoveryKey(`U${text.slice(1)}`)).toBeNull();
    expect(parseRecoveryKey("")).toBeNull();
  });

  it("20 バイトでない値は表示しない（例外）", () => {
    expect(() => formatRecoveryKey(Buffer.alloc(16))).toThrow();
  });
});
