import type { CandidateMethod, Purpose, TaxCategoryCode } from "@trebuchet/schema";
import type { Account, InferenceRule, Journal } from "../types.ts";
import { STATEMENT_ACCOUNT_CODES } from "./journal-shape.ts";
import { learnRule, ruleFor } from "./rules.ts";

/**
 * 推定の評価（006 R17、FR-029、SC-004）。純関数（AI の呼び出しは `infer` で受け取る）。
 * 登録済みの明細とその仕訳（正解）を、基準日で分ける: 基準日より前の承認からルールを作り（メモリだけ。
 * DB のルールは使わない・書き換えない）、基準日以後の明細を推定して正解と比べる。
 * 既存の仕訳との照合・振替の対（R8 の前の段）は、正解の仕訳そのものに当たってしまうので評価に含めない
 */

/** 比べる項目（仕訳の相手の行の科目・税区分・取引先と、事業か私用かの判定） */
export type EvalFields = {
  counterAccountId: string;
  taxCategory: TaxCategoryCode;
  partnerId: string | null;
  purpose: Purpose;
};

/** 評価の 1 件。`truth` は登録済みの仕訳から読んだ正解 */
export type EvalSample = {
  statementId: string;
  /** 明細の日付（基準日と比べる） */
  date: string;
  statementAccountId: string;
  normalizedContent: string;
  truth: EvalFields;
};

/** 推定の結果。`fields` が null なら候補を作れなかった（none） */
export type EvalPrediction = { method: CandidateMethod; fields: EvalFields | null };

/** ルールが当たらなかった明細の推定（AI。使わないなら none を返す） */
export type EvalInfer = (sample: EvalSample) => Promise<EvalPrediction> | EvalPrediction;

/** 率は千分率の整数（0〜1000）。件数 0 のときは 0 */
export type EvalResult = {
  /** 評価した件数（基準日以後の明細） */
  sampleCount: number;
  fields: { counterAccount: number; taxCategory: number; partner: number; purpose: number };
  /** 件数が 1 以上の方法だけ。`matchRate` は 4 項目すべてが一致した率 */
  methods: { method: CandidateMethod; count: number; matchRate: number }[];
};

/** 方法の並び（結果の `methods` はこの順） */
const METHOD_ORDER: readonly CandidateMethod[] = [
  "match",
  "transfer",
  "rule",
  "local_ai",
  "external_ai",
  "none",
];

const OWNER_CODES: ReadonlySet<string> = new Set([
  STATEMENT_ACCOUNT_CODES.ownerContribution,
  STATEMENT_ACCOUNT_CODES.ownerDrawing,
]);

/** 千分率の整数（四捨五入。整数だけで計算する）。`total` が 0 なら 0 */
export function perMille(matches: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((matches * 2000 + total) / (2 * total));
}

/**
 * 登録済みの仕訳から正解を読む。仕訳が有効で 2 行（明細の行 `ownLineId` と相手の行 1 つ）のときだけ。
 * それ以外（訂正・取消済み、分割）は null（承認からの学習と同じく、要約できない）。
 * 判定は相手が事業主貸・事業主借なら私用、それ以外は事業
 */
export function truthOf(
  journal: Pick<Journal, "status" | "lines">,
  ownLineId: string,
  accounts: readonly Pick<Account, "id" | "code">[],
): EvalFields | null {
  if (journal.status !== "active" || journal.lines.length !== 2) return null;
  if (!journal.lines.some((l) => l.id === ownLineId)) return null;
  const counter = journal.lines.find((l) => l.id !== ownLineId);
  if (counter === undefined) return null;
  const code = accounts.find((a) => a.id === counter.accountId)?.code ?? "";
  return {
    counterAccountId: counter.accountId,
    taxCategory: counter.taxCategory,
    partnerId: counter.partnerId,
    purpose: OWNER_CODES.has(code) ? "private" : "business",
  };
}

