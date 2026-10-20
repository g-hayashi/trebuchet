/**
 * SC-004 のベンチマーク: 年間 2,000 件（平均 3 行）の仕訳があるとき、各帳票の API が 1 秒以内に応答するかを測る。
 * あわせて SC-006（003）: 約 500 仕訳の帳簿で、決算書の画面が使う API が 2 秒以内に応答するかを測る。
 * `.tmp/bench-<uuid>/` に一時的なテナントを作り、終了時に削除する。
 *
 *   pnpm bench:reports
 *   BENCH_LIMIT_MS=50 BENCH_RUNS=10 pnpm bench:reports   # しきい値・回数の変更
 *   BENCH_BLUE_LIMIT_MS=2000 pnpm bench:reports          # 決算書（SC-006）のしきい値
 *
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む
 * （その先の hono や @trebuchet/db は各パッケージの node_modules から解決される）。
 */
import { useTempDataDir } from "../packages/db/src/testing.ts";

const JOURNALS = 2_000;
const FISCAL_YEAR = 2026;
const LIMIT_MS = positiveNumber("BENCH_LIMIT_MS", 1_000);
const RUNS = positiveNumber("BENCH_RUNS", 5);

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} は正の数: ${raw}`);
  return value;
}

type Line = { side: "debit" | "credit"; accountId: string; amount: number };

// TREBUCHET_DATA_DIR を設定してから app を読み込む
const tmp = useTempDataDir("bench");
let exitCode = 1;
try {
  const { app } = await import("../apps/server/src/app.ts");

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit =
      body === undefined
        ? { method }
        : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    return app.request(`/api${path}`, init);
  }

  async function json<T>(res: Response, expected: number, what: string): Promise<T> {
    if (res.status !== expected) {
      throw new Error(`${what} が失敗しました: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  // 事業体（会計期間と勘定科目の初期セットは作成時に用意される）
  const { entity } = await json<{ entity: { id: string } }>(
    await call("POST", "/entities", {
      name: "ベンチマーク",
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

  await json(
    await call("PUT", `${base}/fiscal-periods/${FISCAL_YEAR}/opening-balances`, [
      { accountId: acc("普通預金"), side: "debit", amount: 3_000_000 },
      { accountId: acc("元入金"), side: "credit", amount: 3_000_000 },
    ]),
    200,
    "期首残高の登録",
  );

  const debit = (name: string, amount: number): Line => ({
    side: "debit",
    accountId: acc(name),
    amount,
  });
  const credit = (name: string, amount: number): Line => ({
    side: "credit",
    accountId: acc(name),
    amount,
  });

  /** 2 行と 4 行を交互にして平均 3 行にする。金額は件ごとに変える（重複の警告を避ける） */
  function linesOf(i: number): Line[] {
    const n = 1_000 + ((i * 7_919) % 90_000);
    switch (i % 4) {
      case 0:
        return [debit("売掛金", n * 3), credit("売上高", n * 3)];
      case 1:
        return [
          debit("普通預金", n * 2),
          debit("支払手数料", 440),
          credit("売掛金", n * 2 + 440 - 300),
          credit("事業主借", 300),
        ];
      case 2:
        return i % 8 === 2
          ? [debit("消耗品費", n), credit("普通預金", n)]
          : [debit("事業主貸", n), credit("普通預金", n)];
      default:
        return [
          debit("地代家賃", 80_000),
          debit("事業主貸", 20_000 + (i % 100)),
          credit("普通預金", 60_000),
          credit("未払金", 40_000 + (i % 100)),
        ];
    }
  }

  const yearStart = Date.UTC(FISCAL_YEAR, 0, 1);
  const dateOf = (i: number, total = JOURNALS): string =>
    new Date(yearStart + Math.floor((i * 365) / total) * 86_400_000).toISOString().slice(0, 10);

  const setupStart = performance.now();
  let lineCount = 0;
  for (let i = 0; i < JOURNALS; i++) {
    const lines = linesOf(i);
    lineCount += lines.length;
    await json(
      await call("POST", `${base}/journals`, { date: dateOf(i), lines }),
      201,
      `仕訳 ${i + 1} の登録`,
    );
  }
  console.log(
    `仕訳 ${JOURNALS} 件（${lineCount} 行, 平均 ${(lineCount / JOURNALS).toFixed(1)} 行）を登録: ${(performance.now() - setupStart).toFixed(0)} ms`,
  );

  const year = `from=${FISCAL_YEAR}-01-01&to=${FISCAL_YEAR}-12-31`;
  const reports: [name: string, path: string][] = [
    ["journal-book", `journal-book?${year}`],
    ["general-ledger", `general-ledger?${year}&accountId=${acc("普通預金")}`],
    ["trial-balance", `trial-balance?${year}`],
    ["profit-and-loss", `profit-and-loss?${year}`],
    ["balance-sheet", `balance-sheet?asOf=${FISCAL_YEAR}-12-31`],
  ];
  const targets = reports.flatMap(([name, path]) => [
    { name, format: "json", path: `${base}/reports/${path}` },
    { name, format: "csv", path: `${base}/reports/${path}&format=csv` },
  ]);

  /** 応答の本文を読み終えるまでの時間（ミリ秒） */
  async function measure(path: string): Promise<number> {
    const start = performance.now();
    const res = await call("GET", path);
    const body = await res.text();
    const elapsed = performance.now() - start;
    if (res.status !== 200) throw new Error(`GET ${path} が失敗しました: ${res.status} ${body}`);
    return elapsed;
  }

  const rows = [];
  for (const target of targets) {
    await measure(target.path); // ウォームアップ
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) times.push(await measure(target.path));
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] ?? Number.NaN;
    const max = times[times.length - 1] ?? Number.NaN;
    rows.push({
      report: target.name,
      format: target.format,
      "median (ms)": Number(median.toFixed(1)),
      "max (ms)": Number(max.toFixed(1)),
      result: max <= LIMIT_MS ? "OK" : "NG",
    });
  }
  console.table(rows);

  const failed = rows.filter((r) => r.result === "NG");
  let sc004Ok = false;
  if (failed.length > 0) {
    console.error(
      `SC-004 を満たしません: ${failed.map((r) => `${r.report}(${r.format})`).join(", ")} が ${LIMIT_MS} ms を超えました`,
    );
  } else {
    console.log(`SC-004 OK: すべての帳票が ${LIMIT_MS} ms 以内（${RUNS} 回の最大値）`);
    sc004Ok = true;
  }

  // SC-006（003）: 約 500 仕訳の帳簿で、決算書の画面を開いてから全ページの値が表示されるまで 2 秒以内。
  // 画面が開くときに取る API（決算書・控除の回答・按分・地代家賃の内訳・決算整理の案）を順に呼んだ合計を測る。
  const BLUE_JOURNALS = 500;
  const BLUE_LIMIT_MS = positiveNumber("BENCH_BLUE_LIMIT_MS", 2_000);
  const { entity: blueEntity } = await json<{ entity: { id: string } }>(
    await call("POST", "/entities", {
      name: "ベンチマーク（決算書）",
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear: FISCAL_YEAR,
    }),
    201,
    "決算書用の事業体の作成",
  );
  const blueBase = `/entities/${blueEntity.id}`;
  const blueAccounts = await json<{ accounts: { id: string; name: string }[] }>(
    await call("GET", `${blueBase}/accounts`),
    200,
    "勘定科目の取得（決算書用）",
  );
  const blueIds = new Map(blueAccounts.accounts.map((a) => [a.name, a.id]));
  const blueAcc = (name: string): string => {
    const id = blueIds.get(name);
    if (id === undefined) throw new Error(`科目がありません: ${name}`);
    return id;
  };
  await json(
    await call("PUT", `${blueBase}/fiscal-periods/${FISCAL_YEAR}/opening-balances`, [
      { accountId: blueAcc("普通預金"), side: "debit", amount: 3_000_000 },
      { accountId: blueAcc("元入金"), side: "credit", amount: 3_000_000 },
    ]),
    200,
    "期首残高の登録（決算書用）",
  );
  // linesOf は acc() で科目を引くため、決算書用の事業体の科目 ID に置き換えて組み立てる
  const blueLines = (i: number): Line[] =>
    linesOf(i).map((l) => {
      const name = [...ids].find(([, id]) => id === l.accountId)?.[0];
      if (name === undefined) throw new Error("科目の名前を引けません");
      return { ...l, accountId: blueAcc(name) };
    });
  for (let i = 0; i < BLUE_JOURNALS; i++) {
    await json(
      await call("POST", `${blueBase}/journals`, {
        date: dateOf(i, BLUE_JOURNALS),
        lines: blueLines(i),
      }),
      201,
      `仕訳 ${i + 1} の登録（決算書用）`,
    );
  }
  await json(
    await call("PUT", `${blueBase}/blue-return/${FISCAL_YEAR}/home-use`, {
      accountId: blueAcc("地代家賃"),
      businessRatio: 5_000,
      basis: "ベンチマーク",
    }),
    200,
    "按分の登録",
  );
  await json(
    await call("POST", `${blueBase}/fixed-assets`, {
      name: "ベンチマーク用の資産",
      acquiredOn: `${FISCAL_YEAR}-03-01`,
      acquisitionCost: 150_000,
      method: "small_asset_28_2",
      businessRatio: 10_000,
      assetAccountId: blueAcc("工具器具備品"),
    }),
    201,
    "固定資産の登録",
  );

  const bluePaths = [
    `${blueBase}/blue-return/${FISCAL_YEAR}`,
    `${blueBase}/blue-return/${FISCAL_YEAR}/deduction-answers`,
    `${blueBase}/blue-return/${FISCAL_YEAR}/home-use`,
    `${blueBase}/blue-return/${FISCAL_YEAR}/rent-details`,
    `${blueBase}/blue-return/${FISCAL_YEAR}/adjustments`,
  ];
  async function measureScreen(): Promise<number> {
    const start = performance.now();
    for (const path of bluePaths) {
      const res = await call("GET", path);
      const body = await res.text();
      if (res.status !== 200) throw new Error(`GET ${path} が失敗しました: ${res.status} ${body}`);
    }
    return performance.now() - start;
  }
  const blueTargets: [name: string, run: () => Promise<number>][] = [
    ["blue-return (JSON)", () => measure(bluePaths[0] ?? "")],
    [
      "blue-return (CSV)",
      () => measure(`${blueBase}/blue-return/${FISCAL_YEAR}/csv?blankUnused=false`),
    ],
    ["blue-return screen (all APIs)", measureScreen],
  ];
  const blueRows = [];
  for (const [name, run] of blueTargets) {
    await run(); // ウォームアップ
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) times.push(await run());
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] ?? Number.NaN;
    const max = times[times.length - 1] ?? Number.NaN;
    blueRows.push({
      target: name,
      "median (ms)": Number(median.toFixed(1)),
      "max (ms)": Number(max.toFixed(1)),
      result: max <= BLUE_LIMIT_MS ? "OK" : "NG",
    });
  }
  console.log(`決算書: 仕訳 ${BLUE_JOURNALS} 件の帳簿（${FISCAL_YEAR} 年度）`);
  console.table(blueRows);
  const blueFailed = blueRows.filter((r) => r.result === "NG");
  let sc006Ok = false;
  if (blueFailed.length > 0) {
    console.error(
      `SC-006 を満たしません: ${blueFailed.map((r) => r.target).join(", ")} が ${BLUE_LIMIT_MS} ms を超えました`,
    );
  } else {
    console.log(`SC-006 OK: 決算書が ${BLUE_LIMIT_MS} ms 以内（${RUNS} 回の最大値）`);
    sc006Ok = true;
  }
  if (sc004Ok && sc006Ok) exitCode = 0;
} catch (error) {
  console.error(error);
} finally {
  tmp.cleanup();
}
process.exitCode = exitCode;
