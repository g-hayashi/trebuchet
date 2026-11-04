import type { TaxCategoryCode } from "@trebuchet/schema";
import type { JournalEntryEvalCase } from "../../../src/statements/eval-runner.ts";
import { normalizeContent } from "../../../src/statements/normalize.ts";

/**
 * 仕訳の入力の場面（journal_entry。011/R19）の合成例。全項目をこの評価用に作り、
 * 実データからの転記はない。科目は `statement-evals.ts` の `STATEMENT_EVAL_ACCOUNTS` の評価用の科目表
 * （`eval-account-<コード>`）を指す。日付はすべて採点用の期間（基準日以後）で、ルールの学習には使わない。
 */
export function createJournalEntryEvalCase(
  id: string,
  date: string,
  memo: string,
  amount: number,
  code = "5130",
  taxCategory: TaxCategoryCode = "PURCHASE_10",
  purpose: "business" | "private" = "business",
): JournalEntryEvalCase {
  return {
    scene: "journal_entry",
    sample: {
      statementId: id,
      date,
      statementAccountId: "eval-journal-entry",
      normalizedContent: normalizeContent(memo),
      truth: {
        counterAccountId: `eval-account-${code}`,
        taxCategory,
        partnerId: null,
        purpose,
      },
    },
    work: { date, amount, memo },
  };
}

const c = createJournalEntryEvalCase;

export const JOURNAL_ENTRY_EVAL_CASES: JournalEntryEvalCase[] = [
  // 広告・通信・出張・消耗品・光熱・家賃（課税仕入 10%）
  c("je-ad-1", "2026-02-01", "合成広告社A 検索広告掲載料", 33000),
  c("je-ad-2", "2026-02-02", "合成広告社B 動画広告の出稿", 55000),
  c("je-ad-3", "2026-02-03", "合成印刷社C 名刺・チラシ印刷", 8800),
  c("je-net-1", "2026-02-04", "合成通信社D インターネット利用料", 5500, "5120"),
  c("je-net-2", "2026-02-05", "合成携帯社E 業務用スマートフォン通信料", 4400, "5120"),
  c("je-net-3", "2026-02-06", "合成クラウド社F サーバー利用料", 3300, "5120"),
  c("je-travel-1", "2026-02-07", "合成鉄道G 出張運賃", 2400, "5110"),
  c("je-travel-2", "2026-02-08", "合成宿泊H 出張の宿泊費", 9900, "5110"),
  c("je-travel-3", "2026-02-09", "合成タクシーI 客先への移動", 1800, "5110"),
  c("je-supply-1", "2026-02-10", "合成文具社J 業務用コピー用紙", 1650, "5170"),
  c("je-supply-2", "2026-02-11", "合成家電社K 業務用キーボード", 7700, "5170"),
  c("je-supply-3", "2026-02-12", "合成文具社L 文房具", 1100, "5170"),
  c("je-power-1", "2026-02-13", "合成電力社M 事務所電気料金", 6600, "5100"),
  c("je-power-2", "2026-02-14", "合成ガス社N 事務所ガス料金", 3300, "5100"),
  c("je-rent-1", "2026-02-15", "合成不動産社O 事務所家賃", 88000, "5230"),
  c("je-rent-2", "2026-02-16", "合成不動産社P 駐車場代", 11000, "5230"),
  // 売上（課税売上 10%）
  c("je-sales-1", "2026-02-17", "合成開発業務 売上入金", 550000, "4010", "SALES_10"),
  c("je-sales-2", "2026-02-18", "合成保守契約 月額請求", 110000, "4010", "SALES_10"),
  c("je-sales-3", "2026-02-19", "合成デザイン制作 納品分の入金", 220000, "4010", "SALES_10"),
  c("je-sales-4", "2026-02-20", "合成講師業務 謝礼", 33000, "4010", "SALES_10"),
  // 私用・事業主の出入り（対象外）
  c(
    "je-private-1",
    "2026-02-21",
    "合成販売店Q 家族用おもちゃ 私用",
    2200,
    "3090",
    "OUT_OF_SCOPE",
    "private",
  ),
  c(
    "je-private-2",
    "2026-02-22",
    "合成飲食店R 家族の食事 私用",
    6600,
    "3090",
    "OUT_OF_SCOPE",
    "private",
  ),
  c(
    "je-private-3",
    "2026-02-23",
    "合成衣料店S 私服の購入 私用",
    8800,
    "3090",
    "OUT_OF_SCOPE",
    "private",
  ),
  c(
    "je-owner-1",
    "2026-02-24",
    "個人の貯蓄から事業口座へ自己資金補充",
    100000,
    "3010",
    "OUT_OF_SCOPE",
    "private",
  ),
  c(
    "je-owner-2",
    "2026-02-25",
    "事業主の預金から運転資金を入金",
    50000,
    "3010",
    "OUT_OF_SCOPE",
    "private",
  ),
  // 個人情報の伏せ字（連絡先・長い数字）が摘要に混ざる例
  c("je-mask-1", "2026-02-26", "合成広告社T 広告費 contact@example.invalid 98765432", 33000),
  c("je-mask-2", "2026-02-27", "合成通信社U 通信料 03-0000-0000", 4400, "5120"),
  c("je-mask-3", "2026-02-28", "合成文具社V 文具 090-0000-0000 に連絡", 1320, "5170"),
  // 短い摘要・曖昧な摘要
  c("je-short-1", "2026-03-01", "コピー用紙", 1100, "5170"),
  c("je-short-2", "2026-03-02", "電車代", 480, "5110"),
  c("je-short-3", "2026-03-03", "家賃", 88000, "5230"),
  c("je-short-4", "2026-03-04", "広告", 22000),
];
