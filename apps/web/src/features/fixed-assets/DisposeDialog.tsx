import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
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
import { blueReturnKeys } from "@/features/blue-return/api";
import { disposeFixedAsset, type FixedAssetRow, fixedAssetKeys } from "./api";

/**
 * 固定資産の除却（FR-018）。除却の日と理由を記録する。台帳から消さず、履歴に残る。
 * 取得の日より前の日付などの判定は API が行い、失敗はダイアログの中に出す
 */
export function DisposeDialog({
  entityId,
  asset,
  onClose,
}: {
  entityId: string;
  asset: FixedAssetRow | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [disposedOn, setDisposedOn] = useState("");
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState<string>();

  const close = () => {
    setDisposedOn("");
    setReason("");
    setMissing(undefined);
    dispose.reset();
    onClose();
  };
  const dispose = useMutation({
    mutationFn: (target: FixedAssetRow) =>
      disposeFixedAsset(entityId, target.id, { disposedOn, reason }),
    onSuccess: async () => {
      close();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: fixedAssetKeys.all(entityId) }),
        queryClient.invalidateQueries({ queryKey: blueReturnKeys.all(entityId) }),
      ]);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!asset) return;
    if (disposedOn === "" || reason.trim() === "") {
      setMissing("除却年月日と理由を入力してください");
      return;
    }
    setMissing(undefined);
    dispose.mutate(asset);
  };

  return (
    <Dialog open={asset !== undefined} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form noValidate onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{asset ? `${asset.name}を除却` : "資産を除却"}</DialogTitle>
            <DialogDescription>
              除却しても台帳には残ります。除却の日と理由は履歴に記録されます。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1">
            <label htmlFor="dispose-date" className="text-sm font-medium">
              除却年月日
            </label>
            <Input
              id="dispose-date"
              type="date"
              value={disposedOn}
              onChange={(e) => setDisposedOn(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor="dispose-reason" className="text-sm font-medium">
              理由
            </label>
            <Input
              id="dispose-reason"
              autoComplete="off"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-describedby="dispose-error"
            />
            <FieldError id="dispose-error" message={missing} />
          </div>
          <ApiErrorMessage error={dispose.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              戻る
            </Button>
            <Button type="submit" disabled={dispose.isPending}>
              除却する
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
