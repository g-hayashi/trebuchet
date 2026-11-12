import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 「タイトル + 説明 + （エラー）+ やめる + 確定」の確認のダイアログ。
 * 理由の入力があるときは `ReasonDialog`。エラーの表示などは children に置く（説明とボタンの間）。
 * 閉じる操作（Esc・外側のクリック）は onOpenChange で受ける（閉じてよいかの判定は呼び出し側）
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel,
  confirmLabel,
  confirmVariant,
  cancelDisabled,
  confirmDisabled,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  cancelLabel: string;
  confirmLabel: ReactNode;
  confirmVariant?: "default" | "destructive" | undefined;
  cancelDisabled?: boolean | undefined;
  confirmDisabled?: boolean | undefined;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" disabled={cancelDisabled} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
