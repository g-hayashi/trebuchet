import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReceiptDetail } from "@trebuchet/schema";
import { type FormEvent, useState } from "react";
import { Loading } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiErrorMessage, FieldError } from "@/components/ui/form-error";
import { Input } from "@/components/ui/input";
import { journalSearchQuery } from "@/features/journals/api";
import { isApiError } from "@/lib/api";
import { formatYen } from "@/lib/format";
import { invalidateLedger } from "@/lib/queries";
import { journalCandidatesQuery, postReceiptLink } from "./api";

type Pick = { journalId: string; reason?: string };

/**
 * 証憑を仕訳に結びつけるダイアログ（FR-011・013）。取引年月日の前後の候補（R6）と、
 * キーワードで探した仕訳を示し、選ぶと link を送る。
 * 結びついた仕訳がある証憑は付け替えなので `replace: true` で送る。理由の要否は web で判断せず、
 * server が 422 `REASON_REQUIRED` を返したら理由の入力を求めて送り直す。
 * 成功したら仕訳・帳票・証憑のクエリを読み直す（`invalidateLedger`）
 */
export function LinkJournalDialog({
  entityId,
  receipt,
  open,
  onClose,
}: {
  entityId: string;
  receipt: ReceiptDetail;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const replacing = receipt.linkState === "linked";
  const candidates = useQuery({ ...journalCandidatesQuery(entityId, receipt.id), enabled: open });
  const [keyword, setKeyword] = useState("");
  const [searched, setSearched] = useState<string>();
  const found = useInfiniteQuery({
    ...journalSearchQuery(entityId, { includeVoided: false, q: searched }),
    enabled: open && searched !== undefined,
  });
  const [chosen, setChosen] = useState<string>();
  const [reason, setReason] = useState("");

  const link = useMutation({
    mutationFn: (pick: Pick) =>
      postReceiptLink(entityId, receipt.id, {
        journalId: pick.journalId,
        ...(replacing && { replace: true }),
        ...(pick.reason !== undefined && { reason: pick.reason }),
      }),
    onSuccess: async () => {
      await invalidateLedger(queryClient, entityId);
      close();
    },
  });

  const close = () => {
    setChosen(undefined);
    setReason("");
    setKeyword("");
    setSearched(undefined);
    link.reset();
    onClose();
  };

  const needReason = isApiError(link.error, "REASON_REQUIRED");
  const choose = (journalId: string) => {
    setChosen(journalId);
    setReason("");
    link.mutate({ journalId });
  };
  const confirmReason = (e: FormEvent) => {
    e.preventDefault();
    if (chosen === undefined || reason.trim() === "") return;
    link.mutate({ journalId: chosen, reason });
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    const q = keyword.trim();
    setSearched(q === "" ? undefined : q);
  };

  const items = found.data?.pages.flatMap((p) => p.journals);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !link.isPending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>仕訳に結びつける</DialogTitle>
          <DialogDescription>
            {replacing
              ? "いま結びついている仕訳から、別の仕訳に付け替えます。"
              : "この証憑の根拠になる仕訳を選びます。"}
          </DialogDescription>
        </DialogHeader>

        <section aria-label="候補の仕訳" className="grid gap-2">
          <h3 className="text-sm font-medium">候補（取引年月日の前後）</h3>
          <ApiErrorMessage error={candidates.error} />
          {candidates.isPending && <Loading />}
          {candidates.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">候補の仕訳がありません。</p>
          )}
          <ul className="grid gap-2">
            {candidates.data?.map((c) => (
              <li key={c.journal.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  仕訳 No.{c.journal.journalNo}（
                  <span className="tabular-nums">{c.journal.date}</span>） 借方合計{" "}
                  <span className="tabular-nums">{formatYen(c.total)}</span>
                  {c.amountMatches && <strong className="ml-2 font-medium">金額が一致</strong>}
                </span>
                <Button
                  variant="outline"
                  disabled={link.isPending}
                  aria-label={`仕訳 No.${c.journal.journalNo} に結びつける`}
                  onClick={() => choose(c.journal.id)}
                >
                  結びつける
                </Button>
              </li>
            ))}
          </ul>
        </section>

        {/* biome-ignore lint/a11y/noRedundantRoles: search 要素の暗黙のロールに未対応の支援技術・ブラウザがあるため明示する */}
        <search role="search" aria-label="仕訳を探す" className="grid gap-2">
          <form noValidate onSubmit={search} className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <label htmlFor="link-journal-q" className="text-sm font-medium">
                キーワード
              </label>
              <Input
                id="link-journal-q"
                autoComplete="off"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>
            <Button type="submit" variant="outline">
              検索
            </Button>
          </form>
          <ApiErrorMessage error={found.error} />
          {items?.length === 0 && (
            <p className="text-sm text-muted-foreground">条件に合う仕訳がありません。</p>
          )}
          <ul className="grid gap-2">
            {items?.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">
                  仕訳 No.{j.journalNo}（<span className="tabular-nums">{j.date}</span>） 借方合計{" "}
                  <span className="tabular-nums">
                    {formatYen(
                      j.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0),
                    )}
                  </span>
                </span>
                <Button
                  variant="outline"
                  disabled={link.isPending}
                  aria-label={`仕訳 No.${j.journalNo} に結びつける`}
                  onClick={() => choose(j.id)}
                >
                  結びつける
                </Button>
              </li>
            ))}
          </ul>
        </search>

        {needReason ? (
          <form noValidate onSubmit={confirmReason} className="grid gap-2">
            <label htmlFor="link-reason" className="text-sm font-medium">
              理由
            </label>
            <Input
              id="link-reason"
              autoComplete="off"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-describedby="link-reason-error"
            />
            <FieldError id="link-reason-error" message={link.error?.message} />
            <Button type="submit" disabled={reason.trim() === "" || link.isPending}>
              付け替えを確定
            </Button>
          </form>
        ) : (
          <ApiErrorMessage error={link.error} />
        )}

        <DialogFooter>
          <Button variant="outline" disabled={link.isPending} onClick={close}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
