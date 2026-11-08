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
    case "ACCOUNT_SYSTEM_PROTECTED":
      return {
        message:
          "最初からある科目は名前の変更も削除もできません。使わないときは使用停止にしてください。",
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
    case "FILE_TOO_LARGE": {
      const maxBytes = asNumber(error.details?.maxBytes);
      const limit = maxBytes === undefined ? 5 : Math.round(maxBytes / (1024 * 1024));
      return { message: `ファイルが大きすぎます（${limit} MB まで）。`, details: [] };
    }
    case "BACKUP_INVALID":
      return {
        message: "このアプリのバックアップではないか、ファイルが壊れています。",
        details: [],
      };
    case "BACKUP_VERSION_MISMATCH":
      return {
        message: "アプリの版が一致しません。このバックアップを取った版のアプリで復元してください。",
        details: [],
      };
    case "REPORT_LINE_INVALID":
      return { message: "決算書の欄は、費用の科目の 8〜31 から選んでください。", details: [] };
    case "DEPRECIATION_JOURNAL_EXISTS": {
      const years = Array.isArray(error.details?.years)
        ? error.details.years.filter((y): y is number => typeof y === "number")
        : [];
      return {
        message: `${years.length > 0 ? `${years.join("・")}年度の` : ""}減価償却の仕訳が登録されています。先にその仕訳を取り消してください。`,
        details: [],
      };
    }
    case "ENTITY_KIND_UNSUPPORTED":
      return { message: "青色申告決算書は、個人の事業体でだけ作れます。", details: [] };
    case "UNAUTHENTICATED":
      return { message: "解錠が必要です。パスキーか回復キーで解錠してください。", details: [] };
    case "LOCKED":
      return { message: "帳簿は施錠されています。解錠してください。", details: [] };
    case "PRF_UNSUPPORTED":
      return {
        message:
          "このパスキーは鍵の保護（PRF）に対応していません。iCloud キーチェーンや 1Password などの PRF に対応したパスキーを使ってください。",
        details: [],
      };
    case "REAUTH_REQUIRED":
      return {
        message: "この操作の前に、パスキーでもう一度確認してください。",
        details: [],
      };
    case "REMOTE_HOST_INVALID":
      return {
        message: "名前は *.ts.net の形で入力してください（例: mac.tail1234.ts.net）。",
        details: [],
      };
    case "REMOTE_NOT_CONFIGURED":
      return {
        message:
          "リモートが有効で、ts.net の名前が登録されているときだけ発行できます。設定の「リモート」で登録してください。",
        details: [],
      };
    case "TAILSCALE_NOT_FOUND":
      return {
        message:
          "tailscale が見つかりません。Tailscale を入れて、アプリを起動してからもう一度お試しください。",
        details: [],
      };
    case "TAILSCALE_COMMAND_FAILED":
      return {
        message:
          "tailscale のコマンドが失敗しました。Tailscale にサインインして接続中か確認してください。",
        details: [],
      };
    case "PAIRING_TOKEN_INVALID":
      return {
        message: "ペアリングの URL が無効か期限切れです。Mac でもう一度発行してください",
        details: [],
      };
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
        message: "すでに設定されています。パスキーで解錠してください。",
        details: [],
      };
    case "WEBAUTHN_FAILED":
      return {
        message: "パスキーの確認に失敗しました。もう一度お試しください。",
        details: [],
      };
    case "RECOVERY_INVALID":
      return { message: "回復キーが違います。", details: [] };
    case "LAST_PASSKEY":
      return {
        message:
          "この Mac（localhost）の最後のパスキーは削除できません。先に別のパスキーを追加してください。",
        details: [],
      };
    case "BACKUP_FOLDER_NOT_FOUND":
      return {
        message:
          "置き場所のフォルダが見つからないか、書き込めません。絶対パスで、存在するフォルダを指定してください。",
        details: [],
      };
    case "BACKUP_NOT_CONFIGURED":
      return {
        message: "バックアップの置き場所が未設定です。先に設定してください。",
        details: [],
      };
    case "BACKUP_RUNNING":
      return {
        message: "バックアップは実行中です。終わるまでお待ちください。",
        details: [],
      };
    case "DEMO_NOT_AVAILABLE":
      return {
        message:
          "事業体があるため、デモ事業は作れません。事業体を非表示にするか、完全に削除してから試してください。",
        details: [],
      };
    case "DEMO_FAILED":
      return {
        message:
          "デモ事業を作れませんでした。作りかけのデータは残っていません。もう一度お試しください。",
        details: [],
      };
    case "PAYMENT_EXCEEDS_BALANCE": {
      const remaining = asNumber(error.details?.remaining);
      return {
        message:
          remaining === undefined
            ? "入金額が請求の残額を超えています。"
            : `入金額が請求の残額（${formatYen(remaining)} 円）を超えています。`,
        details: [],
      };
    }
    case "INVOICE_SEQ_TOO_LOW": {
      const minimum = asNumber(error.details?.minimum);
      return {
        message: `次の通し番号は ${minimum === undefined ? "発行済みの最大の番号より大きい値" : `${minimum} 以上`}にしてください（発行済みの番号は再び使えません）。`,
        details: [],
      };
    }
    case "STATEMENT_TABLE_UNREADABLE": {
      const missing = asStrings(error.details?.missingColumns);
      return {
        message: "表を読み取れませんでした。区切り文字・見出しの行・列の対応を確認してください。",
        details: missing.length > 0 ? [`見つからない列: ${missing.join("、")}`] : [],
      };
    }
    case "STATEMENT_ACCOUNT_UNMAPPED": {
      const names = asStrings(error.details?.names);
      return {
        message: "対応が決まっていない口座があります。用途と科目を決めてください。",
        details: names.length > 0 ? [`未対応: ${names.join("、")}`] : [],
      };
    }
    case "STATEMENT_PLAN_CHANGED":
      return {
        message:
          "プレビューの後に内容が変わったため、プレビューを作り直しました。内容を確かめてから、もう一度取り込んでください。",
        details: [],
      };
    case "STATEMENT_SOURCE_NAME_TAKEN":
      return {
        message: "同じ名前の取込元があります。別の名前にしてください。",
        details: [],
      };
    case "STATEMENT_SOURCE_NOT_FOUND":
      return {
        message: "取込元が見つかりません。削除された可能性があります。一覧を読み直してください。",
        details: [],
      };
    case "RECEIPT_NOT_FOUND":
      return { message: "証憑が見つかりません。一覧を読み直してください。", details: [] };
    case "RECEIPT_FORMAT_UNSUPPORTED":
      return {
        message: "このファイルは扱えません。JPEG・PNG・HEIC・PDF のファイルを選んでください。",
        details: [],
      };
    case "RECEIPT_DUPLICATE":
      return {
        message: "同じファイルがすでにあります。",
        details: error.details?.deleted === true ? ["削除済みの証憑です"] : [],
      };
    case "RECEIPT_DELETED":
      return { message: "削除済みの証憑は変更できません。", details: [] };
    case "RECEIPT_LINKED":
      return {
        message:
          "仕訳に結びついている証憑は削除できません。先に仕訳との結びつきを解除してください。",
        details: [],
      };
    case "RECEIPT_ALREADY_LINKED":
      return {
        message:
          "この証憑はすでに別の仕訳に結びついています。付け替えるときは理由を添えてください。",
        details: [],
      };
    case "RECEIPT_FILE_UNREADABLE":
      return {
        message: "証憑のファイルを読み出せません。バックアップから復元できるか確認してください。",
        details: [],
      };
    case "RECEIPT_CONVERSION_FAILED":
      return {
        message: "表示用の画像に変換できません。元のファイルを取り出して確認してください。",
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
