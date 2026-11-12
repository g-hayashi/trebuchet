import type { ReceiptDetail } from "@trebuchet/schema";
import { receiptFileUrl } from "./api";

/**
 * 証憑の表示（010/FR-009）。画像は `<img>`、PDF は埋め込み。HEIC は server が表示用に JPEG へ変換する。
 * 原本は変換しないまま取り出せる（010/R12）
 */
export function ReceiptViewer({
  entityId,
  receipt,
}: {
  entityId: string;
  receipt: Pick<ReceiptDetail, "id" | "currentFile">;
}) {
  const { sha256, mediaType } = receipt.currentFile;
  const display = receiptFileUrl(entityId, receipt.id, sha256, "display");
  const original = receiptFileUrl(entityId, receipt.id, sha256, "original", true);

  return (
    <div className="grid gap-2">
      {mediaType === "application/pdf" ? (
        <object
          data={display}
          type="application/pdf"
          aria-label="証憑の PDF"
          className="h-[70vh] w-full rounded-md border"
        >
          <p className="p-4 text-sm">
            PDF を表示できません。「原本を取り出す」から保存して開いてください。
          </p>
        </object>
      ) : (
        <img
          src={display}
          alt="証憑の画像"
          className="max-h-[70vh] max-w-full justify-self-start rounded-md border object-contain"
        />
      )}
      {mediaType === "image/heic" && (
        <p className="text-sm text-muted-foreground">表示用に JPEG へ変換した画像です。</p>
      )}
      <div>
        <a href={original} className="text-sm underline">
          原本を取り出す
        </a>
      </div>
    </div>
  );
}
