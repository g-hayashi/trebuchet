import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { JournalQuery } from "@trebuchet/schema";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input, NativeSelect } from "@/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type Account, accountsQuery } from "@/features/accounts/api";
import { type Journal, type JournalSearch, journalSearchQuery } from "@/features/journals/api";
import { JournalDetailContent } from "@/features/journals/JournalDetailContent";
import { type Partner, partnersQuery, type Tag, tagsQuery } from "@/features/masters/api";
import { ReceiptMark } from "@/features/receipts/JournalReceipts";
import { useReportRange } from "@/features/reports/periods";
import { groupAccountsBySection } from "@/lib/accounts";
import { formatYen, parseWholeYen } from "@/lib/format";
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
  const defaults = useReportRange(entityId, {});
  const effectiveSearch =
    search.dateFrom !== undefined || search.dateTo !== undefined || !defaults.range
      ? search
      : { ...search, dateFrom: defaults.range.from, dateTo: defaults.range.to };
  const clearSearch: SearchInput = defaults.range
    ? { dateFrom: defaults.range.from, dateTo: defaults.range.to }
    : {};
  const navigate = useNavigate({ from: Route.fullPath });
  const journals = useInfiniteQuery({
    ...journalSearchQuery(entityId, effectiveSearch),
    enabled: !defaults.isPending && !defaults.error,
  });
  const [selected, setSelected] = useState<string>();
  const opener = useRef<HTMLButtonElement | null>(null);
  const accounts = useQuery(accountsQuery(entityId));
  const partners = useQuery(partnersQuery(entityId));
  const tags = useQuery(tagsQuery(entityId));
  const error = defaults.error ?? journals.error ?? accounts.error ?? partners.error ?? tags.error;
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
          search={effectiveSearch}
          clearSearch={clearSearch}
          accounts={accounts.data}
          partners={partners.data}
          tags={tags.data}
          onSearch={(next) => navigate({ search: next })}
          onClear={() => navigate({ search: clearSearch })}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            {hasFilter(effectiveSearch) ? "検索の結果（新しい順）" : "仕訳（新しい順）"}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ApiErrorMessage error={error} />
          {journals.data?.pages[0]?.summary && (
            <dl
              aria-label="検索結果の集計"
              aria-live="polite"
              className="flex flex-wrap gap-6 text-sm tabular-nums"
            >
              <div className="flex gap-2">
                <dt>件数</dt>
                <dd>{journals.data.pages[0].summary.count.toLocaleString("ja-JP")} 件</dd>
              </div>
              <div className="flex gap-2">
                <dt>金額の合計</dt>
                <dd>{formatYen(journals.data.pages[0].summary.amount)} 円</dd>
              </div>
            </dl>
          )}
          {(journals.isPending || accounts.isPending) && !error && (
            <p className="text-sm text-muted-foreground">読み込み中…</p>
          )}
          {items?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {hasFilter(effectiveSearch)
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
                    journal={j}
                    accountNames={accountNames}
                    onOpen={(button) => {
                      opener.current = button;
                      setSelected(j.id);
                    }}
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
      <Sheet
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <SheetContent
          className="md:max-w-5xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
        >
          <SheetHeader>
            <div className="flex items-center justify-between gap-3">
              <SheetTitle>仕訳の詳細</SheetTitle>
              <SheetClose asChild>
                <Button variant="outline">閉じる</Button>
              </SheetClose>
            </div>
            <SheetDescription>
              内容と変更履歴を確認し、訂正・取消・複製ができます。
            </SheetDescription>
          </SheetHeader>
          {selected && (
            <JournalDetailContent
              key={selected}
              entityId={entityId}
              journalId={selected}
              embedded
            />
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}

type SearchInput = (typeof JournalSearchParams)["_zod"]["input"];

/** 金額の条件の入力。空欄は指定なし、0 以上の整数でなければ null */
function parseAmount(raw: string): number | undefined | null {
  return raw.trim() === "" ? undefined : parseWholeYen(raw, { min: 0 });
}

type FilterValues = {
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  accountId: string;
  partnerId: string;
  tagId: string;
  q: string;
  includeVoided: boolean;
};
const filterValues = (search: SearchInput): FilterValues => ({
  dateFrom: search.dateFrom ?? "",
  dateTo: search.dateTo ?? "",
  amountMin: search.amountMin === undefined ? "" : String(search.amountMin),
  amountMax: search.amountMax === undefined ? "" : String(search.amountMax),
  accountId: search.accountId ?? "",
  partnerId: search.partnerId ?? "",
  tagId: search.tagId ?? "",
  q: String(search.q ?? ""),
  includeVoided: Boolean(search.includeVoided),
});
const searchKeyOf = (search: SearchInput) =>
  JSON.stringify(
    Object.entries(search)
      .filter(([, value]) => value !== undefined && value !== false && value !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/** 条件を300ms待ってURLへ反映する。自分のURL更新で入力欄を作り直さない。 */
function SearchForm({
  search,
  clearSearch,
  accounts,
  partners,
  tags,
  onSearch,
  onClear,
}: {
  search: JournalSearch;
  clearSearch: SearchInput;
  accounts: Account[];
  partners: Partner[];
  tags: Tag[];
  onSearch: (next: SearchInput) => void;
  onClear: () => void;
}) {
  const [values, setValues] = useState(() => filterValues(search));
  const [amountErrors, setAmountErrors] = useState<{ min?: boolean; max?: boolean }>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const emitted = useRef<string | undefined>(undefined);
  const currentSearch = useRef(search);
  currentSearch.current = search;
  const searchKey = searchKeyOf(search);
  useEffect(() => {
    if (emitted.current === searchKey) {
      emitted.current = undefined;
      return;
    }
    clearTimeout(timer.current);
    setValues(filterValues(currentSearch.current));
    setAmountErrors({});
  }, [searchKey]);
  useEffect(() => () => clearTimeout(timer.current), []);
  function change<K extends keyof FilterValues>(name: K, value: FilterValues[K]) {
    const next = { ...values, [name]: value };
    setValues(next);
    clearTimeout(timer.current);
    const amountMin = parseAmount(next.amountMin);
    const amountMax = parseAmount(next.amountMax);
    setAmountErrors({ min: amountMin === null, max: amountMax === null });
    if (amountMin === null || amountMax === null) return;
    const parsed: SearchInput = {
      dateFrom: next.dateFrom || undefined,
      dateTo: next.dateTo || undefined,
      amountMin,
      amountMax,
      accountId: next.accountId || undefined,
      partnerId: next.partnerId || undefined,
      tagId: next.tagId || undefined,
      q: next.q.trim() || undefined,
      includeVoided: next.includeVoided || undefined,
    };
    const filtered = Object.fromEntries(
      Object.entries(parsed).filter(([, item]) => item !== undefined),
    ) as SearchInput;
    timer.current = setTimeout(() => {
      emitted.current = searchKeyOf(filtered);
      onSearch(filtered);
    }, 300);
  }
  const field = "grid content-start gap-1";
  const label = "text-sm font-medium";
  const amountMessage = "0 以上の整数で入力してください";
  return (
    <Card>
      <CardContent className="pt-6">
        {/* biome-ignore lint/a11y/noRedundantRoles: search要素の暗黙のロールに未対応のブラウザでも検索領域を識別する */}
        <search role="search" aria-label="仕訳の検索">
          <form noValidate onSubmit={(event) => event.preventDefault()} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className={field}>
                <label htmlFor="search-date-from" className={label}>
                  日付（から）
                </label>
                <Input
                  id="search-date-from"
                  type="date"
                  value={values.dateFrom}
                  onChange={(event) => change("dateFrom", event.target.value)}
                />
              </div>
              <div className={field}>
                <label htmlFor="search-date-to" className={label}>
                  日付（まで）
                </label>
                <Input
                  id="search-date-to"
                  type="date"
                  value={values.dateTo}
                  onChange={(event) => change("dateTo", event.target.value)}
                />
              </div>
              <div className={field}>
                <label htmlFor="search-amount-min" className={label}>
                  金額（以上）
                </label>
                <Input
                  id="search-amount-min"
                  inputMode="numeric"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  value={values.amountMin}
                  onChange={(event) => change("amountMin", event.target.value)}
                  aria-invalid={amountErrors.min || undefined}
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
                  inputMode="numeric"
                  autoComplete="off"
                  className="text-right tabular-nums"
                  value={values.amountMax}
                  onChange={(event) => change("amountMax", event.target.value)}
                  aria-invalid={amountErrors.max || undefined}
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
                  value={values.accountId}
                  onChange={(event) => change("accountId", event.target.value)}
                >
                  <option value="">すべて</option>
                  {groupAccountsBySection(accounts).map((group) => (
                    <optgroup key={group.section} label={group.label}>
                      {group.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
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
                  value={values.partnerId}
                  onChange={(event) => change("partnerId", event.target.value)}
                >
                  <option value="">すべて</option>
                  {partners.map((partner) => (
                    <option key={partner.id} value={partner.id}>
                      {partner.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className={field}>
                <label htmlFor="search-tag" className={label}>
                  タグ
                </label>
                <NativeSelect
                  id="search-tag"
                  value={values.tagId}
                  onChange={(event) => change("tagId", event.target.value)}
                >
                  <option value="">すべて</option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className={field}>
                <label htmlFor="search-q" className={label}>
                  摘要・メモ
                </label>
                <Input
                  id="search-q"
                  autoComplete="off"
                  value={values.q}
                  onChange={(event) => change("q", event.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={values.includeVoided}
                  onChange={(event) => change("includeVoided", event.target.checked)}
                  className="size-4"
                />
                取消済みも表示
              </label>
              <Button
                variant="outline"
                onClick={() => {
                  clearTimeout(timer.current);
                  emitted.current = undefined;
                  setAmountErrors({});
                  setValues(filterValues(clearSearch));
                  onClear();
                }}
              >
                条件をクリア
              </Button>
            </div>
          </form>
        </search>
      </CardContent>
    </Card>
  );
}

function JournalRow({
  journal,
  accountNames,
  onOpen,
}: {
  /** 一覧の項目。`receiptCount` は有効な結びつきの証憑の数（010 H: §4） */
  journal: Journal & { receiptCount?: number | undefined };
  accountNames: Map<string, string>;
  onOpen: (button: HTMLButtonElement) => void;
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
    <TableRow className={cn("relative align-top", voided && "text-muted-foreground")}>
      <TableCell className="tabular-nums">{journal.date}</TableCell>
      <TableCell className="text-right tabular-nums">
        <button
          type="button"
          onClick={(event) => onOpen(event.currentTarget)}
          aria-label={`仕訳 No.${journal.journalNo} の詳細`}
          className="text-primary underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          {journal.journalNo}
        </button>
      </TableCell>
      <TableCell className={cn(voided && "line-through")}>{sideLines("debit")}</TableCell>
      <TableCell className={cn(voided && "line-through")}>{sideLines("credit")}</TableCell>
      <TableCell>
        {notes.map((n) => (
          <div key={n.key}>{n.text}</div>
        ))}
      </TableCell>
      <TableCell>
        {voided ? "取消済み" : ""}
        <ReceiptMark count={journal.receiptCount ?? 0} />
      </TableCell>
    </TableRow>
  );
}
