import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { JournalQuery } from "@trebuchet/schema";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { groupAccountsBySection } from "@/lib/accounts";
import { formatYen, parseYenInput } from "@/lib/format";
import {
  type Account,
  accountsQuery,
  type Journal,
  type JournalSearch,
  journalSearchQuery,
  type Partner,
  partnersQuery,
  type Tag,
  tagsQuery,
} from "@/lib/queries";
import { cn } from "@/lib/utils";

/** URL の検索パラメータ（FR-023）。ページの指定（cursor・limit）は URL に残さない */
const JournalSearchParams = JournalQuery.omit({ cursor: true, limit: true });

export const Route = createFileRoute("/e/$entityId/journals/")({
  validateSearch: JournalSearchParams,
  search: { middlewares: [stripSearchParams({ includeVoided: false })] },
  component: JournalsPage,
});

const hasFilter = (search: JournalSearch) =>
  Object.entries(search).some(([k, v]) => v !== undefined && !(k === "includeVoided" && !v));

function JournalsPage() {
  const { entityId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const journals = useInfiniteQuery(journalSearchQuery(entityId, search));
  const accounts = useQuery(accountsQuery(entityId));
  const partners = useQuery(partnersQuery(entityId));
  const tags = useQuery(tagsQuery(entityId));
  const error = journals.error ?? accounts.error ?? partners.error ?? tags.error;
  const accountNames = new Map(accounts.data?.map((a) => [a.id, a.name]));
  const items = journals.data?.pages.flatMap((p) => p.journals);

  return (
    <main className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">仕訳</h1>
        <Link
          to="/e/$entityId/journals/new"
          params={{ entityId }}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          仕訳を入力
        </Link>
      </div>
      {accounts.data && partners.data && tags.data && (
        <SearchForm
          search={search}
          accounts={accounts.data}
          partners={partners.data}
          tags={tags.data}
          onSearch={(next) => navigate({ search: next })}
          onClear={() => navigate({ search: {} })}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>{hasFilter(search) ? "検索の結果（新しい順）" : "仕訳（新しい順）"}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={error} />
          {(journals.isPending || accounts.isPending) && !error && (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          )}
          {items?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {hasFilter(search)
                ? "条件に合う仕訳がありません。"
                : "仕訳がありません。「仕訳を入力」から登録してください。"}
            </p>
          )}
          {items && items.length > 0 && accounts.data && (
            <Table aria-label="仕訳の一覧">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">日付</TableHead>
                  <TableHead className="w-16 text-right">No.</TableHead>
                  <TableHead>借方</TableHead>
                  <TableHead>貸方</TableHead>
                  <TableHead>摘要・メモ</TableHead>
                  <TableHead className="w-20">状態</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((j) => (
                  <JournalRow
                    key={j.id}
                    entityId={entityId}
                    journal={j}
                    accountNames={accountNames}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {journals.hasNextPage && (
            <Button
              variant="outline"
              className="justify-self-center"
              disabled={journals.isFetchingNextPage}
              onClick={() => journals.fetchNextPage()}
            >
              {journals.isFetchingNextPage ? "読み込み中…" : "さらに読み込む"}
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

type SearchInput = (typeof JournalSearchParams)["_zod"]["input"];

/** 金額の条件の入力。空欄は指定なし、0 以上の整数でなければ null */
function parseAmount(raw: string): number | undefined | null {
  if (raw.trim() === "") return undefined;
  const value = parseYenInput(raw);
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 検索の条件のフォーム（FR-023）。条件は URL の検索パラメータに入れる */
function SearchForm({
  search,
  accounts,
  partners,
  tags,
  onSearch,
  onClear,
}: {
  search: JournalSearch;
  accounts: Account[];
  partners: Partner[];
  tags: Tag[];
  onSearch: (next: SearchInput) => void;
  onClear: () => void;
}) {
  const [amountErrors, setAmountErrors] = useState<{ min?: boolean; max?: boolean }>({});

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (name: string) => {
      const v = String(data.get(name) ?? "").trim();
      return v === "" ? undefined : v;
    };
    const amountMin = parseAmount(String(data.get("amountMin") ?? ""));
    const amountMax = parseAmount(String(data.get("amountMax") ?? ""));
    setAmountErrors({ min: amountMin === null, max: amountMax === null });
    if (amountMin === null || amountMax === null) return;
    const next: SearchInput = {
      dateFrom: text("dateFrom"),
      dateTo: text("dateTo"),
      amountMin,
      amountMax,
      partnerId: text("partnerId"),
      accountId: text("accountId"),
      q: text("q"),
      tagId: text("tagId"),
      includeVoided: data.get("includeVoided") === "on" ? true : undefined,
    };
    onSearch(
      Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as SearchInput,
    );
  };

  const searchKey = JSON.stringify(search);
  const amountMessage = "0 以上の整数で入力してください";
  const field = "grid content-start gap-1";
  const label = "text-sm font-medium";

  return (
    <Card>
      <CardContent className="pt-6">
        {/* biome-ignore lint/a11y/noRedundantRoles: search 要素の暗黙のロールに未対応の支援技術・ブラウザがあるため明示する */}
        <search role="search" aria-label="仕訳の検索">
          <form noValidate onSubmit={submit} className="grid gap-4">
            {/* 条件が URL で変わったら（クリア・戻る）入力欄を作り直して URL の値に合わせる */}
            <div key={searchKey} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className={field}>
                <label htmlFor="search-date-from" className={label}>
                  日付（から）
                </label>
                <Input
                  id="search-date-from"
                  name="dateFrom"
                  type="date"
                  defaultValue={search.dateFrom}
                />
              </div>
              <div className={field}>
                <label htmlFor="search-date-to" className={label}>
                  日付（まで）
                </label>
                <Input id="search-date-to" name="dateTo" type="date" defaultValue={search.dateTo} />
              </div>
              <div className={field}>
                <label htmlFor="search-amount-min" className={label}>
                  金額（以上）
                </label>
                <Input
                  id="search-amount-min"
                  name="amountMin"
                  inputMode="numeric"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  defaultValue={search.amountMin}
                  aria-invalid={amountErrors.min ? true : undefined}
                  aria-describedby="search-amount-min-error"
                />
                <FieldError
                  id="search-amount-min-error"
                  message={amountErrors.min ? amountMessage : undefined}
                />
              </div>
              <div className={field}>
                <label htmlFor="search-amount-max" className={label}>
                  金額（以下）
                </label>
                <Input
                  id="search-amount-max"
                  name="amountMax"
                  inputMode="numeric"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  defaultValue={search.amountMax}
                  aria-invalid={amountErrors.max ? true : undefined}
                  aria-describedby="search-amount-max-error"
                />
                <FieldError
                  id="search-amount-max-error"
                  message={amountErrors.max ? amountMessage : undefined}
                />
              </div>
              <div className={field}>
                <label htmlFor="search-account" className={label}>
                  勘定科目
                </label>
                <NativeSelect
                  id="search-account"
                  name="accountId"
                  defaultValue={search.accountId ?? ""}
                >
                  <option value="">すべて</option>
                  {groupAccountsBySection(accounts).map((g) => (
                    <optgroup key={g.section} label={g.label}>
                      {g.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </NativeSelect>
              </div>
              <div className={field}>
                <label htmlFor="search-partner" className={label}>
                  取引先
                </label>
                <NativeSelect
                  id="search-partner"
                  name="partnerId"
                  defaultValue={search.partnerId ?? ""}
                >
                  <option value="">すべて</option>
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className={field}>
                <label htmlFor="search-tag" className={label}>
                  タグ
                </label>
                <NativeSelect id="search-tag" name="tagId" defaultValue={search.tagId ?? ""}>
                  <option value="">すべて</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className={field}>
                <label htmlFor="search-q" className={label}>
                  摘要・メモ
                </label>
                <Input id="search-q" name="q" autoComplete="off" defaultValue={search.q} />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <label key={searchKey} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="includeVoided"
                  defaultChecked={search.includeVoided}
                  className="size-4"
                />
                取消済みも表示
              </label>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setAmountErrors({});
                    onClear();
                  }}
                >
                  条件をクリア
                </Button>
                <Button type="submit">検索</Button>
              </div>
            </div>
          </form>
        </search>
      </CardContent>
    </Card>
  );
}

function JournalRow({
  entityId,
  journal,
  accountNames,
}: {
  entityId: string;
  journal: Journal;
  accountNames: Map<string, string>;
}) {
  const voided = journal.status === "voided";
  const sideLines = (side: "debit" | "credit") =>
    journal.lines
      .filter((l) => l.side === side)
      .map((l) => (
        <div key={l.id} className="flex justify-between gap-4">
          <span>{accountNames.get(l.accountId) ?? "（不明な科目）"}</span>
          <span className="tabular-nums">{formatYen(l.amount)}</span>
        </div>
      ));
  const notes = [
    ...(journal.memo === null ? [] : [{ key: "memo", text: journal.memo }]),
    ...journal.lines.flatMap((l) =>
      l.description === null ? [] : [{ key: l.id, text: l.description }],
    ),
  ];

  return (
    <TableRow className={cn("align-top", voided && "text-muted-foreground")}>
      <TableCell className="tabular-nums">{journal.date}</TableCell>
      <TableCell className="text-right tabular-nums">
        <Link
          to="/e/$entityId/journals/$journalId"
          params={{ entityId, journalId: journal.id }}
          aria-label={`仕訳 No.${journal.journalNo} の詳細`}
          className="text-primary underline-offset-4 hover:underline"
        >
          {journal.journalNo}
        </Link>
      </TableCell>
      <TableCell className={cn(voided && "line-through")}>{sideLines("debit")}</TableCell>
      <TableCell className={cn(voided && "line-through")}>{sideLines("credit")}</TableCell>
      <TableCell>
        {notes.map((n) => (
          <div key={n.key}>{n.text}</div>
        ))}
      </TableCell>
      <TableCell>{voided ? "取消済み" : ""}</TableCell>
    </TableRow>
  );
}
