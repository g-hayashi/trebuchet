import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  StatementAccountInput,
  StatementCommitOptions,
  StatementEncoding,
  StatementImportPreview,
  StatementLayoutOptions,
  StatementOrigin,
  StatementPreviewOptions,
  StatementSource,
  StatementTableLayout,
} from "@trebuchet/schema";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import { SaveNotice } from "@/components/ui/save-notice";
import { Steps } from "@/components/ui/steps";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { thisYear } from "@/lib/dates";
import { AccountMappingForm } from "./AccountMappingForm";
import { type AccountDraft, draftFromSuggestion, inputFromDraft } from "./account-draft";
import {
  importBatchesQuery,
  postImportCommit,
  postImportLayout,
  postImportPreview,
  statementKeys,
  statementSourcesQuery,
} from "./api";
import {
  type ColumnMappingDraft,
  ColumnMappingEditor,
  type RelayoutChoice,
} from "./ColumnMappingEditor";
import { type ChainProgress, runCandidateChain } from "./candidate-chain";
import { ImportPreview } from "./ImportPreview";
import { ORIGIN_LABELS } from "./labels";
import { ReviewQueue } from "./ReviewQueue";
import { AppliedSource, SourceChooser } from "./SourcePicker";
import { StatementInput, type StatementInputValue } from "./StatementInput";

/** 取込の手順（011 R9。FR-019）。確定の後の「確認・承認」は、候補の作成が終わったら確認の画面（ReviewQueue）を出す */
const IMPORT_STEPS = ["入力", "列と口座", "取込", "確認・承認"] as const;

/** 取込の後の連鎖の状態。running の間は進みを出し、done で確認の画面を出す */
type Chain = { phase: "running" | "done"; progress: ChainProgress };

/** 連鎖の進み（候補の作成の進み）。段階ごとに、わかったことを 1 行ずつ出す */
function ChainStatus({ progress, phase }: { progress: ChainProgress; phase: Chain["phase"] }) {
  const { seeded, built, ai, aiSkipped } = progress;
  return (
    <div role="status" aria-label="候補の作成の進み" className="grid gap-1 text-sm">
      {phase === "running" && <p className="text-muted-foreground">候補を作っています…</p>}
      {seeded !== undefined && <p>過去の仕訳からルールを {seeded} 件作りました。</p>}
      {built !== undefined && <p>候補を {built} 件作りました。</p>}
      {ai && (
        <p className="tabular-nums">
          AI で推定 {ai.done} / {ai.total} 件{ai.stopped ? "で止まりました" : ""}
        </p>
      )}
      {aiSkipped && <p>AI の設定が無効なので、推定は飛ばしました。</p>}
    </div>
  );
}

