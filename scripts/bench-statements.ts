/**
 * SC-006（006）のベンチマーク: 合成の 500 件の明細を貼り付けてから、確認画面（プレビュー）と候補の一覧が
 * 表示されるまでが 5 秒以内か（AI による推定の時間を除く。AI（fm・外部）は呼ばない）。
 * 画面が呼ぶ順（プレビュー → 確定 → 候補を作る → 明細の一覧）に API を呼び、その合計を測る。
 * 1 回ごとに新しい事業体を作る（確定は繰り返せないため）。事業体には、候補の突き合わせ（match）と
 * ルール（rule）が働くように、既存の仕訳 100 件とそこから作ったルールを用意する（準備の時間は測らない）。
 * 貼り付けのテキストは合成で、`work/`・`data/` は読まない。`.tmp/bench-<uuid>/` に一時的なテナントを作り、終了時に削除する。
 *
 *   pnpm bench:statements
 *   BENCH_STATEMENTS_LIMIT_MS=2000 BENCH_STATEMENTS_RUNS=5 pnpm bench:statements   # しきい値（既定 5000）・回数（既定 3）
 *   BENCH_STATEMENTS=1000 pnpm bench:statements                                    # 貼り付ける件数（既定 500）
 *
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む（bench-reports.ts と同じ）。
 */
import { useTempDataDir } from "../packages/db/src/testing.ts";
import { positiveNumber, runBench } from "./lib/bench-common.ts";
import { createBenchHeaders } from "./lib/bench-session.ts";

const FISCAL_YEAR = 2026;
const STATEMENTS = positiveNumber("BENCH_STATEMENTS", 500);
const LIMIT_MS = positiveNumber("BENCH_STATEMENTS_LIMIT_MS", 5_000);
const RUNS = positiveNumber("BENCH_STATEMENTS_RUNS", 3);
/** 既存の仕訳の件数（先頭の同じ件数の明細が、仕訳と同じ日付・金額になる） */
const JOURNALS = 100;

const BANK = "サンプル銀行";
const CARD = "テストカードA";
const CASH = "テスト現金";

