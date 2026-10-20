import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatYen, parseYenInput } from "@/lib/format";
import { blueReturnKeys, putRentDetails, type RentDetailRow } from "./api";

type Row = {
  key: number;
  payee: string;
  property: string;
  annualRent: string;
  deductibleAmount: string;
};

const AMOUNT_ERROR = "賃借料と必要経費算入額は 0 以上の整数（円）で入力してください";

/** 金額の入力欄の文字列を 0 以上の整数にする。そうでなければ undefined */
const toYen = (raw: string): number | undefined => {
  const n = parseYenInput(raw);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
};

/**
 * 地代家賃の内訳（FR-017）。全件を置き換えて保存する。必要経費算入額の合計と決算書の欄23の
 * 一致は API が判定し、決算書の警告（RENT_DETAILS_MISMATCH）で知らせる
 */
export function RentDetailsTable({
  entityId,
  year,
  rows,
}: {
  entityId: string;
  year: string;
  rows: readonly RentDetailRow[];
}) {
  const queryClient = useQueryClient();
  const nextKey = useRef(rows.length);
  const [items, setItems] = useState<Row[]>(() =>
    rows.map((r, key) => ({
      key,
      payee: r.payee,
      property: r.property,
      annualRent: formatYen(r.annualRent),
      deductibleAmount: formatYen(r.deductibleAmount),
    })),
  );
  const [formError, setFormError] = useState<string>();

  const save = useMutation({
    mutationFn: (json: Parameters<typeof putRentDetails>[2]) =>
      putRentDetails(entityId, year, json),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: blueReturnKeys.year(entityId, year) }),
  });

  const update = (key: number, patch: Partial<Row>) =>
    setItems((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const converted = items.map((r) => ({
      payee: r.payee,
      property: r.property,
      annualRent: toYen(r.annualRent),
      deductibleAmount: toYen(r.deductibleAmount),
    }));
    const valid = converted.flatMap((r) =>
      r.annualRent === undefined || r.deductibleAmount === undefined
        ? []
        : [{ ...r, annualRent: r.annualRent, deductibleAmount: r.deductibleAmount }],
    );
    if (valid.length !== converted.length) {
      setFormError(AMOUNT_ERROR);
      return;
    }
    setFormError(undefined);
    save.mutate({ rows: valid });
  };

  const cell = (
    r: Row,
    i: number,
    field: keyof Omit<Row, "key">,
    label: string,
    numeric = false,
  ) => (
    <TableCell>
      <Input
        aria-label={`${label}（${i + 1}行目）`}
        autoComplete="off"
        inputMode={numeric ? "numeric" : undefined}
        className={numeric ? "text-right tabular-nums" : undefined}
        value={r[field]}
        onChange={(e) => update(r.key, { [field]: e.target.value })}
      />
    </TableCell>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>地代家賃の内訳</CardTitle>
        <CardDescription>
          決算書の2ページに載せる、支払先・賃借物件・賃借料・必要経費算入額です。必要経費算入額の合計は、決算書の欄23（地代家賃）と合わせます。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form noValidate onSubmit={submit} className="grid gap-3">
          {items.length > 0 && (
            <Table aria-label="地代家賃の内訳">
              <TableHeader>
                <TableRow>
                  <TableHead>支払先の住所・氏名</TableHead>
                  <TableHead>賃借物件</TableHead>
                  <TableHead className="text-right">賃借料（円）</TableHead>
                  <TableHead className="text-right">必要経費算入額（円）</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r, i) => (
                  <TableRow key={r.key}>
                    {cell(r, i, "payee", "支払先")}
                    {cell(r, i, "property", "賃借物件")}
                    {cell(r, i, "annualRent", "賃借料", true)}
                    {cell(r, i, "deductibleAmount", "必要経費算入額", true)}
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setItems((prev) => prev.filter((x) => x.key !== r.key))}
                      >
                        {`${i + 1}行目を削除`}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {items.length === 0 && (
            <p className="text-sm text-muted-foreground">内訳はまだありません。</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                const key = nextKey.current;
                nextKey.current += 1;
                setItems((prev) => [
                  ...prev,
                  { key, payee: "", property: "", annualRent: "", deductibleAmount: "" },
                ]);
              }}
            >
              行を追加
            </Button>
            <Button type="submit" disabled={save.isPending}>
              内訳を保存
            </Button>
          </div>
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </form>
        <ApiErrorMessage error={save.error} />
      </CardContent>
    </Card>
  );
}
