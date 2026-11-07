import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type JournalInput,
  PURPOSES,
  type Purpose,
  type StatementAccount,
} from "@trebuchet/schema";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type Account, accountsQuery } from "@/features/accounts/api";
import { taxCategoriesQuery, taxSettingsQuery } from "@/features/entities/api";
import { journalSearchQuery } from "@/features/journals/api";
import { JournalForm, type JournalFormProps } from "@/features/journals/JournalForm";
import { partnersQuery, tagsQuery } from "@/features/masters/api";
import { ApiError } from "@/lib/api";
import { addDays } from "@/lib/dates";
import { formatYen } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";
import { type ApproveBody, postApprove, type StatementView, statementAccountsQuery } from "./api";
import { METHOD_LABELS, PURPOSE_LABELS } from "./labels";

/** 既存の仕訳との照合に見る日付の幅（日。domain の `MATCH_WINDOW_DAYS` と同じ） */
const MATCH_WINDOW_DAYS = 7;

type Mode = "create" | "link";
type Draft = NonNullable<StatementView["candidate"]>["draft"];
type FormSource = NonNullable<JournalFormProps["journal"]>;

/** 仕訳の案の初期値。候補の案があればそれ。なければ、明細の口座の行と空の相手の行（科目の対応が分かるとき） */
function initialSource(
  statement: StatementView,
  draft: Draft | undefined,
  statementAccount: StatementAccount | undefined,
): FormSource | undefined {
  if (draft) {
    return {
      date: draft.date,
      memo: draft.memo ?? null,
      lines: draft.lines.map((l) => ({
        side: l.side,
        accountId: l.accountId,
        subAccountId: l.subAccountId ?? null,
        amount: l.amount,
        taxCategory: l.taxCategory ?? null,
        partnerId: l.partnerId ?? null,
        description: l.description ?? null,
        tagIds: l.tagIds ?? [],
      })),
    };
  }
  if (!statementAccount || statementAccount.accountId === null) return undefined;
  const amount = Math.abs(statement.amount);
  const outflow = statement.amount < 0;
  const line = (side: "debit" | "credit", accountId: string, subAccountId: string | null) => ({
    side,
    accountId,
    subAccountId,
    amount,
    taxCategory: null,
    partnerId: null,
    description: null,
  });
  return {
    date: statement.date,
    memo: statement.content.slice(0, 1000),
    lines: [
      line(outflow ? "debit" : "credit", "", null),
      line(outflow ? "credit" : "debit", statementAccount.accountId, statementAccount.subAccountId),
    ],
  };
}

/** 明細の口座の行の合計（借方 − 貸方）が明細の金額と違えば、送らずにエラーにする（サーバーの検査と同じ。FR-015） */
function checkStatementLines(
  input: JournalInput,
  statement: StatementView,
  statementAccount: StatementAccount | undefined,
) {
  // 私用の口座（科目なし）の相手は事業主貸・借。サーバーが検査する
  if (!statementAccount || statementAccount.accountId === null) return;
  const actual = input.lines
    .filter(
      (l) =>
        l.accountId === statementAccount.accountId &&
        (l.subAccountId ?? null) === statementAccount.subAccountId,
    )
    .reduce((sum, l) => sum + (l.side === "debit" ? l.amount : -l.amount), 0);
  if (actual !== statement.amount) {
    throw new ApiError(
      422,
      "STATEMENT_AMOUNT_MISMATCH",
      "明細の口座の行の合計が明細の金額と一致しません",
      { expected: statement.amount, actual },
    );
  }
}

type LineRef = { journalId: string; lineId: string };

