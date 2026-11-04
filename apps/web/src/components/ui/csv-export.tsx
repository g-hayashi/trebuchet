import { Button } from "@/components/ui/button";

/**
 * 「CSV に書き出す」（FR-054）。server が返す CSV を `download` のリンクで保存する。
 * 0 件なら書き出すものがないので、押せないボタンにする（リンクは無効にできない）
 */
export function CsvExport({ href, disabled }: { href: string; disabled: boolean }) {
  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled>
        CSV に書き出す
      </Button>
    );
  }
  return (
    <a
      href={href}
      download
      className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium shadow-xs hover:bg-muted"
    >
      CSV に書き出す
    </a>
  );
}
