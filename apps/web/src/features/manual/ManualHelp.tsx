import { useRouterState } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { articleForPath, type ManualArticle, manualArticles, searchManual } from "./content";

function Screenshot({ image, caption }: { image: string; caption: string }) {
  return (
    <figure className="space-y-2">
      <a
        href={`/manual/${image}.png`}
        target="_blank"
        rel="noreferrer"
        className="block rounded-md border focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`${caption}の画面を拡大（別タブ）`}
      >
        <img
          src={`/manual/${image}.png`}
          alt={caption}
          className="h-auto w-full rounded-md"
          loading="lazy"
          width={1280}
          height={900}
        />
      </a>
      <figcaption className="text-sm leading-6 text-muted-foreground">
        {caption} 画像を押すと別タブで拡大できます。
      </figcaption>
    </figure>
  );
}

function Article({
  article,
  onSelect,
}: {
  article: ManualArticle;
  onSelect: (id: string) => void;
}) {
  return (
    <article className="mx-auto w-full max-w-[70ch] space-y-8 pb-8" aria-label={article.title}>
      <div className="space-y-3">
        <h2 tabIndex={-1} className="text-2xl font-semibold leading-snug outline-none">
          {article.title}
        </h2>
        <p className="leading-7">{article.summary}</p>
        <dl className="space-y-3 rounded-md bg-muted p-4 text-sm leading-6">
          <div>
            <dt className="font-semibold">開始画面</dt>
            <dd>{article.start}</dd>
          </div>
          <div>
            <dt className="font-semibold">事前に確認</dt>
            <dd>{article.prerequisite}</dd>
          </div>
        </dl>
      </div>
      <section className="space-y-3" aria-label="注意事項">
        <h3 className="text-lg font-semibold">注意事項</h3>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6">
          {article.cautions.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>
      <Screenshot image={article.image} caption={article.caption} />
      <section className="space-y-4" aria-label="操作手順">
        <h3 className="text-lg font-semibold">操作手順</h3>
        <ol className="list-decimal space-y-6 pl-6 marker:font-semibold">
          {article.steps.map(([title, body], index) => (
            <li key={title} className="space-y-3 pl-1">
              <h4 className="font-semibold leading-7">{title}</h4>
              <p className="text-sm leading-7">{body}</p>
              {article.stepImages
                ?.filter((shot) => shot.afterStep === index)
                .map((shot) => (
                  <Screenshot key={shot.image} image={shot.image} caption={shot.caption} />
                ))}
            </li>
          ))}
        </ol>
      </section>
      <section className="space-y-3" aria-label="FAQ">
        <h3 className="text-lg font-semibold">FAQ・困ったとき</h3>
        <div className="divide-y border-y">
          {article.faq.map(([question, answer]) => (
            <details key={question} className="py-3">
              <summary className="cursor-pointer rounded-sm text-sm font-medium leading-6 focus-visible:outline-2 focus-visible:outline-ring">
                {question}
              </summary>
              <p className="mt-2 text-sm leading-7">{answer}</p>
            </details>
          ))}
        </div>
      </section>
      <nav aria-label="関連する手順" className="space-y-2">
        <h3 className="text-lg font-semibold">関連する手順</h3>
        <ul className="space-y-2">
          {article.related.map((id) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => onSelect(id)}
                className="rounded-sm text-left text-sm underline underline-offset-4 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {manualArticles.find((entry) => entry.id === id)?.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </article>
  );
}

/** AuthGateの外。静的な説明だけを読み、帳簿API・入力中のフォームには触れない。 */
export function ManualHelp() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const context = articleForPath(pathname);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const article = manualArticles.find((entry) => entry.id === selected);
  const results = searchManual(query);
  const categories = [...new Set(results.map((entry) => entry.category))];
  function select(id: string | null) {
    setSelected(id);
    requestAnimationFrame(() => {
      body.current?.scrollTo?.({ top: 0 });
      body.current?.querySelector<HTMLElement>(id ? "h2" : "input")?.focus();
    });
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="fixed right-4 bottom-4 z-40 shadow-md print:hidden"
        >
          マニュアル
        </Button>
      </SheetTrigger>
      {open && (
        <SheetContent className="gap-0 overflow-hidden p-0 sm:w-[min(56rem,100vw)] md:max-w-none print:hidden">
          <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
            <div>
              <SheetTitle>マニュアル</SheetTitle>
              <SheetDescription>
                やりたいことから探す。閉じると元の作業に戻れます。
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button variant="ghost" size="sm" aria-label="マニュアルを閉じる">
                閉じる
              </Button>
            </SheetClose>
          </div>
          <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8">
            {article ? (
              <>
                <Button variant="outline" size="sm" className="mb-6" onClick={() => select(null)}>
                  目的の一覧へ
                </Button>
                <Article article={article} onSelect={select} />
              </>
            ) : (
              <div className="mx-auto max-w-[70ch] space-y-6 pb-8">
                <div className="space-y-2">
                  <label htmlFor="manual-search" className="text-sm font-medium">
                    マニュアルを検索
                  </label>
                  <Input
                    id="manual-search"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="例：取り込み、訂正、回復キー"
                  />
                  <p className="text-sm text-muted-foreground" role="status">
                    {results.length}件の手順。画面名・ボタン名・エラーの文言でも検索できます。
                  </p>
                  {query && (
                    <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
                      検索をクリア
                    </Button>
                  )}
                </div>
                {context && !query && (
                  <Button
                    variant="outline"
                    className="h-auto w-full justify-start whitespace-normal py-3 text-left"
                    onClick={() => select(context.id)}
                  >
                    この画面：{context.title}
                  </Button>
                )}
                {results.length === 0 && (
                  <p className="py-8 text-sm">
                    該当する記事がありません。別の言葉で検索してください。
                  </p>
                )}
                {categories.map((category) => (
                  <section key={category} className="space-y-2">
                    <h2 className="text-lg font-semibold">{category}</h2>
                    <ul className="divide-y border-y">
                      {results
                        .filter((entry) => entry.category === category)
                        .map((entry) => (
                          <li key={entry.id}>
                            <button
                              type="button"
                              aria-label={entry.title}
                              onClick={() => select(entry.id)}
                              className="w-full rounded-sm px-1 py-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                            >
                              <span className="block font-medium">{entry.title}</span>
                              <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                                {entry.summary}
                              </span>
                            </button>
                          </li>
                        ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}
