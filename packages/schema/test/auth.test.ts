import { describe, expect, it } from "vitest";
import {
  AuthEvent,
  AuthEventKind,
  AuthStatus,
  ErrorCode,
  PairingIssueResult,
  PairingRegisterOptionsInput,
  PairingRegisterVerifyInput,
  PasskeyRenameInput,
  PasskeyView,
  RecoveryVerifyInput,
  RegisterVerifyInput,
  RemoteSettings,
  SessionView,
} from "../src/index.ts";

const ID = "0190f3a0-0000-7000-8000-000000000001";
const NOW = "2026-10-20T00:00:00.000Z";

describe("ErrorCode（004 のコード、contracts/http-api.md）", () => {
  const added = [
    "UNAUTHENTICATED",
    "CSRF_REJECTED",
    "HOST_NOT_ALLOWED",
    "ALREADY_REGISTERED",
    "WEBAUTHN_FAILED",
    "RECOVERY_INVALID",
    "LAST_PASSKEY",
    "BACKUP_FOLDER_NOT_FOUND",
    "BACKUP_NOT_CONFIGURED",
    "BACKUP_RUNNING",
    "BACKUP_INVALID",
    "BACKUP_VERSION_MISMATCH",
    "REMOTE_HOST_INVALID",
    "REMOTE_NOT_CONFIGURED",
    "PAIRING_TOKEN_INVALID",
  ];
  it("追加の15種がすべて入っている", () => {
    expect(new Set(added).size).toBe(15);
    for (const code of added) expect(ErrorCode.safeParse(code).success).toBe(true);
  });
  it("008: パスフレーズのコード（PASSPHRASE_*）はなくした（バックアップの鍵は DK から。D9）", () => {
    for (const code of ["PASSPHRASE_TOO_SHORT", "PASSPHRASE_MISMATCH", "PASSPHRASE_WRONG"]) {
      expect(ErrorCode.safeParse(code).success, code).toBe(false);
    }
  });
  it("008: LOCKED・PRF_UNSUPPORTED・REAUTH_REQUIRED を足し、RECOVERY_LOCKED（ロック）はなくした", () => {
    for (const code of ["LOCKED", "PRF_UNSUPPORTED", "REAUTH_REQUIRED"]) {
      expect(ErrorCode.safeParse(code).success, code).toBe(true);
    }
    expect(ErrorCode.safeParse("RECOVERY_LOCKED").success).toBe(false);
  });
  it("BACKUP_TOO_NEW は作らない", () => {
    expect(ErrorCode.safeParse("BACKUP_TOO_NEW").success).toBe(false);
  });
  it("既存の FILE_TOO_LARGE は残っている", () => {
    expect(ErrorCode.safeParse("FILE_TOO_LARGE").success).toBe(true);
  });
});

describe("AuthEventKind", () => {
  it("13種", () => {
    expect(AuthEventKind.options).toHaveLength(13);
    expect([...AuthEventKind.options].sort()).toEqual(
      [
        "register",
        "sign_in",
        "sign_in_failed",
        "recovery_used",
        "recovery_failed",
        "recovery_regenerated",
        "passkey_renamed",
        "passkey_deleted",
        "session_revoked",
        "sign_out",
        "pairing_issued",
        "pairing_used",
        "remote_settings_changed",
      ].sort(),
    );
  });
  it("範囲外を拒否する", () => {
    expect(AuthEventKind.safeParse("pre_restore").success).toBe(false);
  });
});

describe("AuthEvent", () => {
  const ok = {
    id: ID,
    occurredAt: NOW,
    kind: "sign_in",
    rpId: "localhost",
    passkeyId: ID,
    sessionId: ID,
    userAgent: "Mozilla/5.0",
    detail: null,
  };
  it("受け付ける（NULL 可の列は null でよい）", () => {
    expect(AuthEvent.safeParse(ok).success).toBe(true);
    expect(
      AuthEvent.safeParse({
        ...ok,
        rpId: null,
        passkeyId: null,
        sessionId: null,
        userAgent: null,
        detail: { reason: "x" },
      }).success,
    ).toBe(true);
  });
  it("kind が範囲外なら拒否する", () => {
    expect(AuthEvent.safeParse({ ...ok, kind: "nope" }).success).toBe(false);
  });
});

describe("AuthStatus", () => {
  const remote = { enabled: false, host: null };
  it("サインイン前は recoveryAcknowledged が null", () => {
    expect(
      AuthStatus.safeParse({
        registered: true,
        signedIn: false,
        rpId: "localhost",
        remote,
        recoveryAcknowledged: null,
      }).success,
    ).toBe(true);
  });
  it("サインイン中は boolean", () => {
    for (const recoveryAcknowledged of [true, false]) {
      expect(
        AuthStatus.safeParse({
          registered: true,
          signedIn: true,
          rpId: "localhost",
          remote: { enabled: true, host: "a.b.ts.net" },
          recoveryAcknowledged,
        }).success,
      ).toBe(true);
    }
  });
  it("recoveryAcknowledged の欠落を拒否する", () => {
    expect(
      AuthStatus.safeParse({ registered: true, signedIn: false, rpId: "localhost", remote })
        .success,
    ).toBe(false);
  });
});

