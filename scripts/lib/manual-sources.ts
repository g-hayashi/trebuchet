import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { ManualArticle } from "../../apps/web/src/features/manual/content.ts";

export const manualHash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");

export function manualFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((name) => manualFiles(resolve(path, name)));
}

/** 記事に関係する表示・処理と、そこから参照するローカルの部品を追う。 */
export function manualSources(root: string, article: ManualArticle): Record<string, string> {
  const shared = [
    "apps/web/src/components/layout",
    "apps/web/src/components/ui",
    "apps/web/src/index.css",
    "apps/web/src/routes/__root.tsx",
    "packages/schema/src",
  ];
  const routes = manualFiles(resolve(root, "apps/web/src/routes"))
    .filter((file) => {
      const path = readFileSync(file, "utf8").match(/createFileRoute\("([^"]+)"\)/)?.[1];
      return (
        path !== undefined &&
        article.paths.some((item) => item.replace(/\/$/, "") === path.replace(/\/$/, ""))
      );
    })
    .map((file) => relative(root, file));
  const result: Record<string, string> = {};
  for (const source of [...article.sources, ...shared, ...routes]) {
    const visited = new Set<string>();
    function visit(file: string) {
      // 記事本文は下のarticleハッシュで個別に追跡し、他の記事へ伝播させない。
      if (file === resolve(root, "apps/web/src/features/manual/content.ts")) return;
      if (visited.has(file)) return;
      visited.add(file);
      const text = readFileSync(file, "utf8");
      if (!/\.[cm]?[jt]sx?$/.test(file)) return;
      for (const match of text.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (!specifier || (!specifier.startsWith(".") && !specifier.startsWith("@/"))) continue;
        const base = specifier.startsWith("@/")
          ? resolve(root, "apps/web/src", specifier.slice(2))
          : resolve(dirname(file), specifier);
        const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")].find(
          (path) => existsSync(path) && statSync(path).isFile(),
        );
        if (target) visit(target);
      }
    }
    const files = manualFiles(resolve(root, source));
    for (const file of files) visit(file);
    result[source] = files.length
      ? manualHash(
          [...visited]
            .sort()
            .map((file) => `${relative(root, file)}:${manualHash(readFileSync(file))}`)
            .join("\n"),
        )
      : "MISSING";
  }
  result.article = manualHash(JSON.stringify(article));
  return result;
}
