/** pnpm manual:check。確認・再撮影後だけ pnpm manual:record で確認版を更新する。 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  articleForPath,
  manualArticles,
  manualImages,
} from "../apps/web/src/features/manual/content.ts";
import { compareManualSnapshots, type ManualSnapshot } from "./lib/manual-snapshot.ts";
import { manualFiles as files, manualHash as hash, manualSources } from "./lib/manual-sources.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "docs/manual-snapshot.json");
const issues: string[] = [];
const routeFiles = files(resolve(root, "apps/web/src/routes"));
const routes = [
  ...new Set(
    routeFiles.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/createFileRoute\("([^"]+)"\)/g)].map(
        (match) => (match[1] ?? "").replace(/\/$/, "") || "/",
      ),
    ),
  ),
].sort();
for (const route of routes) {
  if (route === "/e/$entityId" || articleForPath(route)) continue;
  issues.push(`記事のない画面: ${route}`);
}
const current: ManualSnapshot = { routes, articles: {} };
const ids = new Set<string>();
for (const article of manualArticles) {
  if (ids.has(article.id)) issues.push(`記事IDの重複: ${article.id}`);
  ids.add(article.id);
  for (const path of article.paths)
    if (!routes.includes(path)) issues.push(`${article.id}: 存在しない画面の対応: ${path}`);
  const sources = manualSources(root, article);
  for (const [source, value] of Object.entries(sources))
    if (value === "MISSING") issues.push(`${article.id}: 根拠が存在しません: ${source}`);
  const images: Record<string, string> = {};
  for (const shot of manualImages(article)) {
    const imagePath = `apps/web/public/manual/${shot.image}.png`;
    const absoluteImage = resolve(root, imagePath);
    if (!existsSync(absoluteImage)) issues.push(`${article.id}: 画像がありません: ${imagePath}`);
    else {
      const bytes = readFileSync(absoluteImage);
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        issues.push(`${article.id}: PNGが不正です`);
      images[imagePath] = hash(bytes);
    }
  }
  for (const id of article.related)
    if (!manualArticles.some((entry) => entry.id === id))
      issues.push(`${article.id}: 関連記事がありません: ${id}`);
  current.articles[article.id] = { sources, images };
}
if (process.argv.includes("--record")) {
  const capture = resolve(root, ".tmp/manual-capture/success.json");
  if (!existsSync(capture))
    issues.push("成功した再撮影の記録がありません。pnpm manual:capture を実行してください。");
  else {
    const captured = JSON.parse(readFileSync(capture, "utf8")) as {
      images: Record<string, string>;
      sources: Record<string, Record<string, string>>;
    };
    for (const article of manualArticles) {
      if (
        JSON.stringify(captured.sources?.[article.id]) !==
        JSON.stringify(current.articles[article.id]?.sources)
      )
        issues.push(`${article.id}: 撮影後に根拠が変わっています。確認して再撮影してください。`);
      for (const shot of manualImages(article)) {
        const image = `apps/web/public/manual/${shot.image}.png`;
        if (captured.images[image] !== current.articles[article.id]?.images[image])
          issues.push(`${article.id}: 再撮影した画像と一致しません。`);
      }
    }
  }
  if (!issues.length) writeFileSync(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
} else if (!existsSync(manifestPath))
  issues.push(
    "確認版がありません。操作・本文・画像を確認して pnpm manual:record を実行してください。",
  );
else
  issues.push(
    ...compareManualSnapshots(
      JSON.parse(readFileSync(manifestPath, "utf8")) as ManualSnapshot,
      current,
    ),
  );
if (issues.length) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `マニュアル: ${manualArticles.length}記事・${routes.length}画面の対応と画像・根拠を確認しました。`,
  );
