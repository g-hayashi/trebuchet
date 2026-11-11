import { Link } from "@tanstack/react-router";
import type { BlueReturnWarning } from "@trebuchet/schema";
import { formatSignedYen } from "@/lib/format";

type Omitted = { accountId: string; name: string; amount: number };

const guidance: Record<BlueReturnWarning["code"], { meaning: string; action: string }> = {
  OPTIONAL_LINES_OVERFLOW: {
    meaning: "様式の空欄に科目を個別に載せきれません。金額は合計に含まれています。",
    action:
      "表示された科目と決算書の欄の割り当てを確認してください。科目の内容に合う欄を選び、個別に載らない内訳は申告時にも確認してください。",
  },
  PL_MISMATCH: {
    meaning: "決算書と帳簿の損益計算書で、経費または利益の集計が一致していません。",
    action:
      "科目の決算書の欄と損益計算書の内訳を照合してください。設定が正しくても差が残る場合は、計算処理の確認が必要です。差を消すためだけの仕訳は登録しないでください。",
  },
  HOME_USE_ADJUSTMENT_STALE: {
    meaning:
      "現在の帳簿・事業割合と、登録済みの家事分の振替が合っていないか、振替の案を計算できません。",
    action:
      "対象科目と事業割合を確認し、仕訳の案を見直してください。登録済みの振替が古い場合は取り消してから、正しい案を登録します。",
  },
  RENT_DETAILS_MISMATCH: {
    meaning:
      "地代家賃の内訳に入力した経費額の合計が、帳簿から集計した欄23と一致していません。内訳が未入力の場合も表示します。",
    action:
      "支払先の住所・氏名、賃借物件、家賃総額と、家事按分後の必要経費算入額を入力・保存してください。帳簿と按分が正しいことを確認し、経費額の合計を欄23と合わせます。",
  },
  DEPRECIATION_MISMATCH: {
    meaning:
      "資産・開業費の台帳から求めた必要経費算入額と、帳簿の減価償却費（欄18）が一致していません。",
    action:
      "固定資産台帳と開業費の年分・償却額、登録済みの償却仕訳を確認してください。仕訳の未登録・重複・訂正漏れを調べ、正しい案を登録します。",
  },
  SALES_TOTAL_MISMATCH: {
    meaning: "月別売上または売上先の明細の合計が、決算書の売上（欄1）と一致していません。",
    action:
      "売上・雑収入の科目の決算書の欄と、対象年分の仕訳を照合してください。設定が正しくても差が残る場合は、集計処理の確認が必要です。差額を埋める仕訳は登録しないでください。",
  },
  SALES_WITHOUT_PARTNER: {
    meaning: "売上の合計には含まれていますが、取引先別に集計できず「上記以外」にまとめています。",
    action:
      "請求書などで相手が分かる売上は、仕訳の売上高の行に取引先を設定してください。摘要に名前を書くだけでは反映されません。不特定多数への売上は個別設定できない場合もありますが、主要な売上先の設定漏れを確認してください。",
  },
  DUPLICATE_PARTNER_NAME: {
    meaning: "同じ名前の取引先が別々に登録され、売上先の明細も別々に集計されています。",
    action:
      "同一の相手か別の相手かを確認してください。同一なら仕訳の取引先を一つにそろえ、別の相手なら名称などで区別できるようにします。",
  },
  OPENING_MISMATCH: {
    meaning: "当年の期首残高が前年末からの繰越額と違うか、繰越額を計算できません。",
    action:
      "前年の期末残高と当年の期首残高を照合し、誤りがある側を直してください。差に理由がある場合は、4ページの「期首と前期末の差の説明」に記録します。説明の保存だけでは残高の差は解消しません。",
  },
  DEFERRED_ASSET_NOT_AMORTIZED: {
    meaning:
      "繰延資産の残高が期首から変わっていません。開業費は任意償却のため、今年必ず償却する必要はありません。",
    action:
      "開業費の画面で対象年分の償却額を決めてください。償却しない場合は0円で「償却しない」と決定します。償却する場合は上限内で決定し、仕訳の案を確認して登録します。帳簿にだけ残高がある場合は、台帳の登録内容も確認してください。",
  },
  OPENING_OWNER_ACCOUNTS: {
    meaning: "期首に事業主貸・事業主借・前年の所得の残高が残っています。",
    action:
      "前年の期末を確認し、事業主貸・事業主借・所得を元入金に繰り込んだ期首残高に直してください。当年の収益・費用として処理しないでください。",
  },
  NEGATIVE_BALANCE: {
    meaning:
      "科目の通常の貸借方向と逆の残高になっています。仕訳や期首残高の誤りがないか確認が必要です。",
    action:
      "対象科目の総勘定元帳で、期首残高・貸借の向き・重複・記帳漏れを確認してください。実態に合う残高であれば、警告を消すためだけに金額を変える必要はありません。",
  },
  DEDUCTION_ANSWERS_MISSING: {
    meaning: "青色申告特別控除の要件が未回答のため、控除額と控除後の所得金額を計算していません。",
    action:
      "画面上部の「要件を直す」を開き、記帳方法や申告方法などを実際の状況に合わせて回答・保存してください。",
  },
  PRIOR_PERIOD_OPEN: {
    meaning:
      "前年がまだ締められていないため、繰越の確認に使う前年末の残高は今後変わる可能性があります。",
    action:
      "前年の決算整理と帳簿を確認してから、会計期間の画面で前年を締めてください。その後、当年の決算書で繰越を再確認します。",
  },
  ASSET_REGISTER_MISMATCH: {
    meaning: "帳簿の期首残高と、資産・開業費の台帳の期首未償却残高が一致していません。",
    action:
      "台帳の取得価額・前年までの償却額・登録漏れと、帳簿の期首残高を照合し、誤りがある側を直してください。登録済みの償却仕訳がある場合は、変更前にその仕訳を確認します。",
  },
  DEPRECIATION_PARAMETER_MISSING: {
    meaning:
      "資産や開業費の入力内容、または対象年分の税制の値に問題があり、償却額を計算できません。",
    action:
      "警告に表示された理由を確認し、台帳の取得日・供用日・耐用年数・償却方法・開業日などを見直してください。税制の値が未対応の場合はアプリ側の対応が必要です。推測した額で仕訳を登録しないでください。",
  },
};

