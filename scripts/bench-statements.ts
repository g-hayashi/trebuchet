/**
 * SC-006（007）のベンチマーク: 合成の 500 件の明細の CSV（UTF-8、カンマ区切り、出金・入金の 2 列）を選んでから、
 * 確認画面（プレビュー）が表示されるまでが 5 秒以内か（AI による列の案の時間を除く。AI（fm・外部）は呼ばない）。
 * 画面が呼ぶ順（layout → preview → 確定 → 候補を作る → 明細の一覧）に multipart で API を呼ぶ。
 * 判定は layout + preview の合計（SC-006）。確定・候補・一覧は参考として測る（006 の SC-006 の区間）。
 * 参考として、候補のある明細のまとめて承認（既定で最大 500 件）と承認後の一覧も測る（判定しない）。
 * 1 回ごとに新しい事業体を作る（確定は繰り返せないため）。事業体には、候補の突き合わせ（match）と
 * ルール（rule）が働くように、既存の仕訳 100 件とそこから作ったルールを用意する（準備の時間は測らない）。
 * CSV は合成で、`work/`・`data/` は読まない。`.tmp/bench-<uuid>/` に一時的なテナントを作り、終了時に削除する。
 *
 *   pnpm bench:statements
 *   BENCH_STATEMENTS_LIMIT_MS=2000 BENCH_STATEMENTS_RUNS=5 pnpm bench:statements   # しきい値（既定 5000）・回数（既定 3）
 *   BENCH_STATEMENTS=1000 pnpm bench:statements                                    # CSV の件数（既定 500）
 *   BENCH_STATEMENTS_APPROVE=200 pnpm bench:statements                             # まとめて承認の上限（既定・最大 500）
 *
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む（bench-reports.ts と同じ）。
 */
import { useTempDataDir } from "../packages/db/src/testing.ts";
import { createBenchClient, createEntityViaApi } from "./lib/bench-client.ts";
import { runBench, summarize } from "./lib/bench-common.ts";
import { createBenchHeaders } from "./lib/bench-session.ts";
import { positiveNumber } from "./lib/env.ts";

const FISCAL_YEAR = 2026;
const STATEMENTS = positiveNumber("BENCH_STATEMENTS", 500);
const LIMIT_MS = positiveNumber("BENCH_STATEMENTS_LIMIT_MS", 5_000);
const RUNS = positiveNumber("BENCH_STATEMENTS_RUNS", 3);
/** 既存の仕訳の件数（先頭の同じ件数の明細が、仕訳と同じ日付・金額になる） */
const JOURNALS = 100;
/** まとめて承認する件数の上限（候補のある明細から。`MAX_BULK_SELECTION` 以下） */
const APPROVE_LIMIT = Math.min(positiveNumber("BENCH_STATEMENTS_APPROVE", 500), 500);

const BANK = "サンプル銀行";
const CARD = "テストカードA";
const CASH = "テスト現金";

/** 列の対応（CSV の列の並びと合わせる。見出しは `csvText` の `header`） */
const MAPPING = {
  delimiter: ",",
  headerRow: 0,
  columns: {
    date: 0,
    content: 1,
    outflow: 2,
    inflow: 3,
    accountName: 4,
    categoryMajor: 5,
    categoryMinor: 6,
    memo: 7,
    transferFlag: 8,
  },
} as const;