describe("PasskeyView / SessionView", () => {
  it("PasskeyView は lastUsedAt が null でもよい", () => {
    const v = { id: ID, name: "MacBook", rpId: "localhost", createdAt: NOW, lastUsedAt: null };
    expect(PasskeyView.safeParse(v).success).toBe(true);
    expect(PasskeyView.safeParse({ ...v, lastUsedAt: NOW }).success).toBe(true);
    expect(PasskeyView.safeParse({ ...v, lastUsedAt: undefined }).success).toBe(false);
  });
  it("SessionView", () => {
    const v = {
      id: ID,
      rpId: "localhost",
      userAgent: "x",
      createdAt: NOW,
      lastSeenAt: NOW,
      current: true,
    };
    expect(SessionView.safeParse(v).success).toBe(true);
    expect(SessionView.safeParse({ ...v, userAgent: null }).success).toBe(true);
    expect(SessionView.safeParse({ ...v, current: undefined }).success).toBe(false);
  });
});

describe("入力（空の name・code・token は拒否）", () => {
  const response = { id: "abc", type: "public-key" };
  it("RegisterVerifyInput", () => {
    expect(RegisterVerifyInput.safeParse({ response }).success).toBe(true);
    expect(RegisterVerifyInput.safeParse({ response, name: "MacBook" }).success).toBe(true);
    expect(RegisterVerifyInput.safeParse({ response, name: "" }).success).toBe(false);
    expect(RegisterVerifyInput.safeParse({ name: "MacBook" }).success).toBe(false);
  });
  it("RecoveryVerifyInput", () => {
    expect(RecoveryVerifyInput.safeParse({ code: "ABCD-EFGH" }).success).toBe(true);
    expect(RecoveryVerifyInput.safeParse({ code: "" }).success).toBe(false);
  });
  it("PasskeyRenameInput", () => {
    expect(PasskeyRenameInput.safeParse({ name: "iPhone" }).success).toBe(true);
    expect(PasskeyRenameInput.safeParse({ name: "" }).success).toBe(false);
  });
  it("PairingRegisterOptionsInput", () => {
    expect(PairingRegisterOptionsInput.safeParse({ token: "t" }).success).toBe(true);
    expect(PairingRegisterOptionsInput.safeParse({ token: "" }).success).toBe(false);
  });
  it("PairingRegisterVerifyInput", () => {
    expect(PairingRegisterVerifyInput.safeParse({ token: "t", response }).success).toBe(true);
    expect(
      PairingRegisterVerifyInput.safeParse({ token: "t", response, name: "iPhone" }).success,
    ).toBe(true);
    expect(PairingRegisterVerifyInput.safeParse({ token: "", response }).success).toBe(false);
    expect(PairingRegisterVerifyInput.safeParse({ token: "t", response, name: "" }).success).toBe(
      false,
    );
    expect(PairingRegisterVerifyInput.safeParse({ token: "t" }).success).toBe(false);
  });
});

describe("PairingIssueResult", () => {
  it("token・url・expiresAt", () => {
    const v = { token: "t", url: "https://a.b.ts.net/pair?token=t", expiresAt: NOW };
    expect(PairingIssueResult.safeParse(v).success).toBe(true);
    expect(PairingIssueResult.safeParse({ token: "t", url: v.url }).success).toBe(false);
  });
});

describe("RemoteSettings", () => {
  it("host は *.ts.net の形（a.b.ts.net は可）", () => {
    expect(RemoteSettings.safeParse({ enabled: true, host: "a.b.ts.net" }).success).toBe(true);
    expect(RemoteSettings.safeParse({ enabled: false, host: "a.b.ts.net" }).success).toBe(true);
  });
  it.each(["example.com", "ts.net", ".ts.net", "a.ts.net.evil.com", "a b.ts.net", "", "a.ts.netx"])(
    "host %s は拒否する",
    (host) => {
      expect(RemoteSettings.safeParse({ enabled: true, host }).success).toBe(false);
      expect(RemoteSettings.safeParse({ enabled: false, host }).success).toBe(false);
    },
  );
  it("enabled が false のとき host は null 可、true のときは不可", () => {
    expect(RemoteSettings.safeParse({ enabled: false, host: null }).success).toBe(true);
    expect(RemoteSettings.safeParse({ enabled: true, host: null }).success).toBe(false);
  });
});
