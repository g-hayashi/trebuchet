import { ApiError } from "./api";
import { formatYen } from "./format";

export type ErrorDescription = { message: string; details: string[] };

const asNumber = (v: unknown) => (typeof v === "number" ? v : undefined);

function validationIssues(details: Record<string, unknown> | undefined): string[] {
  const issues = details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) => {
    if (typeof issue !== "object" || issue === null) return [];
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== "string") return [];
    const where = Array.isArray(path) && path.length > 0 ? `${path.join(".")}: ` : "";
    return [`${where}${message}`];
  });
}

/** API のエラーを、画面に出す日本語の文言にする */
export function describeError(error: unknown): ErrorDescription {
  if (!(error instanceof ApiError)) {
    return {
      message: "サーバーに接続できませんでした。サーバーが起動しているか確認してください。",
      details: [],
    };
  }
  switch (error.code) {
    case "UNBALANCED": {
      const debit = asNumber(error.details?.debit);
      const credit = asNumber(error.details?.credit);
      const diff = asNumber(error.details?.diff);
      return {
        message: "借方合計と貸方合計が一致しません。",
        details:
          debit === undefined || credit === undefined || diff === undefined
            ? []
            : [
                `借方合計 ${formatYen(debit)} 円 ／ 貸方合計 ${formatYen(credit)} 円 ／ 差額 ${formatYen(diff)} 円`,
              ],
      };
    }
    case "TAX_SETTING_GAP":
      return {
        message: "消費税の設定の期間に空白または重複があります。",
        details: [error.message],
      };
    case "ACCOUNT_IN_USE":
      return {
        message:
          "この科目は仕訳や期首残高で使われているため削除できません。代わりに使用停止にしてください。",
        details: [],
      };
    case "PERIOD_CLOSED":
      return { message: "締め済みの会計期間は変更できません。", details: [] };
    case "ENTITY_NOT_FOUND":
      return { message: "事業体が見つかりません。", details: [] };
    case "VALIDATION": {
      const issues = validationIssues(error.details);
      return issues.length > 0
        ? { message: "入力が正しくありません。", details: issues }
        : { message: error.message, details: [] };
    }
    case "INTERNAL":
      return {
        message: "サーバーでエラーが発生しました。時間をおいて再度お試しください。",
        details: [],
      };
    default:
      return { message: error.message, details: [] };
  }
}
