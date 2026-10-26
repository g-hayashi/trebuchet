/**
 * 明細の内容の正規化（006 R9）: NFKC → 大文字 → 空白を除く → 3 桁以上の数字の並びを `#` にする。
 * 明細のキー（R3）とルールの一致（R9）が使う。冪等
 */
export function normalizeContent(content: string): string {
  return content
    .normalize("NFKC")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/\d{3,}/g, "#");
}