/** details.omitted を、形の合うものだけ取り出す（details は型のない record） */
function omittedOf(details: BlueReturnWarning["details"]): Omitted[] {
  const raw = details?.omitted;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o: unknown) => {
    if (typeof o !== "object" || o === null) return [];
    const { accountId, name, amount } = o as Record<string, unknown>;
    return typeof accountId === "string" && typeof name === "string" && typeof amount === "number"
      ? [{ accountId, name, amount }]
      : [];
  });
}

/** 一覧の key。同じ文面でも科目（details.accountId）が違えば別の警告にする */
function warningKey(w: BlueReturnWarning): string {
  const accountId = w.details?.accountId;
  return typeof accountId === "string"
    ? `${w.code}-${accountId}-${w.message}`
    : `${w.code}-${w.message}`;
}

/** 家事按分・地代家賃の内訳の画面へのリンク（警告から直す先） */
function HomeUseLink({ entityId, year, label }: { entityId: string; year: string; label: string }) {
  return (
    <Link
      to="/e/$entityId/blue-return/$year/home-use"
      params={{ entityId, year }}
      className="mt-1 block underline"
    >
      {label}
    </Link>
  );
}

/**
 * 決算書の警告の一覧。決算書は表示したまま知らせる。
 * 任意科目が欄に載らないとき（OPTIONAL_LINES_OVERFLOW。1ページ・4ページとも）は、載らなかった科目名と金額、
 * 科目の画面へのリンクを出す。期首の食い違い（OPENING_MISMATCH）は、登録した差の説明を警告の横に出す
 * 各警告に意味と対応を添える。
 */