// TREBUCHET_DATA_DIR を設定してから app を読み込む
const tmp = useTempDataDir("bench");
await runBench(
  async () => {
    const { app } = await import("../apps/server/src/app.ts");

    // 認証（Host → CSRF → セッション）を通すためのヘッダー
    const authHeaders = await createBenchHeaders();

    async function call(method: string, path: string, body?: unknown): Promise<Response> {
      const init: RequestInit =
        body === undefined
          ? { method, headers: authHeaders }
          : {
              method,
              headers: { ...authHeaders, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            };
      return app.request(`/api${path}`, init);
    }

    async function json<T>(res: Response, expected: number, what: string): Promise<T> {
      if (res.status !== expected) {
        throw new Error(`${what} が失敗しました: ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as T;
    }

    /** 応答を JSON として読み終えるまでの時間（ミリ秒）と本文 */
    async function timed<T>(
      method: string,
      path: string,
      expected: number,
      what: string,
      body?: unknown,
    ): Promise<{ ms: number; value: T }> {
      const start = performance.now();
      const res = await call(method, path, body);
      const value = await json<T>(res, expected, what);
      return { ms: performance.now() - start, value };
    }

    const dayOf = (i: number): string => {
      const date = new Date(Date.UTC(FISCAL_YEAR, 0, 1) + (i % 360) * 86_400_000);
      return date.toISOString().slice(0, 10);
    };
    /** 金額は件ごとに変える（重複の警告を避ける） */
    const amountOf = (i: number): number => 1_000 + ((i * 7_919) % 90_000) + i;
    const shopOf = (i: number): string => `ショップ${String((i % 20) + 1).padStart(3, "0")}`;

    /** `MM/DD(曜)` 形式の日付（曜日は読み取りに使われない） */
    const pasteDate = (date: string): string => `${date.slice(5, 7)}/${date.slice(8, 10)}(月)`;
    const yen = (n: number): string => n.toLocaleString("en-US");

    /** 貼り付けのテキスト（見出しつき・タブ区切り。3 口座、入金・出金・カード・振替の印を混ぜる） */
    function pasteText(): string {
      const header = [
        "計算対象",
        "日付",
        "内容",
        "金額（円）",
        "保有金融機関",
        "大項目",
        "中項目",
        "メモ",
        "振替",
      ];
      const rows: string[][] = [header];
      for (let i = 0; i < STATEMENTS; i++) {
        const date = pasteDate(dayOf(i));
        const n = amountOf(i);
        let row: string[];
        if (i < JOURNALS) {
          // 既存の仕訳（普通預金からの支払）と同じ日付・金額
          row = ["1", date, shopOf(i), `-${yen(n)}`, BANK, "日用品", "消耗品費", "", "0"];
        } else if (i % 10 === 0) {
          row = [
            "1",
            date,
            `売上入金 取引先${(i % 7) + 1}`,
            yen(n * 3),
            BANK,
            "収入",
            "事業売上",
            "",
            "0",
          ];
        } else if (i % 10 === 1) {
          row = [
            "1",
            date,
            `ATM 引出 ${i}`,
            `-${yen(n)}`,
            BANK,
            "現金・カード",
            "ATM引き出し",
            "",
            "1",
          ];
        } else if (i % 10 === 2) {
          row = ["1", date, `ATM 引出 ${i}`, yen(n), CASH, "現金・カード", "ATM引き出し", "", "1"];
        } else if (i % 2 === 0) {
          row = ["1", date, `${shopOf(i)} ${i}`, `-${yen(n)}`, CARD, "食費", "食料品", "", "0"];
        } else {
          row = ["1", date, `${shopOf(i)} ${i}`, `-${yen(n)}`, CASH, "日用品", "雑貨", "メモ", "0"];
        }
        rows.push(row);
      }
      return `${rows.map((r) => r.join("\t")).join("\n")}\n`;
    }
    const text = pasteText();

    type Sample = { preview: number; commit: number; candidates: number; list: number };

    /** 事業体と準備（口座の対応・既存の仕訳・ルール）を作り、貼り付けから一覧までを測る */
    async function runOnce(label: string): Promise<Sample> {
      const { entity } = await json<{ entity: { id: string } }>(
        await call("POST", "/entities", {
          name: `ベンチマーク（明細 ${label}）`,
          kind: "individual",
          fiscalStartMonth: 1,
          firstFiscalYear: FISCAL_YEAR,
        }),
        201,
        "事業体の作成",
      );
      const base = `/entities/${entity.id}`;

      const { accounts } = await json<{ accounts: { id: string; name: string }[] }>(
        await call("GET", `${base}/accounts`),
        200,
        "勘定科目の取得",
      );
      const ids = new Map(accounts.map((a) => [a.name, a.id]));
      const acc = (name: string): string => {
        const id = ids.get(name);
        if (id === undefined) throw new Error(`科目がありません: ${name}`);
        return id;
      };

      // 期首残高（普通預金から支払える残高）
      await json(
        await call("PUT", `${base}/fiscal-periods/${FISCAL_YEAR}/opening-balances`, [
          { accountId: acc("普通預金"), side: "debit", amount: 30_000_000 },
          { accountId: acc("元入金"), side: "credit", amount: 30_000_000 },
        ]),
        200,
        "期首残高の登録",
      );

      // 取込元の口座の対応（銀行・カード・現金。事業用）
      const mapping: [name: string, kind: "bank" | "card" | "cash", account: string][] = [
        [BANK, "bank", "普通預金"],
        [CARD, "card", "未払金"],
        [CASH, "cash", "現金"],
      ];
      for (const [name, kind, account] of mapping) {
        await json(
          await call("PUT", `${base}/statement-accounts/${encodeURIComponent(name)}`, {
            usage: "business",
            kind,
            accountId: acc(account),
          }),
          200,
          `口座の対応（${name}）`,
        );
      }

      // 既存の仕訳（先頭の明細と同じ日付・金額の支払）と、そこから作るルール
      for (let i = 0; i < JOURNALS; i++) {
        const n = amountOf(i);
        const description = shopOf(i);
        await json(
          await call("POST", `${base}/journals`, {
            date: dayOf(i),
            lines: [
              { side: "debit", accountId: acc("消耗品費"), amount: n, description },
              { side: "credit", accountId: acc("普通預金"), amount: n, description },
            ],
          }),
          201,
          `仕訳 ${i + 1} の登録`,
        );
      }
      await json(await call("POST", `${base}/inference-rules/seed`, {}), 200, "ルールの初期作成");

      // ここから測る（画面の順: プレビュー → 確定 → 候補を作る → 明細の一覧）
      const source = { kind: "paste", text, year: FISCAL_YEAR };
      const preview = await timed<{
        inputSha256: string;
        countNew: number;
        unmappedAccounts: string[];
        unreadable: unknown[];
      }>("POST", `${base}/statements/imports/preview`, 200, "プレビュー", { source });
      if (preview.value.countNew !== STATEMENTS || preview.value.unmappedAccounts.length > 0) {
        throw new Error(
          `プレビューが想定と違います: 新規 ${preview.value.countNew} 件（想定 ${STATEMENTS}）、未対応の口座 ${preview.value.unmappedAccounts.length}、読めない行 ${preview.value.unreadable.length}`,
        );
      }
      const commit = await timed<{ added: number }>(
        "POST",
        `${base}/statements/imports`,
        201,
        "確定",
        {
          source,
          expected: { inputSha256: preview.value.inputSha256, countNew: preview.value.countNew },
        },
      );
      if (commit.value.added !== STATEMENTS) {
        throw new Error(`取込の件数が想定と違います: ${commit.value.added}（想定 ${STATEMENTS}）`);
      }
      const candidates = await timed(
        "POST",
        `${base}/statements/candidates`,
        200,
        "候補を作る",
        {},
      );
      const list = await timed<{ statements: unknown[] }>(
        "GET",
        `${base}/statements?status=unprocessed`,
        200,
        "明細の一覧",
      );
      if (list.value.statements.length !== STATEMENTS) {
        throw new Error(
          `一覧の件数が想定と違います: ${list.value.statements.length}（想定 ${STATEMENTS}）`,
        );
      }
      return {
        preview: preview.ms,
        commit: commit.ms,
        candidates: candidates.ms,
        list: list.ms,
      };
    }

    console.log(
      `明細 ${STATEMENTS} 件（既存の仕訳 ${JOURNALS} 件、${FISCAL_YEAR} 年度）を ${RUNS} 回測ります`,
    );
    const samples: Sample[] = [];
    for (let i = 0; i < RUNS; i++) samples.push(await runOnce(String(i + 1)));

    const total = (s: Sample): number => s.preview + s.commit + s.candidates + s.list;
    const stat = (pick: (s: Sample) => number) => {
      const values = samples.map(pick).sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)] ?? Number.NaN;
      const max = values[values.length - 1] ?? Number.NaN;
      return { median: Number(median.toFixed(1)), max: Number(max.toFixed(1)) };
    };
    const parts: [name: string, pick: (s: Sample) => number][] = [
      ["preview", (s) => s.preview],
      ["commit", (s) => s.commit],
      ["build candidates", (s) => s.candidates],
      ["list statements", (s) => s.list],
      ["total (paste to list)", total],
    ];
    console.table(
      parts.map(([name, pick]) => {
        const { median, max } = stat(pick);
        return {
          step: name,
          "median (ms)": median,
          "max (ms)": max,
          result: name.startsWith("total") ? (max <= LIMIT_MS ? "OK" : "NG") : "-",
        };
      }),
    );

    const worst = stat(total).max;
    if (worst > LIMIT_MS) {
      console.error(
        `SC-006 を満たしません: 貼り付けから候補の一覧まで ${worst} ms（しきい値 ${LIMIT_MS} ms）`,
      );
      return false;
    }
    console.log(
      `SC-006 OK: 明細 ${STATEMENTS} 件の貼り付けから候補の一覧まで ${LIMIT_MS} ms 以内（${RUNS} 回の最大値 ${worst} ms）`,
    );
    return true;
  },
  () => tmp.cleanup(),
);