/** 基準日より前の標本の承認を日付順に学んだルール（メモリだけ。`learnRule` の結果を `InferenceRule` にする） */
export function learnEvalRules(samples: readonly EvalSample[]): InferenceRule[] {
  const rules = new Map<string, InferenceRule>();
  const ordered = [...samples].sort(
    (a, b) => a.date.localeCompare(b.date) || a.statementId.localeCompare(b.statementId),
  );
  for (const s of ordered) {
    if (s.normalizedContent === "") continue;
    const key = JSON.stringify([s.normalizedContent, s.statementAccountId]);
    const previous = rules.get(key) ?? null;
    const learned = learnRule(previous, {
      normalizedContent: s.normalizedContent,
      statementAccountId: s.statementAccountId,
      body: {
        counterAccountId: s.truth.counterAccountId,
        counterSubAccountId: null,
        partnerId: s.truth.partnerId,
        taxCategory: s.truth.taxCategory,
        purpose: s.truth.purpose,
        descriptionTemplate: null,
      },
    });
    rules.set(key, {
      id: `eval-rule-${rules.size}`,
      ...learned.rule,
      status: "active",
      origin: "approval",
      managedBy: "auto",
      createdAt: s.date,
      updatedAt: s.date,
    });
  }
  return [...rules.values()];
}

const sameField = (a: EvalFields, b: EvalFields | null) => ({
  counterAccount: b !== null && a.counterAccountId === b.counterAccountId,
  taxCategory: b !== null && a.taxCategory === b.taxCategory,
  partner: b !== null && a.partnerId === b.partnerId,
  purpose: b !== null && a.purpose === b.purpose,
});

/**
 * 評価する。`splitDate` より前の標本からルールを作り、`splitDate` 以後の標本を推定する
 * （ルールが当たればその内容で `rule`、なければ `infer`）。推定は標本の日付・ID の順に 1 件ずつ呼ぶ。
 * 項目ごとの一致率は、評価した全件に対する一致の件数（推定が none の件は不一致）
 */
export async function evaluate(
  samples: readonly EvalSample[],
  splitDate: string,
  infer: EvalInfer,
): Promise<EvalResult> {
  const training = samples.filter((s) => s.date < splitDate);
  const targets = samples
    .filter((s) => s.date >= splitDate)
    .sort((a, b) => a.date.localeCompare(b.date) || a.statementId.localeCompare(b.statementId));
  const rules = learnEvalRules(training);

  const matches = { counterAccount: 0, taxCategory: 0, partner: 0, purpose: 0 };
  const byMethod = new Map<CandidateMethod, { count: number; matched: number }>();
  for (const sample of targets) {
    const rule = ruleFor(sample, rules);
    const prediction: EvalPrediction =
      rule === undefined
        ? await infer(sample)
        : {
            method: "rule",
            fields: {
              counterAccountId: rule.counterAccountId,
              taxCategory: rule.taxCategory,
              partnerId: rule.partnerId,
              purpose: rule.purpose,
            },
          };
    const same = sameField(sample.truth, prediction.fields);
    for (const k of Object.keys(matches) as (keyof typeof matches)[]) {
      if (same[k]) matches[k] += 1;
    }
    const entry = byMethod.get(prediction.method) ?? { count: 0, matched: 0 };
    entry.count += 1;
    if (same.counterAccount && same.taxCategory && same.partner && same.purpose) {
      entry.matched += 1;
    }
    byMethod.set(prediction.method, entry);
  }

  const total = targets.length;
  return {
    sampleCount: total,
    fields: {
      counterAccount: perMille(matches.counterAccount, total),
      taxCategory: perMille(matches.taxCategory, total),
      partner: perMille(matches.partner, total),
      purpose: perMille(matches.purpose, total),
    },
    methods: METHOD_ORDER.flatMap((method) => {
      const entry = byMethod.get(method);
      return entry === undefined
        ? []
        : [{ method, count: entry.count, matchRate: perMille(entry.matched, entry.count) }];
    }),
  };
}
