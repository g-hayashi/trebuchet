import type { AiProgress } from "./candidate-chain";

/**
 * 自動の推定の進み（「AI で推定 n / m 件」）と、外部の AI へ送ったこと・端末内の AI が使えないことの知らせ。
 * 推定が終わった後も、画面にいる間は出し続ける（外部へ送った事実は消さない）。
 * 呼び出し側の `role="status"` の中に置く
 */
export function AiProgressLines({ ai }: { ai: AiProgress }) {
  return (
    <>
      <p className="tabular-nums">
        AI で推定 {ai.done} / {ai.total} 件{ai.stopped ? "で止まりました" : ""}
      </p>
      {ai.done > 0 && !ai.localAvailable && (
        <p>端末内の AI が使えません。設定を確かめてください。</p>
      )}
      {ai.externalUsed && (
        <p>外部の AI へ内容を送りました（確信度がしきい値に届かなかった明細だけ）。</p>
      )}
    </>
  );
}
