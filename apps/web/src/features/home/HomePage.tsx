import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { HomeFigures, HomeRecentJournal, HomeTasks, Section } from "@trebuchet/schema";
import type { ReactNode } from "react";
import { Loading } from "@/components/loading";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { backupStatusQuery } from "@/features/backup/api";
import { formatDateTime, formatSignedYen } from "@/lib/format";
import { homeQuery } from "./api";

// ホーム（011 US1。contracts/ui-shell.md §3、FR-006〜009）。件数・金額は server（domain）が決める。画面は表示と移動だけ

const linkClass = "text-primary underline-offset-4 hover:underline";
const shortcutClass = buttonVariants({ variant: "outline" });

/** 1 項目の枠。見出しを `aria-labelledby` に結ぶ（読み上げと、テストが名前で探す） */
function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card aria-labelledby={id}>
      <CardHeader>
        <CardTitle id={id}>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** 項目の失敗（FR-009）。その場所に「読み込めませんでした」と「再読み込み」を出す */
function SectionError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <p>読み込めませんでした</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        再読み込み
      </Button>
    </div>
  );
}

/** 項目の値を描く。読み込み中・取得そのものの失敗・項目の失敗をまとめて扱う */
function Loaded<T>({
  section,
  pending,
  fetchError,
  onRetry,
  children,
}: {
  section: Section<T> | undefined;
  pending: boolean;
  fetchError: unknown;
  onRetry: () => void;
  children: (value: T) => ReactNode;
}) {
  if (section === undefined) {
    if (fetchError !== null && fetchError !== undefined) return <SectionError onRetry={onRetry} />;
    return pending ? <Loading /> : null;
  }
  if (section.status === "error") return <SectionError onRetry={onRetry} />;
  return <>{children(section.value)}</>;
}

/**
 * 今日やること。件数が 0 の項目は出さず、すべて 0 なら「残っている作業はありません」。
 * 押し先は絞り込みの検索の引数つきの画面（contracts/ui-shell.md §3）。期限切れは未入金の「うち」
 */
function Tasks({
  entityId,
  tasks,
  fiscalYear,
}: {
  entityId: string;
  tasks: HomeTasks;
  /** 決算書の警告の押し先の年。今期の数字が読めなければ null（決算書の一覧へ） */
  fiscalYear: number | null;
}) {
  const t = tasks;
  const params = { entityId };
  const items: { key: string; node: ReactNode }[] = [];
  if (t.unprocessedStatements > 0) {
    items.push({
      key: "statements",
      node: (
        <Link
          to="/e/$entityId/statements"
          params={params}
          search={{ status: "unprocessed" }}
          className={linkClass}
        >
          未処理の明細 {t.unprocessedStatements} 件
        </Link>
      ),
    });
  }
  if (t.unlinkedReceipts > 0) {
    items.push({
      key: "receipts",
      node: (
        <Link
          to="/e/$entityId/receipts"
          params={params}
          search={{ link: "none" }}
          className={linkClass}
        >
          仕訳のない証憑 {t.unlinkedReceipts} 件
        </Link>
      ),
    });
  }
  if (t.unpaidInvoices > 0) {
    items.push({
      key: "unpaid",
      node: (
        <Link
          to="/e/$entityId/invoices"
          params={params}
          search={{ status: "unpaid" }}
          className={linkClass}
        >
          未入金の請求書 {t.unpaidInvoices} 件
        </Link>
      ),
    });
  }
  if (t.overdueInvoices > 0) {
    items.push({
      key: "overdue",
      node: (
        <Link
          to="/e/$entityId/invoices"
          params={params}
          search={{ status: "overdue" }}
          className={linkClass}
        >
          うち期限切れ {t.overdueInvoices} 件
        </Link>
      ),
    });
  }
  if (t.blockedRecurring > 0) {
    items.push({
      key: "recurring",
      node: (
        <Link to="/e/$entityId/recurring" params={params} className={linkClass}>
          登録できなかった定期仕訳 {t.blockedRecurring} 件
        </Link>
      ),
    });
  }
  if (t.blueReturnWarnings > 0) {
    items.push({
      key: "blue-return",
      node:
        fiscalYear === null ? (
          <Link to="/e/$entityId/blue-return" params={params} className={linkClass}>
            決算書の警告 {t.blueReturnWarnings} 件
          </Link>
        ) : (
          <Link
            to="/e/$entityId/blue-return/$year"
            params={{ entityId, year: String(fiscalYear) }}
            className={linkClass}
          >
            決算書の警告 {t.blueReturnWarnings} 件
          </Link>
        ),
    });
  }
  if (items.length === 0) return <p className="text-sm">残っている作業はありません</p>;
  return (
    <ul className="grid gap-2 text-sm">
      {items.map((item) => (
        <li key={item.key}>{item.node}</li>
      ))}
    </ul>
  );
}