export function WarningList({
  entityId,
  year,
  warnings,
}: {
  entityId: string;
  year: string;
  warnings: readonly BlueReturnWarning[];
}) {
  if (warnings.length === 0) return null;
  return (
    <section
      aria-label="警告"
      className="no-print rounded-md border border-amber-500/60 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      <ul className="grid gap-2 pl-5">
        {warnings.map((w) => {
          const omitted = w.code === "OPTIONAL_LINES_OVERFLOW" ? omittedOf(w.details) : [];
          return (
            <li key={warningKey(w)} className="list-disc">
              <p className="font-medium">{w.message}</p>
              <details className="mt-1">
                <summary className="w-fit cursor-pointer rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
                  説明と対応を見る
                </summary>
                <div className="mt-1 grid max-w-prose gap-1 leading-relaxed">
                  <p>意味：{guidance[w.code].meaning}</p>
                  <p>対応：{guidance[w.code].action}</p>
                </div>
                {omitted.length > 0 && (
                  <>
                    <ul aria-label="欄に載らなかった科目" className="mt-1 list-none pl-3">
                      {omitted.map((o) => (
                        <li key={o.accountId}>
                          {o.name} {formatSignedYen(o.amount)} 円
                        </li>
                      ))}
                    </ul>
                    <Link
                      to="/e/$entityId/accounts"
                      params={{ entityId }}
                      className="mt-1 inline-block underline"
                    >
                      科目の画面で決算書の欄を変更する
                    </Link>
                  </>
                )}
                {omitted.length === 0 &&
                  (w.code === "OPTIONAL_LINES_OVERFLOW" ||
                    w.code === "PL_MISMATCH" ||
                    w.code === "SALES_TOTAL_MISMATCH") && (
                    <Link
                      to="/e/$entityId/accounts"
                      params={{ entityId }}
                      className="mt-1 block underline"
                    >
                      科目の決算書の欄を確認する
                    </Link>
                  )}
                {(w.code === "SALES_WITHOUT_PARTNER" ||
                  w.code === "SALES_TOTAL_MISMATCH" ||
                  w.code === "DUPLICATE_PARTNER_NAME") && (
                  <Link
                    to="/e/$entityId/journals"
                    params={{ entityId }}
                    className="mt-1 block underline"
                  >
                    仕訳帳で取引先を確認する
                  </Link>
                )}
                {w.code === "DUPLICATE_PARTNER_NAME" && (
                  <Link
                    to="/e/$entityId/partners"
                    params={{ entityId }}
                    className="mt-1 block underline"
                  >
                    取引先の登録を確認する
                  </Link>
                )}
                {(w.code === "OPENING_MISMATCH" ||
                  w.code === "OPENING_OWNER_ACCOUNTS" ||
                  w.code === "ASSET_REGISTER_MISMATCH") && (
                  <Link
                    to="/e/$entityId/periods/$year/opening-balances"
                    params={{ entityId, year }}
                    className="mt-1 block underline"
                  >
                    期首残高を確認する
                  </Link>
                )}
                {w.code === "PRIOR_PERIOD_OPEN" && (
                  <Link
                    to="/e/$entityId/periods"
                    params={{ entityId }}
                    className="mt-1 block underline"
                  >
                    会計期間を確認する
                  </Link>
                )}
                {w.code === "NEGATIVE_BALANCE" && (
                  <Link
                    to="/e/$entityId/reports/general-ledger"
                    params={{ entityId }}
                    className="mt-1 block underline"
                  >
                    総勘定元帳を確認する
                  </Link>
                )}
                {w.code === "PL_MISMATCH" && (
                  <Link
                    to="/e/$entityId/reports/profit-and-loss"
                    params={{ entityId }}
                    className="mt-1 block underline"
                  >
                    損益計算書を確認する
                  </Link>
                )}
                {w.code === "OPENING_MISMATCH" && typeof w.details?.note === "string" && (
                  <span className="mt-1 block whitespace-pre-wrap">説明: {w.details.note}</span>
                )}
                {(w.code === "DEFERRED_ASSET_NOT_AMORTIZED" ||
                  w.code === "DEPRECIATION_MISMATCH" ||
                  w.code === "ASSET_REGISTER_MISMATCH" ||
                  w.code === "DEPRECIATION_PARAMETER_MISSING") && (
                  <Link
                    to="/e/$entityId/deferred-assets"
                    params={{ entityId }}
                    search={{ year: Number(year) }}
                    className="mt-1 block underline"
                  >
                    開業費の償却額を決める
                  </Link>
                )}
                {w.code === "HOME_USE_ADJUSTMENT_STALE" && (
                  <HomeUseLink entityId={entityId} year={year} label="仕訳の案を見る" />
                )}
                {(w.code === "DEPRECIATION_MISMATCH" ||
                  w.code === "ASSET_REGISTER_MISMATCH" ||
                  w.code === "DEPRECIATION_PARAMETER_MISSING") && (
                  <Link
                    to="/e/$entityId/fixed-assets"
                    params={{ entityId }}
                    search={{ year: Number(year) }}
                    className="mt-1 block underline"
                  >
                    固定資産台帳を開く
                  </Link>
                )}
                {w.code === "RENT_DETAILS_MISMATCH" && (
                  <HomeUseLink entityId={entityId} year={year} label="地代家賃の内訳を直す" />
                )}
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
