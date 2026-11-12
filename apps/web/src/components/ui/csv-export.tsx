import { Button, buttonVariants } from "@/components/ui/button";

/**
 * 「CSV をダウンロード」（FR-054、FR-032）。server が返す CSV を `download` のリンクで保存する。
 * 一覧・帳票・決算書で共通。0 件なら書き出すものがないので、押せないボタンにする（リンクは無効にできない）
 */
export function CsvExport({ href, disabled = false }: { href: string; disabled?: boolean }) {
  if (disabled) {
    return (
      <Button variant="outline" disabled>
        CSV をダウンロード
      </Button>
    );
  }
  return (
    <a href={href} download className={buttonVariants({ variant: "outline" })}>
      CSV をダウンロード
    </a>
  );
}
