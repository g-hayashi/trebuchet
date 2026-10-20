import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { DeductionAnswersInput } from "@trebuchet/schema";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  blueReturnKeys,
  deductionAnswersQuery,
  putDeductionAnswers,
} from "@/features/blue-return/api";
import { formatYen } from "@/lib/format";

export const Route = createFileRoute("/e/$entityId/blue-return/$year/deduction")({
  component: DeductionPage,
});

const QUESTIONS: { key: keyof DeductionAnswersInput; label: string }[] = [
  { key: "doubleEntry", label: "正規の簿記の原則（複式簿記）で記帳している" },
  { key: "statementsAttached", label: "貸借対照表と損益計算書を確定申告書に添付する" },
  { key: "filedOnTime", label: "期限内に申告する" },
  { key: "eTax", label: "e-Tax で申告データを送信する" },
  { key: "electronicBooks", label: "優良な電子帳簿の保存の要件を満たしている" },
];

const NONE: DeductionAnswersInput = {
  doubleEntry: false,
  statementsAttached: false,
  filedOnTime: false,
  eTax: false,
  electronicBooks: false,
};

/** 青色申告特別控除の要件の回答（FR-010）。上限額は API が決め、画面は結果を表示する */
function DeductionPage() {
  const { entityId, year } = Route.useParams();
  const { data, isPending, error } = useQuery(deductionAnswersQuery(entityId, year));

  return (
    <main className="grid gap-6">
      <Link
        to="/e/$entityId/blue-return/$year"
        params={{ entityId, year }}
        className="text-sm underline"
      >
        決算書に戻る
      </Link>
      <h1 className="text-xl font-semibold">青色申告特別控除の要件（{year}年分）</h1>
      <ApiErrorMessage error={error} />
      {isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {data && (
        <AnswersForm
          // 保存済みの回答が読み込まれたら入力欄を作り直す
          key={JSON.stringify(data.answers)}
          entityId={entityId}
          year={year}
          view={data}
        />
      )}
    </main>
  );
}

/** 回答と上限額（GET と PUT の応答は同じ形） */
type View = Awaited<ReturnType<typeof putDeductionAnswers>>;

function AnswersForm({ entityId, year, view }: { entityId: string; year: string; view: View }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<DeductionAnswersInput>(view.answers ?? NONE);
  const save = useMutation({
    mutationFn: (json: DeductionAnswersInput) => putDeductionAnswers(entityId, year, json),
    // 決算書の欄44・45 も変わるため、年度の決算書と回答を読み直す
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: blueReturnKeys.year(entityId, year) }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(values);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>要件の回答</CardTitle>
        <CardDescription>
          当てはまるものにチェックを付けて保存してください。控除額の上限は回答から決まります。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {view.answers === null && (
          <p className="text-sm text-muted-foreground">まだ回答がありません。</p>
        )}
        <form onSubmit={submit} className="grid gap-3">
          {QUESTIONS.map((q) => (
            <label key={q.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={values[q.key]}
                onChange={(e) => setValues((prev) => ({ ...prev, [q.key]: e.target.checked }))}
              />
              {q.label}
            </label>
          ))}
          <div>
            <Button type="submit" disabled={save.isPending}>
              保存
            </Button>
          </div>
        </form>
        <ApiErrorMessage error={save.error} />
        {view.cap && (
          <section aria-label="控除額の上限" className="grid gap-2 text-sm">
            <p className="text-base font-medium">上限額: {formatYen(view.cap.cap)} 円</p>
            {view.cap.unmet.length > 0 && (
              <div>
                <p className="font-medium">満たしていない要件</p>
                <ul className="list-disc pl-5">
                  {view.cap.unmet.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
