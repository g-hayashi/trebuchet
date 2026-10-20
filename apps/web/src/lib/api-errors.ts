import { ApiError } from "./api";
import { formatYen } from "./format";

export type ErrorDescription = { message: string; details: string[] };

const asNumber = (v: unknown) => (typeof v === "number" ? v : undefined);
const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

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
    case "IMPORT_UNKNOWN_FORMAT": {
      const missing = asStrings(error.details?.missingColumns);
      return {
        message:
          error.details?.expected === "ledger"
            ? "freee の総勘定元帳として読み取れませんでした。freee から書き出した総勘定元帳の CSV を選んでください。"
            : "freee の仕訳帳として読み取れませんでした。freee から書き出した仕訳帳の CSV を選んでください。",
        details: missing.length > 0 ? [`見つからない列: ${missing.join("、")}`] : [],
      };
    }
    case "IMPORT_WRONG_KIND":
      return {
        message:
          "ファイルの種類が違います。仕訳帳と総勘定元帳を取り違えていないか確認してください。",
        details: [],
      };
    case "IMPORT_FILE_CHANGED":
      return {
        message: "プレビューの後にファイルの内容が変わりました。ファイルを選び直してください。",
        details: [],
      };
    case "IMPORT_PLAN_CHANGED":
      return {
        message:
          "プレビューの後に帳簿が変わったため、プレビューを作り直しました。内容を確かめてから、もう一度取り込んでください。",
        details: [],
      };
    case "IMPORT_NOT_READY": {
      const unmapped = asStrings(error.details?.unmapped);
      return {
        message: "まだ取り込めません。対応表と、新しく取り込む仕訳を確かめてください。",
        details: unmapped.length > 0 ? [`対応が未定: ${unmapped.join("、")}`] : [],
      };
    }
    case "IMPORT_BATCH_NOT_FOUND":
      return { message: "取込が見つかりません。", details: [] };
    case "IMPORT_BATCH_VOIDED":
      return { message: "この取込はすでに取り消されています。", details: [] };
    case "CORRECTED_JOURNALS": {
      const count = asNumber(error.details?.count);
      return {
        message: `取込の後に訂正された仕訳が${count ?? ""}件あります。確かめてから取り消してください。`,
        details: [],
      };
    }
    case "FILE_TOO_LARGE":
      return { message: "ファイルが大きすぎます（5 MB まで）。", details: [] };
    case "REPORT_LINE_INVALID":
      return { message: "決算書の欄は、費用の科目の 8〜31 から選んでください。", details: [] };
    case "ENTITY_KIND_UNSUPPORTED":
      return { message: "青色申告決算書は、個人の事業体でだけ作れます。", details: [] };
    case "UNAUTHENTICATED":
      return { message: "サインインが必要です。", details: [] };
    case "CSRF_REJECTED":
      return {
        message: "要求の送信元を確認できませんでした。画面を開き直してください。",
        details: [],
      };
    case "HOST_NOT_ALLOWED":
      return {
        message:
          "この接続先の名前では操作できません。Mac のローカルの名前（localhost）で開いてください。",
        details: [],
      };
    case "ALREADY_REGISTERED":
      return {
        message: "すでにパスキーが登録されています。サインインしてください。",
        details: [],
      };
    case "WEBAUTHN_FAILED":
      return {
        message: "パスキーの確認に失敗しました。もう一度お試しください。",
        details: [],
      };
    case "RECOVERY_INVALID":
      return { message: "回復コードが違います。", details: [] };
    case "RECOVERY_LOCKED": {
      // retryAfter は秒。画面には分で（切り上げ）示す
      const seconds = asNumber(error.details?.retryAfter);
      const minutes = seconds === undefined ? undefined : Math.max(1, Math.ceil(seconds / 60));
      return {
        message: `回復コードの失敗が続いたため、しばらく試せません。${
          minutes === undefined ? "しばらく" : `約${minutes}分`
        }後にもう一度お試しください。`,
        details: [],
      };
    }
    case "LAST_PASSKEY":
      return {
        message:
          "この Mac（localhost）の最後のパスキーは削除できません。先に別のパスキーを追加してください。",
        details: [],
      };
    case "INTERNAL":
      return {
        message: "サーバーでエラーが発生しました。時間をおいて再度お試しください。",
        details: [],
      };
    default:
      return { message: error.message, details: [] };
  }
}
