import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { SaveNotice } from "@/components/ui/save-notice";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { parseHalfStep } from "@/lib/format";
import { billingTermsQuery, invoiceKeys, putWorkHours, workHoursQuery } from "./api";

const HOURS_ERROR = "0.5 時間単位で入力してください";

type Entry = { partnerId: string; hours: number | null };

/** 入力欄の文字列を時間にする。空は undefined（未入力）、0 以上の 0.5 の倍数でなければ null */
function parseHours(raw: string): number | undefined | null {
  return raw.trim() === "" ? undefined : parseHalfStep(raw);
}

/** 対象月の工数の入力。時間単価型の有効な取引先ごとに、0.5 時間単位で入れる（005/FR-005） */
export function WorkHoursTable({ entityId, month }: { entityId: string; month: string }) {
  const hours = useQuery(workHoursQuery(entityId, month));
  const terms = useQuery(billingTermsQuery(entityId));
  const error = hours.error ?? terms.error;
  if (error) return <ApiErrorMessage error={error} />;
  if (!hours.data || !terms.data) return <Loading />;
  const names = new Map(terms.data.map((t) => [t.partnerId, t.partnerName]));
  return <HoursForm entityId={entityId} month={month} entries={hours.data} names={names} />;
}

function HoursForm({
  entityId,
  month,
  entries,
  names,
}: {
  entityId: string;
  month: string;
  entries: Entry[];
  names: Map<string, string>;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(entries.map((e) => [e.partnerId, e.hours === null ? "" : String(e.hours)])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  const save = useMutation({
    mutationFn: (payload: { partnerId: string; hours: number }[]) =>
      putWorkHours(entityId, month, payload),
    onSuccess: async () => {
      setNotice("保存しました。");
      await queryClient.invalidateQueries({ queryKey: invoiceKeys.workHours(entityId, month) });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice("");
    save.reset();
    const nextErrors: Record<string, string> = {};
    const payload: { partnerId: string; hours: number }[] = [];
    for (const entry of entries) {
      const parsed = parseHours(values[entry.partnerId] ?? "");
      if (parsed === null) nextErrors[entry.partnerId] = HOURS_ERROR;
      else if (parsed !== undefined) payload.push({ partnerId: entry.partnerId, hours: parsed });
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) save.mutate(payload);
  };

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        時間単価型の請求の条件がある取引先がありません。取引先の画面で請求の条件を設定してください。
      </p>
    );
  }

  return (
    <form noValidate className="grid gap-4 md:max-w-xl" onSubmit={onSubmit}>
      <Table aria-label="工数">
        <TableHeader>
          <TableRow>
            <TableHead>取引先</TableHead>
            <TableHead className="w-48 text-right">時間</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => {
            const name = names.get(entry.partnerId) ?? entry.partnerId;
            const errorId = `${id}-${entry.partnerId}-error`;
            return (
              <TableRow key={entry.partnerId} className="align-top">
                <TableCell>{name}</TableCell>
                <TableCell>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step={0.5}
                    min={0}
                    className="text-right tabular-nums"
                    aria-label={`${name} の時間`}
                    aria-invalid={errors[entry.partnerId] ? true : undefined}
                    aria-describedby={errorId}
                    value={values[entry.partnerId] ?? ""}
                    onChange={(e) => {
                      setNotice("");
                      setValues((prev) => ({ ...prev, [entry.partnerId]: e.target.value }));
                    }}
                  />
                  <FieldError id={errorId} message={errors[entry.partnerId]} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="text-sm text-muted-foreground">
        未入力の取引先は、請求書の案を作るときに「工数が未入力」として飛ばします。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          保存
        </Button>
        <SaveNotice message={notice} />
        <Link
          to="/e/$entityId/invoices/new"
          params={{ entityId }}
          search={{ month }}
          className="text-sm underline underline-offset-4"
        >
          請求書の案を作る
        </Link>
      </div>
      <ApiErrorMessage error={save.error} />
    </form>
  );
}
