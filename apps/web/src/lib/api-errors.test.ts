import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { describeError } from "./api-errors";

describe("describeError", () => {
  it("UNBALANCED は借方・貸方・差額を示す", () => {
    const e = new ApiError(422, "UNBALANCED", "期首残高の借方合計と貸方合計が一致しません", {
      debit: 150000,
      credit: 120000,
      diff: 30000,
    });
    const d = describeError(e);
    expect(d.message).toBe("借方合計と貸方合計が一致しません。");
    expect(d.details).toEqual(["借方合計 150,000 円 ／ 貸方合計 120,000 円 ／ 差額 30,000 円"]);
  });

  it("TAX_SETTING_GAP はサーバーの理由を添える", () => {
    const e = new ApiError(422, "TAX_SETTING_GAP", "適用開始日が重複しています", {
      effectiveFrom: "2027-01-01",
    });
    expect(describeError(e)).toEqual({
      message: "消費税の設定の期間に空白または重複があります。",
      details: ["適用開始日が重複しています"],
    });
  });

  it("ACCOUNT_IN_USE は使用停止を案内する", () => {
    const e = new ApiError(409, "ACCOUNT_IN_USE", "使用中の科目は削除できません");
    expect(describeError(e).message).toBe(
      "この科目は仕訳や期首残高で使われているため削除できません。代わりに使用停止にしてください。",
    );
  });

  it("VALIDATION は項目ごとの理由を並べる", () => {
    const e = new ApiError(400, "VALIDATION", "入力が正しくありません", {
      issues: [
        { path: ["name"], message: "名称を入力してください" },
        { path: [], message: "変更する項目を指定してください" },
      ],
    });
    expect(describeError(e)).toEqual({
      message: "入力が正しくありません。",
      details: ["name: 名称を入力してください", "変更する項目を指定してください"],
    });
  });

  it("VALIDATION で issues がなければサーバーのメッセージを使う", () => {
    const e = new ApiError(400, "VALIDATION", "会計期間が見つかりません", { fiscalYear: "2030" });
    expect(describeError(e)).toEqual({ message: "会計期間が見つかりません", details: [] });
  });

  it("PERIOD_CLOSED は締め済みであることを示す", () => {
    const e = new ApiError(409, "PERIOD_CLOSED", "締め済みです");
    expect(describeError(e).message).toBe("締め済みの会計期間は変更できません。");
  });

  it("サーバー内部のエラーは汎用の文言", () => {
    expect(describeError(new ApiError(500, "INTERNAL", "HTTP 500")).message).toBe(
      "サーバーでエラーが発生しました。時間をおいて再度お試しください。",
    );
  });

  it("ApiError でないもの（通信の失敗）は接続できない旨", () => {
    expect(describeError(new TypeError("Failed to fetch")).message).toBe(
      "サーバーに接続できませんでした。サーバーが起動しているか確認してください。",
    );
  });

  it("RECOVERY_LOCKED は retryAfter（秒）を分に切り上げて示す", () => {
    const e = new ApiError(429, "RECOVERY_LOCKED", "しばらく試せません", { retryAfter: 61 });
    expect(describeError(e).message).toContain("約2分後");
  });

  it("認証のエラーは日本語の文言にする", () => {
    const code = (c: ConstructorParameters<typeof ApiError>[1]) =>
      describeError(new ApiError(400, c, "x")).message;
    expect(code("RECOVERY_INVALID")).toBe("回復コードが違います。");
    expect(code("LAST_PASSKEY")).toContain("最後のパスキー");
    expect(code("WEBAUTHN_FAILED")).toContain("パスキーの確認に失敗しました");
    expect(code("ALREADY_REGISTERED")).toContain("すでにパスキーが登録されています");
    expect(code("HOST_NOT_ALLOWED")).toContain("localhost");
    expect(code("UNAUTHENTICATED")).toContain("サインイン");
  });

  it("明細の取込（006）: 貼り付け・口座の対応・プレビューの変更", () => {
    const paste = describeError(
      new ApiError(422, "STATEMENT_TABLE_UNREADABLE", "x", { missingColumns: ["金額（円）"] }),
    );
    expect(paste.message).toContain("表を読み取れませんでした");
    expect(paste.details).toEqual(["見つからない列: 金額（円）"]);
    const unmapped = describeError(
      new ApiError(422, "STATEMENT_ACCOUNT_UNMAPPED", "x", { names: ["A", "B"] }),
    );
    expect(unmapped.details).toEqual(["未対応: A、B"]);
    expect(describeError(new ApiError(409, "STATEMENT_PLAN_CHANGED", "x")).message).toContain(
      "プレビューを作り直しました",
    );
  });

  it("取込元（007）: 名前の重複・見つからない", () => {
    expect(describeError(new ApiError(409, "STATEMENT_SOURCE_NAME_TAKEN", "x")).message).toContain(
      "同じ名前の取込元があります",
    );
    expect(describeError(new ApiError(404, "STATEMENT_SOURCE_NOT_FOUND", "x")).message).toContain(
      "取込元が見つかりません",
    );
  });

  it("その他のコードはサーバーのメッセージをそのまま", () => {
    const e = new ApiError(404, "ACCOUNT_NOT_FOUND", "勘定科目が見つかりません");
    expect(describeError(e)).toEqual({ message: "勘定科目が見つかりません", details: [] });
  });
});
