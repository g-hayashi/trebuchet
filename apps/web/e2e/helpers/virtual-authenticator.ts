import type { CDPSession, Page } from "@playwright/test";

/** `WebAuthn.getCredentials` が返し、`WebAuthn.addCredential` に渡せる形（CDP の Credential） */
export type StoredCredential = {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
};

/**
 * Chromium の仮想の認証器（R15）。パスキーの登録とサインインを、ブラウザの確認の画面なしで通す。
 * 認証器はページの CDP セッションに結びつく。テストごとに新しいページになるので、
 * テストをまたぐときは `credentials()` で取り出して、次のテストの `addCredentials()` で戻す
 */
export class VirtualAuthenticator {
  private readonly cdp: CDPSession;
  private authenticatorId: string;

  private constructor(cdp: CDPSession, authenticatorId: string) {
    this.cdp = cdp;
    this.authenticatorId = authenticatorId;
  }

  static async attach(page: Page): Promise<VirtualAuthenticator> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    return new VirtualAuthenticator(cdp, await VirtualAuthenticator.add(cdp));
  }

  private static async add(cdp: CDPSession): Promise<string> {
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return authenticatorId;
  }

  /** いまの認証器が持つパスキー（署名回数を含む。サインインのたびに増える） */
  async credentials(): Promise<StoredCredential[]> {
    const { credentials } = await this.cdp.send("WebAuthn.getCredentials", {
      authenticatorId: this.authenticatorId,
    });
    return credentials;
  }

  async addCredentials(credentials: StoredCredential[]): Promise<void> {
    for (const credential of credentials) {
      await this.cdp.send("WebAuthn.addCredential", {
        authenticatorId: this.authenticatorId,
        credential,
      });
    }
  }

  /**
   * 空の認証器に取り替える（別の端末を模す）。回復コードでの登録は、サーバーが既存のパスキーを
   * excludeCredentials に入れるので、同じ認証器のままでは登録が InvalidStateError で失敗する
   */
  async replace(): Promise<void> {
    await this.cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: this.authenticatorId,
    });
    this.authenticatorId = await VirtualAuthenticator.add(this.cdp);
  }
}