/** 取込の履歴（H:§3.3。新しい順） */
function BatchHistory({ entityId }: { entityId: string }) {
  const { data, error } = useQuery(importBatchesQuery(entityId));
  return (
    <section aria-label="取込の履歴" className="grid gap-2">
      <h2 className="text-lg font-semibold">取込の履歴</h2>
      <ApiErrorMessage error={error} />
      {data &&
        (data.length === 0 ? (
          <p className="text-sm text-muted-foreground">取り込んだ記録はまだありません。</p>
        ) : (
          <Table aria-label="取込の履歴">
            <TableHeader>
              <TableRow>
                <TableHead>取込日時</TableHead>
                <TableHead>入力</TableHead>
                <TableHead>取込元</TableHead>
                <TableHead>期間</TableHead>
                <TableHead className="text-right">新規</TableHead>
                <TableHead className="text-right">取込済み</TableHead>
                <TableHead className="text-right">読めない行</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{new Date(b.createdAt).toLocaleString("ja-JP")}</TableCell>
                  <TableCell>{ORIGIN_LABELS[b.origin]}</TableCell>
                  <TableCell>{b.sourceName ?? "—"}</TableCell>
                  <TableCell>
                    {b.periodFrom} 〜 {b.periodTo}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{b.countNew}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.countExisting}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.countUnreadable}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </section>
  );
}

/** 読み取った入力。プレビューと確定は、読み取りと同じファイルを送る */
type Input = StatementInputValue;

/**
 * プレビューを作ったときの、ファイルと指定と取込元の保存。確定と、確定の失敗の後の作り直しは、これをそのまま使う。
 * `saveSource` は確定の options にそのまま入れる（null は保存しない。007 contracts §2.3）
 */
type Request = {
  file: File;
  options: StatementPreviewOptions;
  saveSource: StatementCommitOptions["saveSource"];
};

/** 当てはめた取込元（保存した対応）での取込の指定。取込元を更新（id つき）として確定する */
const requestFromSource = (
  file: File,
  origin: StatementOrigin,
  encoding: StatementEncoding,
  source: StatementSource,
  year: number,
): Request => ({
  file,
  options: {
    origin,
    year,
    mapping: source.mapping,
    encoding,
    sourceId: source.id,
    ...(source.fixedAccountName === null ? {} : { fixedAccountName: source.fixedAccountName }),
  },
  saveSource: { id: source.id, name: source.name },
});

/**
 * 明細の取込の画面（US1・US2）: 入力（貼り付け・ファイル）→ 列の対応 → 確認（プレビュー・口座の対応）→ 確定。
 * 取込元（保存した列の対応）が 1 件当てはまれば列の対応を飛ばして確認へ進み、2 件以上なら取込元を選ばせる。
 * 列の対応を直す・読み直すときは自動の当てはめをしない（`manual`）。
 * 未対応の口座の対応（推定を初期値にした口座ごとの入力）はこの画面が持ち、確定の `accounts` でまとめて送る（プレビューは作り直さない）。
 * 確定が `STATEMENT_PLAN_CHANGED` のときはプレビューを作り直す。
 * 確定は、直近のプレビューと同じファイルと指定を送る（列の対応を触っても、プレビューのままで確定する）
 */
export function ImportWorkspace({ entityId }: { entityId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [input, setInput] = useState<Input | undefined>();
  const [chain, setChain] = useState<Chain | undefined>();
  // 新しい入力を読み取ったとき、前の連鎖の進みが後から書き込まないようにする
  const chainRun = useRef(0);
  const [inputVersion, setInputVersion] = useState(0);
  const [layout, setLayout] = useState<StatementTableLayout | undefined>();
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [encodingOverride, setEncodingOverride] = useState<StatementEncoding | undefined>();
  const [request, setRequest] = useState<Request | undefined>();
  const [preview, setPreview] = useState<StatementImportPreview | undefined>();
  // 未対応の口座に決めている途中の対応（名前ごと）。触っていない口座は、推定を初期値にする
  const [accountDrafts, setAccountDrafts] = useState<Record<string, AccountDraft>>({});
  const [notice, setNotice] = useState("");
  // 取込元（US2）: 自動の当てはめをしない（列の対応を直している）か、2 件以上から選んだ取込元、手で選んだ取込元、対象の年
  const [manual, setManual] = useState(false);
  const [chosen, setChosen] = useState<StatementSource | undefined>();
  const [pickedSourceId, setPickedSourceId] = useState<string | undefined>();
  const [year, setYear] = useState(thisYear());
  const sources = useQuery(statementSourcesQuery(entityId));

  const previewMutation = useMutation({
    mutationFn: (r: Request) => postImportPreview(entityId, r.file, r.options),
    onSuccess: (result, r) => {
      setRequest(r);
      setPreview(result);
    },
    onError: () => setPreview(undefined),
  });

  const layoutMutation = useMutation({
    mutationFn: ({
      file,
      options,
    }: {
      file: File;
      options: StatementLayoutOptions;
      /** 列の対応を直している（自動の当てはめをしない） */
      manual: boolean;
    }) => postImportLayout(entityId, file, options),
    onSuccess: (result, { file, options, manual: keepManual }) => {
      setLayout(result);
      setLayoutVersion((v) => v + 1);
      setEncodingOverride(options.encoding);
      setPickedSourceId(options.sourceId);
      setManual(keepManual);
      setChosen(undefined);
      setYear(thisYear());
      setRequest(undefined);
      setPreview(undefined);
      // 1 件が当てはまれば、列の画面を飛ばして確認へ進む（R8）
      if (result.match.kind === "one" && !keepManual) {
        previewMutation.mutate(
          requestFromSource(file, options.origin, result.encoding, result.match.source, thisYear()),
        );
      }
    },
  });

  const commitMutation = useMutation({
    mutationFn: ({
      r,
      expected,
      accounts,
    }: {
      r: Request;
      expected: { inputSha256: string; countNew: number };
      accounts: { name: string; input: StatementAccountInput }[];
    }) =>
      postImportCommit(entityId, r.file, {
        ...r.options,
        expected,
        accounts,
        saveSource: r.saveSource,
      }),
    onSuccess: async (result) => {
      setNotice(
        `${result.added} 件を取り込みました${result.changed > 0 ? `（変更あり ${result.changed} 件）` : ""}。`,
      );
      // 取り込んだら入力から始め直す
      setInput(undefined);
      setLayout(undefined);
      setRequest(undefined);
      setPreview(undefined);
      setAccountDrafts({});
      setInputVersion((v) => v + 1);
      // 取込の後は、ルールの作成 → 候補の作成 → AI の推定を自動で続け、終わったら確認へ（011 R9）
      const run = ++chainRun.current;
      const current = () => chainRun.current === run;
      setChain({ phase: "running", progress: {} });
      await Promise.all([
        // 口座の対応も確定で保存されたので、読み直す
        queryClient.invalidateQueries({ queryKey: statementKeys.accounts(entityId) }),
        queryClient.invalidateQueries({ queryKey: statementKeys.batches(entityId) }),
        // 取込元を保存・更新したので、一覧を読み直す
        queryClient.invalidateQueries({ queryKey: statementKeys.sources(entityId) }),
      ]);
      await runCandidateChain({
        entityId,
        queryClient,
        onProgress: (progress) => current() && setChain({ phase: "running", progress }),
        onError: (message) => current() && toast.error(message),
      });
      if (current()) setChain((c) => ({ phase: "done", progress: c?.progress ?? {} }));
    },
    onError: (e, { r }) => {
      // プレビューの後に内容が変わったときは、作り直して見せる
      if (e instanceof ApiError && e.code === "STATEMENT_PLAN_CHANGED") previewMutation.mutate(r);
    },
  });

  const resetResults = () => {
    setNotice("");
    setAccountDrafts({});
    commitMutation.reset();
    previewMutation.reset();
  };

  const startLayout = (next: Input) => {
    resetResults();
    // 新しい入力を読み取ったら、前の連鎖の進みと確認は消す
    chainRun.current += 1;
    setChain(undefined);
    // 新しい入力の判定が終わるまで、前の入力の列の対応・プレビューは見せない
    setLayout(undefined);
    setRequest(undefined);
    setPreview(undefined);
    setInput(next);
    layoutMutation.mutate({ file: next.file, options: { origin: next.origin }, manual: false });
  };

  /** 区切り・見出しの行・文字コードの選び直し。列を直している途中なので、自動の当てはめをしない */
  const relayout = (choice: RelayoutChoice) => {
    if (!input) return;
    resetResults();
    layoutMutation.mutate({
      file: input.file,
      options: {
        origin: input.origin,
        delimiter: choice.delimiter,
        headerRow: choice.headerRow,
        ...(choice.encoding === undefined ? {} : { encoding: choice.encoding }),
        ...(pickedSourceId === undefined ? {} : { sourceId: pickedSourceId }),
      },
      manual: true,
    });
  };

  /** 既存の取込元を選ぶ（その取込元の署名で判定をやり直す）。選ばない（undefined）は、選ぶ前の判定に戻す */
  const pickSource = (sourceId: string | undefined) => {
    if (!input || !layout) return;
    resetResults();
    layoutMutation.mutate({
      file: input.file,
      options: {
        origin: input.origin,
        delimiter: layout.delimiter,
        headerRow: layout.headerRow,
        ...(encodingOverride === undefined ? {} : { encoding: encodingOverride }),
        ...(sourceId === undefined ? {} : { sourceId }),
      },
      manual: false,
    });
  };

  const startPreview = (draft: ColumnMappingDraft) => {
    if (!input || !layout) return;
    resetResults();
    previewMutation.mutate({
      file: input.file,
      options: {
        origin: input.origin,
        year: draft.year,
        mapping: draft.mapping,
        // 読み取りで使った文字コードを、プレビューと確定にも送る
        encoding: layout.encoding,
        ...(draft.fixedAccountName === undefined
          ? {}
          : { fixedAccountName: draft.fixedAccountName }),
      },
      saveSource: draft.saveSource,
    });
  };

  // 当てはめた取込元（1 件が当てはまった、または 2 件以上から選んだ）。直している間（manual）は当てはめない
  const candidate = layout?.match.kind === "one" ? layout.match.source : chosen;
  const applied = layout !== undefined && !manual ? candidate : undefined;
  const choosing = layout?.match.kind === "many" && !manual && chosen === undefined;
  const showEditor = layout !== undefined && applied === undefined && !choosing;

  const applySource = (source: StatementSource, nextYear: number) => {
    if (!input || !layout) return;
    resetResults();
    previewMutation.mutate(
      requestFromSource(input.file, input.origin, layout.encoding, source, nextYear),
    );
  };

  const changedCount = preview?.rows.filter((r) => r.status === "changed").length ?? 0;
  const unmapped = preview?.unmappedAccounts ?? [];
  // 口座ごとの対応。用途・種類が未選択、または private 以外で科目が未選択（input が undefined）の口座は確定できない
  const accountInputs = unmapped.map(({ name, suggestion }) => ({
    name,
    draft: accountDrafts[name] ?? draftFromSuggestion(suggestion),
  }));
  const incompleteNames = accountInputs
    .filter(({ draft }) => inputFromDraft(draft) === undefined)
    .map(({ name }) => name);
  const nothingToImport = preview !== undefined && preview.countNew === 0 && changedCount === 0;
  const canCommit =
    preview !== undefined &&
    request !== undefined &&
    incompleteNames.length === 0 &&
    !nothingToImport &&
    !commitMutation.isPending;

  /** 確定で送る口座の対応（そろっている口座だけ。canCommit のときは全部） */
  const accountsToSend = () =>
    accountInputs.flatMap(({ name, draft }) => {
      const accountInput = inputFromDraft(draft);
      return accountInput === undefined ? [] : [{ name, input: accountInput }];
    });

  const step = chain !== undefined ? 3 : preview !== undefined ? 2 : layout !== undefined ? 1 : 0;

  return (
    <div className="grid gap-8">
      <Steps steps={IMPORT_STEPS} current={step} label="取込の手順" />
      <section aria-label="入力" className="grid gap-3">
        <StatementInput
          key={inputVersion}
          primary={step === 0}
          pending={layoutMutation.isPending}
          onRead={startLayout}
        />
        <ApiErrorMessage error={layoutMutation.error} />
        {notice && <SaveNotice message={notice} />}
      </section>

      {chain && (
        <section aria-label="候補の作成" className="grid gap-3">
          <h2 className="text-lg font-semibold">候補の作成</h2>
          <ChainStatus progress={chain.progress} phase={chain.phase} />
        </section>
      )}
      {chain?.phase === "done" && <ReviewQueue entityId={entityId} />}

      {layout && applied && (
        <section aria-label="取込元" className="grid gap-4">
          <h2 className="text-lg font-semibold">取込元</h2>
          <AppliedSource
            key={layoutVersion}
            source={applied}
            needsYear={layout.needsYear}
            year={year}
            pending={layoutMutation.isPending || previewMutation.isPending}
            onYearChange={(next) => {
              setYear(next);
              applySource(applied, next);
            }}
            onEditColumns={() => setManual(true)}
          />
          <ApiErrorMessage error={previewMutation.error} />
        </section>
      )}

      {layout && choosing && layout.match.kind === "many" && (
        <section aria-label="取込元" className="grid gap-4">
          <h2 className="text-lg font-semibold">取込元</h2>
          <SourceChooser
            sources={layout.match.sources}
            pending={previewMutation.isPending}
            onChoose={(source) => {
              setChosen(source);
              applySource(source, year);
            }}
            onSkip={() => setManual(true)}
          />
        </section>
      )}

      {layout && showEditor && (
        <section aria-label="列の対応" className="grid gap-4">
          <h2 className="text-lg font-semibold">列の対応</h2>
          <ColumnMappingEditor
            key={`${layoutVersion}-${candidate?.id ?? ""}`}
            entityId={entityId}
            layout={layout}
            encodingOverride={encodingOverride}
            input={input}
            pending={layoutMutation.isPending || previewMutation.isPending}
            sources={sources.data ?? []}
            pickedSourceId={pickedSourceId}
            initial={candidate === undefined ? undefined : { source: candidate, year }}
            primary={preview === undefined}
            onRelayout={relayout}
            onPickSource={pickSource}
            onConfirm={startPreview}
          />
          <ApiErrorMessage error={previewMutation.error} />
        </section>
      )}

      {preview && (
        <section aria-label="プレビュー" className="grid gap-4">
          <h2 className="text-lg font-semibold">プレビュー</h2>
          <ImportPreview preview={preview} />

          {unmapped.length > 0 && (
            <div className="grid gap-3">
              <h3 className="font-medium">口座の対応</h3>
              <p className="text-sm text-muted-foreground">
                対応づいていない口座があります。推定を確かめて用途などを決めてください。「取り込む」で、明細と一緒に口座の対応も保存します。
              </p>
              {accountInputs.map(({ name, draft }, i) => (
                <AccountMappingForm
                  key={name}
                  entityId={entityId}
                  name={name}
                  suggestion={unmapped[i]?.suggestion ?? null}
                  value={draft}
                  onChange={(next) => setAccountDrafts((prev) => ({ ...prev, [name]: next }))}
                />
              ))}
              {incompleteNames.length > 0 && (
                <p className="text-sm text-destructive">
                  用途・種類・科目を選んでいない口座があります: {incompleteNames.join("、")}
                </p>
              )}
            </div>
          )}

          {nothingToImport && (
            <p className="text-sm text-muted-foreground">新しく取り込む明細はありません。</p>
          )}
          <ApiErrorMessage error={commitMutation.error} />
          <div>
            <Button
              disabled={!canCommit}
              onClick={() =>
                request &&
                commitMutation.mutate({
                  r: request,
                  expected: { inputSha256: preview.inputSha256, countNew: preview.countNew },
                  accounts: accountsToSend(),
                })
              }
            >
              取り込む
            </Button>
          </div>
        </section>
      )}

      <BatchHistory entityId={entityId} />
    </div>
  );
}
