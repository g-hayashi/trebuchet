export type ManualSnapshot = {
  routes: string[];
  articles: Record<string, { sources: Record<string, string>; images: Record<string, string> }>;
};

function sameEntries(a: Record<string, string>, b: Record<string, string>) {
  return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
}

export function compareManualSnapshots(
  previous: ManualSnapshot,
  current: ManualSnapshot,
): string[] {
  const issues: string[] = [];
  if (JSON.stringify([...previous.routes].sort()) !== JSON.stringify([...current.routes].sort())) {
    issues.push("画面構成が変わっています。記事の対応を確認してください。");
  }
  for (const id of new Set([...Object.keys(previous.articles), ...Object.keys(current.articles)])) {
    const before = previous.articles[id];
    const after = current.articles[id];
    if (!before || !after) {
      issues.push(`${id}: 記事の追加・削除。画面との対応を確認してください。`);
      continue;
    }
    if (!sameEntries(before.sources, after.sources))
      issues.push(`${id}: 根拠の変更。本文・FAQ・画像を確認してください。`);
    if (!sameEntries(before.images, after.images))
      issues.push(`${id}: 画像の変更または欠落。撮影と表示を確認してください。`);
  }
  return issues;
}