// TREBUCHET_DATA_DIR を設定してから app を読み込む
const tmp = useTempDataDir("bench");
await runBench(
  async () => {
    const { app } = await import("../apps/server/src/app.ts");

    // 認証（Host → CSRF → セッション）を通すためのヘッダー
    const client = createBenchClient(app, await createBenchHeaders());
    const { call, callForm, json, timed } = client;

    const dayOf = (i: number): string => {
      const date = new Date(Date.UTC(FISCAL_YEAR, 0, 1) + (i % 360) * 86_400_000);
      return date.toISOString().slice(0, 10);
    };
    /** 金額は件ごとに変える（重複の警告を避ける） */
    const amountOf = (i: number): number => 1_000 + ((i * 7_919) % 90_000) + i;
    const shopOf = (i: number): string => `ショップ${String((i % 20) + 1).padStart(3, "0")}`;

    const yen = (n: number): string => n.toLocaleString("en-US");
    /** 全項目をクォートする（フィクスチャと同じ。金額のカンマが区切りに読まれない） */
    const quoted = (cells: string[]): string =>
      cells.map((c) => `"${c.replaceAll('"', '""')}"`).join(",");

    /** CSV（UTF-8、見出しつき、出金・入金の 2 列。3 口座、入金・出金・カード・振替の印を混ぜる） */
    function csvText(): string {
      const header = [
        "日付",
        "内容",
        "出金額",
        "入金額",
        "保有金融機関",
        "大項目",
        "中項目",
        "メモ",
        "振替",
      ];
      const rows: string[][] = [header];
      for (let i = 0; i < STATEMENTS; i++) {
        const date = dayOf(i).replaceAll("-", "/");
        const n = amountOf(i);
        let row: string[];
        if (i < JOURNALS) {
          // 既存の仕訳（普通預金からの支払）と同じ日付・金額
          row = [date, shopOf(i), yen(n), "", BANK, "日用品", "消耗品費", "", "0"];
        } else if (i % 10 === 0) {
          row = [
            date,
            `売上入金 取引先${(i % 7) + 1}`,
            "",
            yen(n * 3),
            BANK,
            "収入",
            "事業売上",
            "",
            "0",
          ];
        } else if (i % 10 === 1) {
          row = [date, `ATM 引出 ${i}`, yen(n), "", BANK, "現金・カード", "ATM引き出し", "", "1"];
        } else if (i % 10 === 2) {
          row = [date, `ATM 引出 ${i}`, "", yen(n), CASH, "現金・カード", "ATM引き出し", "", "1"];
        } else if (i % 2 === 0) {
          row = [date, `${shopOf(i)} ${i}`, yen(n), "", CARD, "食費", "食料品", "", "0"];
        } else {
          row = [date, `${shopOf(i)} ${i}`, yen(n), "", CASH, "日用品", "雑貨", "メモ", "0"];
        }
        rows.push(row);
      }
      return `${rows.map(quoted).join("\n")}\n`;
    }
    const csv = csvText();

    /** multipart の本体（実際の画面と同じく、毎回新しい File を作る） */
    const form = (options: unknown): FormData => {
      const body = new FormData();
      body.append("file", new File([csv], "statement.csv", { type: "text/csv" }));
      body.append("options", JSON.stringify(options));
      return body;
    };

    type Sample = {
      layout: number;
      preview: number;
      commit: number;
      candidates: number;
      list: number;
      /** 承認した明細の件数（振替の対の相手を含む） */
      approved: number;
      approve: number;
      listAfter: number;
    };

    /** 事業体と準備（口座の対応・既存の仕訳・ルール）を作り、ファイルの選択から一覧までを測る */
    async function runOnce(label: string): Promise<Sample> {
      // 期首残高は、普通預金から支払える残高
      const { base, acc } = await createEntityViaApi(client, {
        name: `ベンチマーク（明細 ${label}）`,
        firstFiscalYear: FISCAL_YEAR,
        openingBalances: [
          { account: "普通預金", side: "debit", amount: 30_000_000 },
          { account: "元入金", side: "credit", amount: 30_000_000 },
        ],
      });

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

      // ここから測る（画面の順: layout → preview → 確定 → 候補を作る → 明細の一覧）
      const layout = await timed<{
        encoding: "utf-8" | "shift_jis";
        columnCount: number;
        rowCount: number;
        suggestedColumns: Record<string, number | undefined>;
      }>(200, "layout", () =>
        callForm(`${base}/statements/imports/layout`, form({ origin: "file" })),
      );
      if (layout.value.rowCount !== STATEMENTS) {
        throw new Error(
          `layout の行数が想定と違います: ${layout.value.rowCount}（想定 ${STATEMENTS}）`,
        );
      }
      // 画面と同じく、辞書の案で必須の列がそろうこと（そろわなければ利用者が列を選ぶ手間が増える）
      for (const role of ["date", "content", "outflow", "inflow"] as const) {
        if (layout.value.suggestedColumns[role] !== MAPPING.columns[role]) {
          throw new Error(
            `layout の列の案が想定と違います: ${role} は ${layout.value.suggestedColumns[role]}（想定 ${MAPPING.columns[role]}）`,
          );
        }
      }

      const common = {
        origin: "file",
        year: FISCAL_YEAR,
        mapping: MAPPING,
        encoding: layout.value.encoding,
      };
      const preview = await timed<{
        inputSha256: string;
        countNew: number;
        unmappedAccounts: unknown[];
        unreadable: unknown[];
      }>(200, "プレビュー", () => callForm(`${base}/statements/imports/preview`, form(common)));
      if (preview.value.countNew !== STATEMENTS || preview.value.unmappedAccounts.length > 0) {
        throw new Error(
          `プレビューが想定と違います: 新規 ${preview.value.countNew} 件（想定 ${STATEMENTS}）、未対応の口座 ${preview.value.unmappedAccounts.length}、読めない行 ${preview.value.unreadable.length}`,
        );
      }
      const commit = await timed<{ batch: unknown; added: number }>(201, "確定", () =>
        callForm(
          `${base}/statements/imports`,
          form({
            ...common,
            expected: { inputSha256: preview.value.inputSha256, countNew: preview.value.countNew },
            accounts: [],
            saveSource: null,
          }),
        ),
      );
      if (commit.value.added !== STATEMENTS) {
        throw new Error(`取込の件数が想定と違います: ${commit.value.added}（想定 ${STATEMENTS}）`);
      }
      const candidates = await timed(200, "候補を作る", () =>
        call("POST", `${base}/statements/candidates`, {}),
      );
      const list = await timed<{
        statements: { id: string; candidate: { method: string } | null }[];
      }>(200, "明細の一覧", () => call("GET", `${base}/statements?status=unprocessed`));
      if (list.value.statements.length !== STATEMENTS) {
        throw new Error(
          `一覧の件数が想定と違います: ${list.value.statements.length}（想定 ${STATEMENTS}）`,
        );
      }

      // 参考: 候補のある明細をまとめて承認し（画面の「まとめて承認」）、承認後の一覧を読む
      const items = list.value.statements
        .filter((s) => s.candidate !== null && s.candidate.method !== "none")
        .slice(0, APPROVE_LIMIT)
        .map((s) => ({ statementId: s.id }));
      const approve = await timed<{ approved: string[]; failed: unknown[] }>(
        200,
        "まとめて承認",
        () => call("POST", `${base}/statements/approve-bulk`, { items }),
      );
      const listAfter = await timed<{ statements: unknown[] }>(200, "承認後の明細の一覧", () =>
        call("GET", `${base}/statements`),
      );
      return {
        layout: layout.ms,
        preview: preview.ms,
        commit: commit.ms,
        candidates: candidates.ms,
        list: list.ms,
        approved: approve.value.approved.length,
        approve: approve.ms,
        listAfter: listAfter.ms,
      };
    }

    console.log(
      `CSV ${STATEMENTS} 件（既存の仕訳 ${JOURNALS} 件、${FISCAL_YEAR} 年度）を ${RUNS} 回測ります`,
    );
    const samples: Sample[] = [];
    for (let i = 0; i < RUNS; i++) samples.push(await runOnce(String(i + 1)));

    /** SC-006: ファイルを選んでから確認画面まで */
    const toPreview = (s: Sample): number => s.layout + s.preview;
    const total = (s: Sample): number => toPreview(s) + s.commit + s.candidates + s.list;
    const stat = (pick: (s: Sample) => number) => summarize(samples.map(pick));
    const parts: [name: string, pick: (s: Sample) => number, judged: boolean][] = [
      ["layout", (s) => s.layout, false],
      ["preview", (s) => s.preview, false],
      ["layout + preview (SC-006)", toPreview, true],
      ["commit", (s) => s.commit, false],
      ["build candidates", (s) => s.candidates, false],
      ["list statements", (s) => s.list, false],
      ["total (layout to list)", total, false],
      [`approve bulk (${samples[0]?.approved ?? 0} statements)`, (s) => s.approve, false],
      ["list statements after approve", (s) => s.listAfter, false],
    ];
    console.table(
      parts.map(([name, pick, judged]) => {
        const { median, max } = stat(pick);
        return {
          step: name,
          "median (ms)": median,
          "max (ms)": max,
          result: judged ? (max <= LIMIT_MS ? "OK" : "NG") : "-",
        };
      }),
    );

    const worst = stat(toPreview).max;
    if (worst > LIMIT_MS) {
      console.error(
        `SC-006 を満たしません: ファイルを選んでから確認画面まで ${worst} ms（しきい値 ${LIMIT_MS} ms）`,
      );
      return false;
    }
    console.log(
      `SC-006 OK: 明細 ${STATEMENTS} 件の CSV を選んでから確認画面まで ${LIMIT_MS} ms 以内（${RUNS} 回の最大値 ${worst} ms。全区間の最大 ${stat(total).max} ms）`,
    );
    return true;
  },
  () => tmp.cleanup(),
);
