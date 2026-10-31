import type { CDPSession, Page } from "@playwright/test";

/**
 * Chromium の仮想の認証器（R15）。パスキーの登録と解錠を、ブラウザの確認の画面なしで通す。
 * PRF 拡張に対応する（`hasPrf: true`）。この PRF の出力で、データ鍵を包んだものを開く（008）。
 *
 * 認証器はページの CDP セッションに結びつく。テストごとに新しいページ（空の認証器）になる。
 * パスキーを書き出して次のテストで戻すやり方は使えない（`addCredential` で戻したパスキーは PRF の秘密を
 * 持たず、PRF の出力が変わる）。テストの間は回復キーを引き継ぐ（`helpers/auth.ts` の `enterVault`）
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
        hasPrf: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return authenticatorId;
  }

  /** いまの認証器が持つパスキーの数 */
  async credentialCount(): Promise<number> {
    const { credentials } = await this.cdp.send("WebAuthn.getCredentials", {
      authenticatorId: this.authenticatorId,
    });
    return credentials.length;
  }

  /**
   * 空の認証器に取り替える（別の端末を模す）。回復キーでの登録は、server が既存のパスキーを
   * excludeCredentials に入れるので、同じ認証器のままでは登録が InvalidStateError で失敗する
   */
  async replace(): Promise<void> {
    await this.cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: this.authenticatorId,
    });
    this.authenticatorId = await VirtualAuthenticator.add(this.cdp);
  }
}
