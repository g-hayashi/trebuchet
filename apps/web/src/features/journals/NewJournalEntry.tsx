import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { JournalDraft, JournalInput } from "@trebuchet/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiErrorMessage } from "@/components/ui/form-error";
import {
  deleteJournalDraft,
  journalDraftQuery,
  journalKeys,
  journalQuery,
  putJournalDraft,
} from "./api";
import { canUseQuickEntry, JournalForm, type JournalFormProps } from "./JournalForm";

type Props = Omit<JournalFormProps, "initialMode" | "draft" | "onDraftChange" | "journal"> & {
  from?: string | undefined;
};

/** 新規入力専用。訂正・証憑経由は既存のフォームを使い、下書きを読み書きしない。 */
export function NewJournalEntry({ from, onSubmit, ...props }: Props) {
  const { entityId, defaultDate } = props;
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<{
    draft: JournalDraft | undefined;
    mode?: JournalDraft["mode"] | undefined;
  }>();
  // 入力を開始した後は、再取得した初期値でフォームを置き換えない。
  const stored = useQuery({ ...journalDraftQuery(entityId), enabled: selection === undefined });
  const original = useQuery({
    ...journalQuery(entityId, from ?? ""),
    enabled: from !== undefined && selection === undefined,
  });
  const copied = useMemo<JournalDraft | undefined>(() => {
    if (!original.data) return undefined;
    const journal = original.data.journal;
    const lines = journal.lines.map((line) => ({
      side: line.side,
      accountId: line.accountId,
      subAccountId: line.subAccountId,
      amount: line.amount,
      taxCategory: line.taxCategory,
      partnerId: line.partnerId,
      description: line.description,
      tagIds: [...line.tagIds],
    }));
    return {
      mode: canUseQuickEntry(lines) ? "quick" : "detailed",
      date: defaultDate,
      memo: journal.memo ?? "",
      partnerId: null,
      tagIds: [],
      lines,
    };
  }, [original.data, defaultDate]);
  const [key, setKey] = useState(0);
  const [date, setDate] = useState(defaultDate);
  const [saveError, setSaveError] = useState<unknown>();
  const [deleteError, setDeleteError] = useState<unknown>();
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState("");
  const latest = useRef<JournalDraft | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const generation = useRef(0);
  const blocked = useRef(false);
  const mounted = useRef(true);
  const afterDelete = useRef<() => void>(() => {});
  /** デバウンス待ちで、まだ PUT していない下書き */
  const unsavedDraft = useRef<JournalDraft | undefined>(undefined);
  const writeRef = useRef<(draft: JournalDraft) => void>(() => {});
  useEffect(() => {
    if (
      selection === undefined &&
      stored.data?.draft === null &&
      (from === undefined || original.isSuccess)
    ) {
      setSelection({ draft: copied });
    }
  }, [selection, stored.data, from, original.isSuccess, copied]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      generation.current += 1;
      // デバウンス待ちの最後の入力は、画面を離れる前にその場で 1 回保存する（登録・削除の後は書かない）
      const unsaved = unsavedDraft.current;
      unsavedDraft.current = undefined;
      if (unsaved && !blocked.current) writeRef.current(unsaved);
    };
  }, []);

  function write(draft: JournalDraft) {
    const version = generation.current;
    queue.current = queue.current.then(async () => {
      if (version !== generation.current || blocked.current) return;
      if (mounted.current) {
        setSaveError(undefined);
        setStatus("下書きを保存中…");
      }
      try {
        const result = await putJournalDraft(entityId, draft);
        queryClient.setQueryData(journalKeys.draft(entityId), {
          draft,
          updatedAt: result.updatedAt,
        });
        if (mounted.current && version === generation.current)
          setStatus(
            latest.current === draft
              ? "下書きを保存しました。"
              : "下書きに未保存の変更があります。",
          );
      } catch (error) {
        if (mounted.current && version === generation.current) {
          setSaveError(error);
          setStatus("");
        }
      }
    });
  }
  writeRef.current = write;
  function changed(draft: JournalDraft) {
    if (blocked.current) return;
    latest.current = draft;
    unsavedDraft.current = draft;
    clearTimeout(timer.current);
    setStatus("下書きに未保存の変更があります。");
    timer.current = setTimeout(() => {
      unsavedDraft.current = undefined;
      write(draft);
    }, 1000);
  }
  async function erase() {
    clearTimeout(timer.current);
    unsavedDraft.current = undefined;
    generation.current += 1;
    blocked.current = true;
    setDeleting(true);
    setDeleteError(undefined);
    setSaveError(undefined);
    // 既に開始した PUT は止められない。必ずその完了後に DELETE を最後に実行する。
    const operation = queue.current.then(async () => {
      await deleteJournalDraft(entityId);
      queryClient.setQueryData(journalKeys.draft(entityId), { draft: null, updatedAt: null });
    });
    queue.current = operation.catch(() => {});
    try {
      await operation;
      if (!mounted.current) return;
      latest.current = undefined;
      setStatus("");
      afterDelete.current();
      blocked.current = false;
    } catch (error) {
      if (mounted.current) setDeleteError(error);
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }
  function chooseCopy() {
    afterDelete.current = () => setSelection({ draft: copied });
    void erase();
  }
  function discard() {
    afterDelete.current = () => setSelection({ draft: undefined });
    void erase();
  }
  async function submit(input: JournalInput) {
    const submittedMode = latest.current?.mode ?? mode;
    // 登録に失敗した場合は下書きを残す。削除の失敗は登録成功を取り消さない。
    await onSubmit(input);
    afterDelete.current = () => {
      setSelection({ draft: undefined, mode: submittedMode });
      setDate(input.date);
      setKey((value) => value + 1);
    };
    await erase();
  }
  const error = selection === undefined ? (stored.error ?? original.error) : undefined;
  if (error)
    return (
      <div className="grid gap-2">
        <ApiErrorMessage error={error} />
        {stored.error && (
          <Button variant="outline" onClick={() => void stored.refetch()}>
            下書き読込を再試行
          </Button>
        )}
        {original.error && (
          <Button variant="outline" onClick={() => void original.refetch()}>
            複製元を再読込
          </Button>
        )}
      </div>
    );
  if (selection === undefined && (stored.isPending || (from !== undefined && original.isPending)))
    return <p className="text-sm text-muted-foreground">下書き・複製元を読み込み中…</p>;
  const choiceNeeded = selection === undefined && stored.data?.draft != null;
  const source = selection ? selection.draft : copied;
  const mode =
    source?.mode === "detailed" || (source && !canUseQuickEntry(source.lines))
      ? "detailed"
      : (selection?.mode ?? "quick");
  return (
    <div className="grid gap-3">
      <ApiErrorMessage error={deleteError ?? saveError} />
      {Boolean(deleteError) && (
        <Button variant="outline" disabled={deleting} onClick={() => void erase()}>
          下書き削除を再試行
        </Button>
      )}
      {Boolean(saveError) && !deleteError && (
        <Button
          variant="outline"
          onClick={() => {
            if (latest.current) write(latest.current);
          }}
        >
          下書き保存を再試行
        </Button>
      )}
      {choiceNeeded ? (
        <div className="grid gap-3 rounded-md border p-3">
          <p className="text-sm">
            {from
              ? "保存済みの下書きがあります。複製を使うと下書きを置き換えます。"
              : "保存済みの下書きがあります。続けますか。"}
          </p>
          <div className="flex flex-wrap gap-2">
            {from && (
              <Button variant="outline" disabled={deleting || !!deleteError} onClick={chooseCopy}>
                複製を使う
              </Button>
            )}
            <Button
              variant="outline"
              disabled={deleting || !!deleteError}
              onClick={() => setSelection({ draft: stored.data?.draft ?? undefined })}
            >
              {from ? "下書きを続ける" : "続ける"}
            </Button>
            {!from && (
              <Button variant="outline" disabled={deleting || !!deleteError} onClick={discard}>
                捨てる
              </Button>
            )}
          </div>
        </div>
      ) : (
        <JournalForm
          {...props}
          key={key}
          draft={source}
          initialMode={mode}
          allowModeSwitch
          focusAfterSave={key > 0}
          defaultDate={date}
          onDraftChange={changed}
          historySuggestions
          disabled={deleting || !!deleteError}
          onSubmit={submit}
        />
      )}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {status}
      </p>
    </div>
  );
}