function Figures({ entityId, figures }: { entityId: string; figures: HomeFigures | null }) {
  if (figures === null) {
    return (
      <p className="text-sm">
        今日を含む会計期間が登録されていません。{" "}
        <Link to="/e/$entityId/periods" params={{ entityId }} className={linkClass}>
          会計期間を登録する
        </Link>
      </p>
    );
  }
  const rows: [string, number][] = [
    ["売上", figures.sales],
    ["経費", figures.expenses],
    ["利益", figures.netIncome],
    ["現金と預金", figures.cashAndDeposits],
    ["未回収", figures.outstanding],
  ];
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        {figures.fiscalYear} 年度（{figures.from} 〜 {figures.to}）
      </p>
      <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {rows.map(([label, amount]) => (
          <div key={label} className="grid gap-1">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatSignedYen(amount)} 円</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RecentJournals({
  entityId,
  journals,
}: {
  entityId: string;
  journals: HomeRecentJournal[];
}) {
  if (journals.length === 0) return <p className="text-sm text-muted-foreground">まだありません</p>;
  return (
    <ul className="grid divide-y text-sm">
      {journals.map((j) => (
        <li key={j.id}>
          <Link
            to="/e/$entityId/journals/$journalId"
            params={{ entityId, journalId: j.id }}
            className="flex flex-wrap items-baseline justify-between gap-x-4 py-2 hover:bg-accent"
          >
            <span className="tabular-nums text-muted-foreground">{j.date}</span>
            <span className="min-w-0 flex-1">{j.memo ?? "（摘要なし）"}</span>
            <span className="tabular-nums">{formatSignedYen(j.amount)} 円</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * 事業体のホーム。「今日やること」「今期の数字」「最近の仕訳」「近道」と、前回のバックアップ・最後の明細の取込の日時。
 * 項目ごとに失敗を扱う（FR-009）。バックアップは端末の情報なので、既存の `GET /api/backup/status` を別に読む
 */
export function HomePage({ entityId }: { entityId: string }) {
  const home = useQuery(homeQuery(entityId));
  const backup = useQuery(backupStatusQuery());
  const data = home.data;
  const shared = {
    pending: home.isPending,
    fetchError: home.error,
    onRetry: () => void home.refetch(),
  };
  const fiscalYear =
    data?.figures.status === "ok" ? (data.figures.value?.fiscalYear ?? null) : null;

  return (
    <main className="grid gap-6">
      <h1 className="text-xl font-semibold">ホーム</h1>

      <Block id="home-tasks" title="今日やること">
        <Loaded section={data?.tasks} {...shared}>
          {(tasks) => <Tasks entityId={entityId} tasks={tasks} fiscalYear={fiscalYear} />}
        </Loaded>
      </Block>

      <Block id="home-figures" title="今期の数字">
        <Loaded section={data?.figures} {...shared}>
          {(figures) => <Figures entityId={entityId} figures={figures} />}
        </Loaded>
      </Block>

      <Block id="home-recent" title="最近の仕訳">
        <Loaded section={data?.recentJournals} {...shared}>
          {(journals) => <RecentJournals entityId={entityId} journals={journals} />}
        </Loaded>
      </Block>

      <Block id="home-shortcuts" title="近道">
        <div className="flex flex-wrap gap-2">
          <Link to="/e/$entityId/journals/new" params={{ entityId }} className={shortcutClass}>
            仕訳を入力
          </Link>
          <Link to="/e/$entityId/receipts/new" params={{ entityId }} className={shortcutClass}>
            証憑を追加
          </Link>
          <Link to="/e/$entityId/statements/import" params={{ entityId }} className={shortcutClass}>
            明細を取り込む
          </Link>
        </div>
      </Block>

      <Card aria-label="日時">
        <CardContent>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div className="grid gap-1">
              <dt className="text-muted-foreground">前回のバックアップ</dt>
              <dd>
                {backup.data?.lastSuccess
                  ? formatDateTime(backup.data.lastSuccess)
                  : "まだありません"}
              </dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-muted-foreground">最後の明細の取込</dt>
              <dd>
                <Loaded section={data?.lastStatementImportAt} {...shared}>
                  {(at) => (at === null ? "まだありません" : formatDateTime(at))}
                </Loaded>
              </dd>
            </div>
          </dl>
          <ApiErrorMessage error={backup.error} />
        </CardContent>
      </Card>
    </main>
  );
}
