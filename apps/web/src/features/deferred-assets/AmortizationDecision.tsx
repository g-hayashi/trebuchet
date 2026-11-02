import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { SaveNotice } from "@/components/ui/save-notice";
import { blueReturnKeys } from "@/features/blue-return/api";
import { formatYen, parseWholeYen } from "@/lib/format";
import { type DeferredAssetRow, deferredAssetKeys, putDeferredAmortization } from "./api";

type AmortizationView = NonNullable<DeferredAssetRow["amortization"]>;

const AMOUNT_ERROR = "償却額は0以上の整数で入力してください";

/** 年分の決定の表示。決めていなければ「未決定」、0 円は「償却しない」 */
export function decisionLabel(view: AmortizationView | null): string {
  if (view === null) return "";
  if (view.decision === null) return "未決定";
  return view.decision.amount === 0 ? "償却しない" : formatYen(view.decision.amount);
}

/**
 * 開業費の年分の償却額の決定（FR-014〜015）。上限（期首の未償却残高）と目安（60 か月の均等償却）を見せ、
 * 0〜上限の整数を入力する。0 円は「償却しない」の決定。上限を超える入力・仕訳を登録した年分の変更の判定は API が行う。
 * 画面は計算しない。決定すると API が仕訳の案を作る（案は下の「決算整理の仕訳の案」に出る）
 */
export function AmortizationDecision({
  entityId,
  year,
  asset,
}: {
  entityId: string;
  year: number;
  asset: DeferredAssetRow;
}) {
  const queryClient = useQueryClient();
  const view = asset.amortization;
  const [text, setText] = useState(view?.decision ? String(view.decision.amount) : "");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState("");

  const decide = useMutation({
    mutationFn: (amount: number) => putDeferredAmortization(entityId, asset.id, year, amount),
    onSuccess: async (_result, amount) => {
      setNotice(
        amount === 0
          ? `${year}年分は償却しないと決定しました。`
          : `${year}年分の償却額を決定しました。`,
      );
      // 開業費の一覧・案・決算書（警告）を読み直す。決定は仕訳を変えない
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: deferredAssetKeys.all(entityId) }),
        queryClient.invalidateQueries({ queryKey: blueReturnKeys.all(entityId) }),
      ]);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNotice("");
    const amount = parseWholeYen(text, { min: 0 });
    setError(amount === null ? AMOUNT_ERROR : undefined);
    if (amount === null) return;
    decide.mutate(amount);
  };

  const errorId = `deferred-decision-${asset.id}-error`;
  const inputId = `deferred-decision-${asset.id}`;
  return (
    <fieldset
      aria-label={`${asset.name}の償却額の決定`}
      className="grid gap-3 rounded-md border p-3"
    >
      <h3 className="font-medium">{`${asset.name}の${year}年分の償却額`}</h3>
      {view === null ? (
        <p className="text-sm text-muted-foreground">
          この年分の償却額は決められません（開業日より前の年分、または該当する税制の値がありません）。
        </p>
      ) : (
        <>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">上限（期首の未償却残高）</dt>
              <dd className="tabular-nums">{formatYen(view.openingBalance)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">目安</dt>
              <dd className="tabular-nums">{formatYen(view.target)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">決定</dt>
              <dd>{decisionLabel(view)}</dd>
            </div>
          </dl>
          {view.registered ? (
            <p className="text-sm text-muted-foreground">
              この年分は仕訳を登録済みです。償却額を変えるには、先にその仕訳を取り消してください。
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              0 円から上限までの整数で決めます。0 円は「償却しない」と記録します。
            </p>
          )}
          <form noValidate onSubmit={submit} className="flex flex-wrap items-start gap-2">
            <div className="grid gap-1">
              <label htmlFor={inputId} className="sr-only">
                {`${asset.name}の償却額（${year}年分）`}
              </label>
              <Input
                id={inputId}
                inputMode="numeric"
                autoComplete="off"
                className="w-40"
                value={text}
                disabled={view.registered}
                onChange={(e) => setText(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={errorId}
              />
              <FieldError id={errorId} message={error} />
            </div>
            <Button type="submit" disabled={decide.isPending || view.registered}>
              {`${asset.name}の償却額を決定`}
            </Button>
            <SaveNotice message={notice} />
          </form>
        </>
      )}
      <ApiErrorMessage error={decide.error} />
    </fieldset>
  );
}
