import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeductionAnswersInput } from "@trebuchet/schema";
import { type FormEvent, useState } from "react";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { SaveNotice } from "@/components/ui/save-notice";
import { formatYen } from "@/lib/format";
import { blueReturnKeys, deductionAnswersQuery, putDeductionAnswers } from "./api";

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

/**
 * 青色申告特別控除の要件の回答（FR-010、011 FR-044）。決算書の欄44の近くから開く。
 * 上限額は API が決め、画面は結果を表示する。保存したら決算書を読み直す（欄44・45 が変わる）
 */
export function DeductionAnswersDialog({
  entityId,
  year,
  open,
  onOpenChange,
}: {
  entityId: string;
  year: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>青色申告特別控除の要件（{year}年分）</DialogTitle>
          <DialogDescription>
            当てはまるものにチェックを付けて保存してください。控除額の上限は回答から決まります。
          </DialogDescription>
        </DialogHeader>
        <AnswersLoader entityId={entityId} year={year} />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              閉じる
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** ダイアログを開いたときだけ回答を読む（中身は開いている間だけ作られる） */
function AnswersLoader({ entityId, year }: { entityId: string; year: string }) {
  const { data, isPending, error } = useQuery(deductionAnswersQuery(entityId, year));
  const [saved, setSaved] = useState(false);

  return (
    <div className="grid gap-4">
      <ApiErrorMessage error={error} />
      {isPending && <Loading />}
      {data && (
        <AnswersForm
          // 保存済みの回答が読み込まれたら入力欄を作り直す
          key={JSON.stringify(data.answers)}
          entityId={entityId}
          year={year}
          view={data}
          saved={saved}
          onSavedChange={setSaved}
        />
      )}
    </div>
  );
}

/** 回答と上限額（GET と PUT の応答は同じ形） */
type View = Awaited<ReturnType<typeof putDeductionAnswers>>;

function AnswersForm({
  entityId,
  year,
  view,
  saved,
  onSavedChange,
}: {
  entityId: string;
  year: string;
  view: View;
  /** 保存の成功の知らせを出すか。保存すると入力欄を作り直すので、親が持つ */
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<DeductionAnswersInput>(view.answers ?? NONE);
  const save = useMutation({
    mutationFn: (json: DeductionAnswersInput) => putDeductionAnswers(entityId, year, json),
    // 決算書の欄44・45 も変わるため、年度の決算書と回答を読み直す
    onSuccess: () => {
      onSavedChange(true);
      return queryClient.invalidateQueries({ queryKey: blueReturnKeys.year(entityId, year) });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(values);
  };

  return (
    <div className="grid gap-4">
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
              onChange={(e) => {
                onSavedChange(false);
                setValues((prev) => ({ ...prev, [q.key]: e.target.checked }));
              }}
            />
            {q.label}
          </label>
        ))}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            保存
          </Button>
          <SaveNotice message={saved ? "保存しました。" : ""} />
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
    </div>
  );
}
