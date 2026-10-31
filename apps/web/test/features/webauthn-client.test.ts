import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  createCredential,
  decodePrfInputs,
  encodePrfOutputs,
  getAssertion,
} from "@/features/auth/webauthn-client";

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(startRegistration).mockReset();
  vi.mocked(startAuthentication).mockReset();
});

describe("base64url", () => {
  it("'-' と '_' を含む値を、往復して元に戻す", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 1]);
    const text = bytesToBase64Url(bytes);
    expect(text).toBe("-__-AQ");
    expect(Array.from(base64UrlToBytes(text))).toEqual([0xfb, 0xff, 0xfe, 1]);
  });

  it("ArrayBuffer と TypedArray の一部分（byteOffset つき）を受ける", () => {
    expect(bytesToBase64Url(new Uint8Array([1, 2, 3]).buffer)).toBe("AQID");
    const whole = new Uint8Array([9, 1, 2, 3, 9]);
    expect(bytesToBase64Url(whole.subarray(1, 4))).toBe("AQID");
  });
});

describe("decodePrfInputs", () => {
  it("eval.first と evalByCredential の値を bytes にし、元の options は変えない", () => {
    const options = {
      challenge: "c",
      extensions: {
        prf: {
          eval: { first: "AQID" },
          evalByCredential: { credA: { first: "BAUG" } },
        },
      },
    };
    const decoded = decodePrfInputs(options) as unknown as {
      challenge: string;
      extensions: {
        prf: {
          eval: { first: Uint8Array };
          evalByCredential: Record<string, { first: Uint8Array }>;
        };
      };
    };
    expect(decoded.challenge).toBe("c");
    expect(Array.from(decoded.extensions.prf.eval.first)).toEqual([1, 2, 3]);
    expect(Array.from(decoded.extensions.prf.evalByCredential.credA?.first ?? [])).toEqual([
      4, 5, 6,
    ]);
    expect(options.extensions.prf.eval.first).toBe("AQID");
  });

  it("PRF の指定がなければ、同じ options を返す", () => {
    const options = { challenge: "c", extensions: {} };
    expect(decodePrfInputs(options)).toBe(options);
    const bare = { challenge: "c" };
    expect(decodePrfInputs(bare)).toBe(bare);
  });
});

describe("encodePrfOutputs", () => {
  it("clientExtensionResults.prf.results.first の bytes を base64url にし、ほかは残す", () => {
    const response = {
      id: "cred",
      clientExtensionResults: {
        prf: { enabled: true, results: { first: new Uint8Array([1, 2, 3]).buffer } },
      },
    };
    expect(encodePrfOutputs(response)).toEqual({
      id: "cred",
      clientExtensionResults: { prf: { enabled: true, results: { first: "AQID" } } },
    });
  });

  it("PRF の出力がなければ、同じ応答を返す", () => {
    const response = { id: "cred", clientExtensionResults: { prf: { enabled: true } } };
    expect(encodePrfOutputs(response)).toBe(response);
  });
});

describe("createCredential / getAssertion", () => {
  it("options の PRF の値を bytes にして渡し、結果の PRF の出力を base64url にして返す", async () => {
    vi.mocked(startRegistration).mockResolvedValue({
      id: "cred",
      clientExtensionResults: { prf: { enabled: true } },
    } as never);
    vi.mocked(startAuthentication).mockResolvedValue({
      id: "cred",
      clientExtensionResults: { prf: { results: { first: new Uint8Array([1, 2, 3]).buffer } } },
    } as never);

    const created = await createCredential({ extensions: { prf: { eval: { first: "AQID" } } } });
    const registrationArg = vi.mocked(startRegistration).mock.calls[0]?.[0] as unknown as {
      optionsJSON: { extensions: { prf: { eval: { first: Uint8Array } } } };
    };
    expect(Array.from(registrationArg.optionsJSON.extensions.prf.eval.first)).toEqual([1, 2, 3]);
    expect(created).toEqual({ id: "cred", clientExtensionResults: { prf: { enabled: true } } });

    const asserted = await getAssertion({
      extensions: { prf: { evalByCredential: { cred: { first: "AQID" } } } },
    });
    const authArg = vi.mocked(startAuthentication).mock.calls[0]?.[0] as unknown as {
      optionsJSON: {
        extensions: { prf: { evalByCredential: { cred: { first: Uint8Array } } } };
      };
    };
    expect(Array.from(authArg.optionsJSON.extensions.prf.evalByCredential.cred.first)).toEqual([
      1, 2, 3,
    ]);
    expect(asserted).toEqual({
      id: "cred",
      clientExtensionResults: { prf: { results: { first: "AQID" } } },
    });
  });
});