/** 結びつけ先の行の選択（FR-021a）。同じ向き・同じ金額の行（明細の口座が分かれば、その科目の行）だけを出す */
function LinkPicker({
  entityId,
  statement,
  statementAccount,
  accounts,
  selected,
  onSelect,
}: {
  entityId: string;
  statement: StatementView;
  statementAccount: StatementAccount | undefined;
  accounts: Account[] | undefined;
  selected: LineRef | undefined;
  onSelect: (ref: LineRef) => void;
}) {
  const name = useId();
  const journals = useInfiniteQuery(
    journalSearchQuery(entityId, {
      dateFrom: addDays(statement.date, -MATCH_WINDOW_DAYS),
      dateTo: addDays(statement.date, MATCH_WINDOW_DAYS),
      includeVoided: false,
    }),
  );
  const accountNames = new Map(accounts?.map((a) => [a.id, a.name]));
  const side = statement.amount > 0 ? "debit" : "credit";
  const options = (journals.data?.pages.flatMap((p) => p.journals) ?? [])
    .filter((j) => j.status === "active")
    .flatMap((j) =>
      j.lines
        .filter(
          (l) =>
            l.side === side &&
            l.amount === Math.abs(statement.amount) &&
            (statementAccount?.accountId == null ||
              (l.accountId === statementAccount.accountId &&
                l.subAccountId === statementAccount.subAccountId)),
        )
        .map((l) => ({ journal: j, line: l })),
    );

  return (
    <div className="grid gap-2">
      <ApiErrorMessage error={journals.error} />
      {journals.isPending && <p className="text-sm text-muted-foreground">読み込み中…</p>}
      {journals.data && options.length === 0 && (
        <p className="text-sm text-muted-foreground">
          日付の前後 {MATCH_WINDOW_DAYS} 日に、結びつけられる仕訳の行はありません。
        </p>
      )}
      {options.length > 0 && (
        <fieldset aria-label="結びつけ先の行" className="grid gap-1">
          {options.map(({ journal, line }) => (
            <label
              key={line.id}
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
            >
              <input
                type="radio"
                name={name}
                checked={selected?.lineId === line.id}
                onChange={() => onSelect({ journalId: journal.id, lineId: line.id })}
              />
              <span>
                仕訳 No.{journal.journalNo}（{journal.date}）{" "}
                {accountNames.get(line.accountId) ?? "（不明な科目）"} {formatYen(line.amount)}円
                {journal.memo !== null && journal.memo !== "" && ` ${journal.memo}`}
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/**
 * 候補の確認と承認（FR-014〜016・021a）。「仕訳を登録する」は候補の案（なければ明細の口座の行）を直して登録、
 * 「既存の仕訳と結びつける」は二重計上を防ぐために、すでにある仕訳の行に結びつける（仕訳は増えない）
 */
export function CandidateEditor({
  entityId,
  statement,
  onClose,
  onApproved,
}: {
  entityId: string;
  statement: StatementView;
  onClose: () => void;
  onApproved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const radioName = useId();
  const candidate = statement.candidate;
  const accounts = useQuery(accountsQuery(entityId));
  const partners = useQuery(partnersQuery(entityId));
  const tags = useQuery(tagsQuery(entityId));
  const taxSettings = useQuery(taxSettingsQuery(entityId));
  const taxCategories = useQuery(taxCategoriesQuery(entityId));
  const statementAccounts = useQuery(statementAccountsQuery(entityId));
  const statementAccount = statementAccounts.data?.find((a) => a.name === statement.accountName);
  const loadError = [accounts, partners, tags, taxSettings, taxCategories, statementAccounts].find(
    (q) => q.error,
  )?.error;

  const learnId = useId();
  const [mode, setMode] = useState<Mode>(candidate?.method === "match" ? "link" : "create");
  const [selected, setSelected] = useState<LineRef | undefined>(candidate?.match);
  // 推定ルールの学習は承認のたびに行う（011 R9）。判定・取引先は「仕訳のとおり」なら送らない
  const [purposeChoice, setPurposeChoice] = useState<Purpose | "">("");
  const [partnerChoice, setPartnerChoice] = useState("");

  const approve = useMutation({
    mutationFn: (body: ApproveBody) => postApprove(entityId, statement.id, body),
    onSuccess: async (result) => {
      await invalidateLedger(queryClient, entityId);
      const notes = [
        result.journal ? `承認しました（仕訳 No.${result.journal.journalNo}）。` : "",
        result.journal ? "" : "既存の仕訳に結びつけました。",
        result.pairLink ? "振替の対の相手の明細も、同じ仕訳に結びつけました。" : "",
        result.rule ? `ルールを学びました（確信度 ${result.rule.confidence}）。` : "",
        ...result.warnings.map((w) => `注意: ${w.message}`),
      ].filter((n) => n !== "");
      onApproved(notes.join(" "));
    },
  });

  const ready =
    accounts.data && partners.data && tags.data && taxSettings.data && taxCategories.data;

  // 開いたとき、画面の外にあれば見える位置へ動かす（jsdom などで未実装のときは何もしない）
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    sectionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  return (
    <section
      ref={sectionRef}
      aria-label="候補の確認"
      className="grid gap-4 rounded-md border px-4 py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <h2 className="font-medium">
            候補の確認: {statement.date} {statement.accountName} {statement.content}（
            {formatYen(statement.amount)}円）
          </h2>
          {candidate && (
            <p className="text-sm text-muted-foreground">
              {METHOD_LABELS[candidate.method]}
              {candidate.confidence !== null && `（確信度 ${candidate.confidence}）`}:{" "}
              {candidate.reason}
            </p>
          )}
        </div>
        <Button variant="ghost" onClick={onClose}>
          閉じる
        </Button>
      </div>

      <fieldset aria-label="承認の方法" className="flex flex-wrap gap-4 text-sm">
        {(
          [
            ["create", "仕訳を登録する"],
            ["link", "既存の仕訳と結びつける"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2">
            <input
              type="radio"
              name={radioName}
              checked={mode === value}
              onChange={() => {
                approve.reset();
                setMode(value);
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <ApiErrorMessage error={loadError} />
      {!ready && !loadError && <p className="text-sm text-muted-foreground">読み込み中…</p>}

      {ready && mode === "create" && (
        <>
          <fieldset aria-label="ルールの学習" className="grid gap-3 rounded-md border px-3 py-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid content-start gap-1">
                <Label htmlFor={`${learnId}-purpose`}>判定（ルールに記憶）</Label>
                <NativeSelect
                  id={`${learnId}-purpose`}
                  value={purposeChoice}
                  onChange={(e) => setPurposeChoice(e.target.value as Purpose | "")}
                >
                  <option value="">仕訳のとおり</option>
                  {PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {PURPOSE_LABELS[p]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid content-start gap-1">
                <Label htmlFor={`${learnId}-partner`}>取引先（ルールに記憶）</Label>
                <NativeSelect
                  id={`${learnId}-partner`}
                  value={partnerChoice}
                  onChange={(e) => setPartnerChoice(e.target.value)}
                >
                  <option value="">仕訳のとおり</option>
                  {partners.data.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              同じ内容の明細の候補を、次からこの内容で作ります。利用者が直した・止めたルールは変わりません。
            </p>
          </fieldset>
          <JournalForm
            key={statement.id}
            entityId={entityId}
            accounts={accounts.data}
            partners={partners.data}
            tags={tags.data}
            taxSettings={taxSettings.data}
            taxCategories={taxCategories.data}
            defaultDate={statement.date}
            journal={initialSource(statement, candidate?.draft, statementAccount)}
            formLabel="仕訳の案"
            submitLabel="承認して登録"
            onSubmit={async (input) => {
              checkStatementLines(input, statement, statementAccount);
              await approve.mutateAsync({
                draft: input,
                ...(purposeChoice === "" ? {} : { purpose: purposeChoice }),
                ...(partnerChoice === "" ? {} : { partnerId: partnerChoice }),
              });
            }}
          />
        </>
      )}

      {ready && mode === "link" && (
        <div className="grid gap-3">
          <LinkPicker
            entityId={entityId}
            statement={statement}
            statementAccount={statementAccount}
            accounts={accounts.data}
            selected={selected}
            onSelect={(ref) => {
              approve.reset();
              setSelected(ref);
            }}
          />
          <ApiErrorMessage error={approve.error} />
          <div>
            <Button
              disabled={selected === undefined || approve.isPending}
              onClick={() => selected && approve.mutate({ match: selected })}
            >
              結びつけて承認
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
