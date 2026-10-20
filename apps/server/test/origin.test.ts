import { describe, expect, it } from "vitest";
import {
  allowedOrigins,
  expectedOriginFor,
  isAllowedHost,
  isLocalHost,
  type RemoteSettings,
  requestHost,
  rpIdFor,
} from "../src/lib/origin.ts";

// T007: 許す Host・オリジン・RP ID の決定（R6）

const REMOTE_ON: RemoteSettings = { enabled: true, host: "mac.tail1234.ts.net" };
const REMOTE_OFF: RemoteSettings = { enabled: false, host: "mac.tail1234.ts.net" };
const REMOTE_NO_HOST: RemoteSettings = { enabled: true, host: null };

describe("isAllowedHost", () => {
  it.each(["localhost:5173", "localhost:8787", "127.0.0.1:8787"])("ローカルの %s は許す", (h) => {
    expect(isAllowedHost(h)).toBe(true);
  });

  it.each([
    "127.0.0.1:5173",
    "localhost",
    "localhost:3000",
    "evil.example.com",
    "evil.example.com:8787",
    "localhost.evil.com:5173",
    "",
  ])("%s は許さない", (h) => {
    expect(isAllowedHost(h)).toBe(false);
  });

  it("Host がない（undefined）は許さない", () => {
    expect(isAllowedHost(undefined)).toBe(false);
  });

  it("リモートが無効なら ts.net の名前は許さない（既定は無効）", () => {
    expect(isAllowedHost("mac.tail1234.ts.net")).toBe(false);
    expect(isAllowedHost("mac.tail1234.ts.net", REMOTE_OFF)).toBe(false);
    expect(isAllowedHost("mac.tail1234.ts.net", REMOTE_NO_HOST)).toBe(false);
  });

  it("リモートが有効なら登録した名前だけ許す（大文字小文字は区別しない）", () => {
    expect(isAllowedHost("mac.tail1234.ts.net", REMOTE_ON)).toBe(true);
    expect(isAllowedHost("MAC.tail1234.ts.net", REMOTE_ON)).toBe(true);
    expect(isAllowedHost("other.tail1234.ts.net", REMOTE_ON)).toBe(false);
    expect(isAllowedHost("localhost:5173", REMOTE_ON)).toBe(true);
  });
});

describe("isLocalHost", () => {
  it.each(["localhost:5173", "localhost:8787", "127.0.0.1:8787"])("%s はローカル", (h) => {
    expect(isLocalHost(h)).toBe(true);
  });
  it("ts.net の名前や未知の名前はローカルではない", () => {
    expect(isLocalHost("mac.tail1234.ts.net")).toBe(false);
    expect(isLocalHost("127.0.0.1:5173")).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });
});

describe("allowedOrigins", () => {
  it("ローカルだけ（既定）", () => {
    expect(allowedOrigins().sort()).toEqual(["http://localhost:5173", "http://localhost:8787"]);
  });
  it("リモートが有効なら https://<名前> が加わる。無効なら加わらない", () => {
    expect(allowedOrigins(REMOTE_ON)).toContain("https://mac.tail1234.ts.net");
    expect(allowedOrigins(REMOTE_ON)).toContain("http://localhost:5173");
    expect(allowedOrigins(REMOTE_OFF)).not.toContain("https://mac.tail1234.ts.net");
  });
  it("127.0.0.1:5173 のオリジンは許さない", () => {
    expect(allowedOrigins(REMOTE_ON)).not.toContain("http://127.0.0.1:5173");
  });
});

describe("rpIdFor", () => {
  it("localhost のポート違いはどちらも localhost", () => {
    expect(rpIdFor("localhost:5173")).toBe("localhost");
    expect(rpIdFor("localhost:8787")).toBe("localhost");
  });
  it("127.0.0.1 は RP ID を持たない（undefined）", () => {
    expect(rpIdFor("127.0.0.1:8787")).toBeUndefined();
  });
  it("リモートが有効なら ts.net の名前、無効なら undefined", () => {
    expect(rpIdFor("mac.tail1234.ts.net", REMOTE_ON)).toBe("mac.tail1234.ts.net");
    expect(rpIdFor("mac.tail1234.ts.net")).toBeUndefined();
    expect(rpIdFor("mac.tail1234.ts.net", REMOTE_OFF)).toBeUndefined();
  });
  it("リモートの有無で名前が変わる", () => {
    expect(rpIdFor("mac.tail1234.ts.net", { enabled: true, host: "other.tail1234.ts.net" })).toBe(
      undefined,
    );
    expect(rpIdFor("other.tail1234.ts.net", { enabled: true, host: "other.tail1234.ts.net" })).toBe(
      "other.tail1234.ts.net",
    );
  });
  it("未知の Host・undefined は undefined", () => {
    expect(rpIdFor("evil.example.com")).toBeUndefined();
    expect(rpIdFor(undefined)).toBeUndefined();
  });
});

describe("expectedOriginFor", () => {
  it("ローカルは http://<host>", () => {
    expect(expectedOriginFor("localhost:5173")).toBe("http://localhost:5173");
    expect(expectedOriginFor("localhost:8787")).toBe("http://localhost:8787");
  });
  it("ts.net の Host は https://", () => {
    expect(expectedOriginFor("mac.tail1234.ts.net", REMOTE_ON)).toBe("https://mac.tail1234.ts.net");
  });
  it("許さない Host・127.0.0.1 は undefined", () => {
    expect(expectedOriginFor("mac.tail1234.ts.net")).toBeUndefined();
    expect(expectedOriginFor("127.0.0.1:8787")).toBeUndefined();
    expect(expectedOriginFor("evil.example.com", REMOTE_ON)).toBeUndefined();
  });
});

describe("requestHost（リモートの名前の取り方は1か所。T001(b)・T016 で差し替える）", () => {
  const headers = (h: Record<string, string>) => ({
    header: (name: string) => h[name.toLowerCase()],
  });
  it("Host ヘッダーを返す", () => {
    expect(requestHost(headers({ host: "localhost:5173" }))).toBe("localhost:5173");
  });
  it("ないときは undefined", () => {
    expect(requestHost(headers({}))).toBeUndefined();
  });
});
