import { describe, expect, it } from "vitest";
import { canDeletePasskey } from "../../src/auth/passkeys.ts";

const pk = (id: string, rpId: string) => ({ id, rpId });

describe("canDeletePasskey（data-model §1.1）", () => {
  it("localhost の 1 つだけは削除できない", () => {
    expect(canDeletePasskey([pk("a", "localhost")], "a")).toBe(false);
  });

  it("localhost が 2 つあれば削除できる", () => {
    const list = [pk("a", "localhost"), pk("b", "localhost")];
    expect(canDeletePasskey(list, "a")).toBe(true);
    expect(canDeletePasskey(list, "b")).toBe(true);
  });

  it("ts.net の名前のパスキーは 1 つだけでも削除できる", () => {
    expect(canDeletePasskey([pk("a", "mac.tail1234.ts.net")], "a")).toBe(true);
  });

  it("localhost 1 つ + ts.net 1 つ: ts.net は消せるが localhost は消せない", () => {
    const list = [pk("a", "localhost"), pk("b", "mac.tail1234.ts.net")];
    expect(canDeletePasskey(list, "a")).toBe(false);
    expect(canDeletePasskey(list, "b")).toBe(true);
  });

  it("存在しない id は false", () => {
    expect(canDeletePasskey([pk("a", "localhost"), pk("b", "localhost")], "zzz")).toBe(false);
    expect(canDeletePasskey([], "a")).toBe(false);
  });
});
