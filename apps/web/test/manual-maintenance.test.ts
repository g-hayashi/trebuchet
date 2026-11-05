import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { manualArticles } from "@/features/manual/content";
import {
  compareManualSnapshots,
  type ManualSnapshot,
} from "../../../scripts/lib/manual-snapshot.ts";
import { manualSources } from "../../../scripts/lib/manual-sources.ts";

const baseline: ManualSnapshot = {
  routes: ["/", "/list"],
  articles: {
    start: { sources: { "auth.tsx": "old" }, images: { "start.png": "png" } },
    list: {
      sources: { "entities.tsx": "same", "rule.ts": "condition" },
      images: { "list.png": "png2" },
    },
  },
};

describe("マニュアルの更新漏れ検知", () => {
  it("参照先の処理条件を追跡し、無関係なファイルは対象にしない", () => {
    const root = mkdtempSync(resolve(import.meta.dirname, "../../../.tmp/manual-sources-"));
    try {
      mkdirSync(resolve(root, "src"));
      writeFileSync(
        resolve(root, "src/view.ts"),
        'import { condition } from "./condition.ts";\nexport { condition };',
      );
      writeFileSync(resolve(root, "src/condition.ts"), "export const condition = true;");
      const source = manualArticles[0];
      if (!source) throw new Error("article fixture missing");
      const article = { ...source, sources: ["src/view.ts"], paths: [] };
      const before = manualSources(root, article);
      writeFileSync(resolve(root, "src/unrelated.ts"), "export const unrelated = true;");
      expect(manualSources(root, article)).toEqual(before);
      writeFileSync(resolve(root, "src/condition.ts"), "export const condition = false;");
      expect(manualSources(root, article)["src/view.ts"]).not.toBe(before["src/view.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("変更のない状態と対象外の変更では更新を要求しない", () => {
    expect(compareManualSnapshots(baseline, structuredClone(baseline))).toEqual([]);
  });
  it.each(["auth.tsx", "rule.ts"])("UIまたは処理条件 %s の変更を記事へ対応付ける", (path) => {
    const current = structuredClone(baseline);
    const id = path === "auth.tsx" ? "start" : "list";
    const article = current.articles[id];
    if (!article) throw new Error("fixture missing");
    article.sources[path] = "changed";
    expect(compareManualSnapshots(baseline, current)).toEqual([
      `${id}: 根拠の変更。本文・FAQ・画像を確認してください。`,
    ]);
  });
  it.each([{ routes: ["/", "/list", "/new"] }, { routes: ["/"] }])(
    "画面の追加・削除を検出する",
    ({ routes }) => {
      expect(compareManualSnapshots(baseline, { ...baseline, routes })).toContain(
        "画面構成が変わっています。記事の対応を確認してください。",
      );
    },
  );
  it("欠落・失敗した画像を検出する", () => {
    const current = structuredClone(baseline);
    delete current.articles.start?.images["start.png"];
    expect(compareManualSnapshots(baseline, current)).toContain(
      "start: 画像の変更または欠落。撮影と表示を確認してください。",
    );
  });
});
