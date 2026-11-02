/**
 * SC-004 のベンチマーク: 年間 2,000 件（平均 3 行）の仕訳があるとき、各帳票の API が 1 秒以内に応答するかを測る。
 * あわせて SC-006（003）: 約 500 仕訳の帳簿で、決算書の画面が使う API が 2 秒以内に応答するかを測る。
 * さらに SC-005（009）: 資産 50 件（定額法・一括償却・少額の特例）と開業費 1 件の事業体で、同じ API が 2 秒以内かを測る。
 * さらに SC-002（010）: 証憑 5,000 件（ファイルなし）の事業体で、日付 × 金額 × 取引先の検索 10 回が各 1 秒以内かを測る。
 * `.tmp/bench-<uuid>/` に一時的なテナントを作り、終了時に削除する。
 *
 *   pnpm bench:reports
 *   BENCH_LIMIT_MS=50 BENCH_RUNS=10 pnpm bench:reports   # しきい値・回数の変更
 *   BENCH_RECEIPT_LIMIT_MS=1000 pnpm bench:reports       # 証憑の検索（010 の SC-002）のしきい値
 *   BENCH_BLUE_LIMIT_MS=2000 pnpm bench:reports          # 決算書（SC-006）のしきい値
 *   BENCH_ASSET_LIMIT_MS=2000 pnpm bench:reports         # 資産と開業費の決算書（009 の SC-005）のしきい値
 *
 * ルートは @trebuchet/* に依存しないため、ワークスペースのソースを相対パスで読み込む
 * （その先の hono や @trebuchet/db は各パッケージの node_modules から解決される）。
 */
import { randomUUIDv7 } from "node:crypto";
import { createReceiptUnitOfWork } from "../packages/db/src/receipt-repository.ts";
import { openTenant } from "../packages/db/src/tenant-store.ts";
import { useTempDataDir } from "../packages/db/src/testing.ts";
import { normalizeReceiptText, ok, type ReceiptRow } from "../packages/domain/src/index.ts";
import { positiveNumber, runBench } from "./lib/bench-common.ts";
import { createBenchHeaders } from "./lib/bench-session.ts";

const JOURNALS = 2_000;
const FISCAL_YEAR = 2026;
const LIMIT_MS = positiveNumber("BENCH_LIMIT_MS", 1_000);
const RUNS = positiveNumber("BENCH_RUNS", 5);

type Line = { side: "debit" | "credit"; accountId: string; amount: number };

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
    /** 決算書用の事業体を作り、期首残高と仕訳 BLUE_JOURNALS 件を登録する（SC-006・SC-005 で共有） */
    async function createBlueEntity(
      name: string,
    ): Promise<{ blueBase: string; blueAcc: (name: string) => string }> {
      const { entity: blueEntity } = await json<{ entity: { id: string } }>(
        await call("POST", "/entities", {
          name,
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
      const blueAcc = (accountName: string): string => {
        const id = blueIds.get(accountName);
        if (id === undefined) throw new Error(`科目がありません: ${accountName}`);
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
          const accountName = [...ids].find(([, id]) => id === l.accountId)?.[0];
          if (accountName === undefined) throw new Error("科目の名前を引けません");
          return { ...l, accountId: blueAcc(accountName) };
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
      return { blueBase, blueAcc };
    }

    const { blueBase, blueAcc } = await createBlueEntity("ベンチマーク（決算書）");
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
        if (res.status !== 200)
          throw new Error(`GET ${path} が失敗しました: ${res.status} ${body}`);
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

    // SC-005（009）: 資産 50 件（定額法・一括償却・少額の特例。取得は数年分）と開業費 1 件の事業体で、
    // 決算書の画面が使う API（決算書・決算整理の案・固定資産台帳・開業費）の合計が 2 秒以内。
    // 資産の範囲は 009 R15 のジェネレーター（耐用年数 2〜50、取得価額、事業専用割合 0〜10000、
    // 一括償却は 100,000〜199,999 円）に合わせる。値は乱数ではなく添字から決める。
    const ASSET_COUNT = 50;
    const ASSET_LIMIT_MS = positiveNumber("BENCH_ASSET_LIMIT_MS", 2_000);
    const { blueBase: assetBase, blueAcc: assetAcc } = await createBlueEntity(
      "ベンチマーク（資産と開業費）",
    );
    const assetIds: string[] = [];
    for (let i = 0; i < ASSET_COUNT; i++) {
      const kind = i % 5;
      const month = String(1 + (i % 12)).padStart(2, "0");
      const base = {
        name: `ベンチマーク用の資産 ${i + 1}`,
        businessRatio: 10_000 - (i % 4) * 1_000,
      };
      const input =
        kind <= 1
          ? {
              ...base,
              acquiredOn: `${2022 + (i % 5)}-${month}-15`,
              acquisitionCost: 400_000 + i * 37_000,
              method: "straight_line",
              usefulLifeYears: 4 + (i % 12),
              assetAccountId: assetAcc("工具器具備品"),
            }
          : kind <= 3
            ? {
                ...base,
                acquiredOn: `${2024 + (i % 3)}-${month}-15`,
                acquisitionCost: 100_000 + ((i * 1_337) % 99_999),
                method: "lump_sum",
                assetAccountId: assetAcc("一括償却資産"),
              }
            : {
                ...base,
                acquiredOn: `${FISCAL_YEAR}-${month}-15`,
                acquisitionCost: 100_000 + ((i * 7_001) % 190_000),
                method: "small_asset_28_2",
                assetAccountId: assetAcc("工具器具備品"),
              };
      const { asset } = await json<{ asset: { id: string } }>(
        await call("POST", `${assetBase}/fixed-assets`, input),
        201,
        `資産 ${i + 1} の登録`,
      );
      assetIds.push(asset.id);
    }
    // 定額法の資産のうち 2 件は年の途中で除却（廃棄・売却）する
    for (const [index, disposalKind] of [
      [0, "scrap"],
      [5, "sale"],
    ] as const) {
      await json(
        await call("POST", `${assetBase}/fixed-assets/${assetIds[index]}/dispose`, {
          disposedOn: `${FISCAL_YEAR}-10-31`,
          reason: "ベンチマーク",
          disposalKind,
        }),
        200,
        `資産 ${index + 1} の除却`,
      );
    }
    const { deferredAsset } = await json<{ deferredAsset: { id: string } }>(
      await call("POST", `${assetBase}/deferred-assets`, {
        name: "ベンチマーク用の開業費",
        totalAmount: 600_000,
        openedOn: "2025-04-01",
        accountId: assetAcc("開業費"),
      }),
      201,
      "開業費の登録",
    );
    await json(
      await call(
        "PUT",
        `${assetBase}/deferred-assets/${deferredAsset.id}/amortizations/${FISCAL_YEAR}`,
        { amount: 120_000 },
      ),
      200,
      "開業費の償却額の決定",
    );
    // 案の一部を確定して、決算書と台帳が償却の仕訳を読む状態にする
    const adjustmentsPath = `${assetBase}/blue-return/${FISCAL_YEAR}/adjustments`;
    let committed = 0;
    for (;;) {
      const { proposals } = await json<{
        proposals: {
          kind: string;
          sourceId: string;
          journal: { lines: { side: string; amount: number }[] };
        }[];
      }>(await call("GET", adjustmentsPath), 200, "決算整理の案の取得");
      const proposal = proposals[0];
      // 半分だけ確定し、残りは案のまま画面が読む（案の作成の時間も測る）
      if (proposal === undefined || committed >= ASSET_COUNT / 2) break;
      const amount = proposal.journal.lines
        .filter((l) => l.side === "debit")
        .reduce((sum, l) => sum + l.amount, 0);
      await json(
        await call("POST", adjustmentsPath, {
          kind: proposal.kind,
          sourceId: proposal.sourceId,
          expected: { amount },
        }),
        201,
        "決算整理の仕訳の登録",
      );
      committed++;
    }
    console.log(
      `資産 ${ASSET_COUNT} 件と開業費 1 件を登録し、案 ${committed} 件を確定（残りは案のまま）`,
    );

    const assetPaths = [
      `${assetBase}/blue-return/${FISCAL_YEAR}`,
      adjustmentsPath,
      `${assetBase}/fixed-assets?year=${FISCAL_YEAR}`,
      `${assetBase}/deferred-assets?year=${FISCAL_YEAR}`,
    ];
    async function measureAssetScreen(): Promise<number> {
      const start = performance.now();
      for (const path of assetPaths) {
        const res = await call("GET", path);
        const body = await res.text();
        if (res.status !== 200)
          throw new Error(`GET ${path} が失敗しました: ${res.status} ${body}`);
      }
      return performance.now() - start;
    }
    const assetTargets: [name: string, run: () => Promise<number>][] = [
      ["blue-return", () => measure(assetPaths[0] ?? "")],
      ["adjustments", () => measure(assetPaths[1] ?? "")],
      ["fixed-assets?year=", () => measure(assetPaths[2] ?? "")],
      ["deferred-assets?year=", () => measure(assetPaths[3] ?? "")],
      ["screen (4 APIs)", measureAssetScreen],
    ];
    const assetRows = [];
    for (const [name, run] of assetTargets) {
      await run(); // ウォームアップ
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) times.push(await run());
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)] ?? Number.NaN;
      const max = times[times.length - 1] ?? Number.NaN;
      assetRows.push({
        target: name,
        "median (ms)": Number(median.toFixed(1)),
        "max (ms)": Number(max.toFixed(1)),
        result: max <= ASSET_LIMIT_MS ? "OK" : "NG",
      });
    }
    console.log(`償却資産: 資産 ${ASSET_COUNT} 件と開業費 1 件（${FISCAL_YEAR} 年度）`);
    console.table(assetRows);
    const assetFailed = assetRows.filter((r) => r.result === "NG");
    let sc005Ok = false;
    if (assetFailed.length > 0) {
      console.error(
        `SC-005（009）を満たしません: ${assetFailed.map((r) => r.target).join(", ")} が ${ASSET_LIMIT_MS} ms を超えました`,
      );
    } else {
      console.log(
        `SC-005（009）OK: 決算書の画面の API が ${ASSET_LIMIT_MS} ms 以内（${RUNS} 回の最大値）`,
      );
      sc005Ok = true;
    }
    // SC-002（010）: 証憑 5,000 件（ファイルなし。証憑とファイルの版の行だけをリポジトリで入れる）の事業体で、
    // 取引年月日の範囲 × 金額の範囲 × 取引先の部分一致の検索（GET /receipts）が各 1 秒以内（10 回）。
    const RECEIPT_COUNT = 5_000;
    const RECEIPT_QUERIES = 10;
    const RECEIPT_LIMIT_MS = positiveNumber("BENCH_RECEIPT_LIMIT_MS", 1_000);
    const { entity: receiptEntity } = await json<{ entity: { id: string } }>(
      await call("POST", "/entities", {
        name: "ベンチマーク（証憑）",
        kind: "individual",
        fiscalStartMonth: 1,
        firstFiscalYear: FISCAL_YEAR,
      }),
      201,
      "証憑用の事業体の作成",
    );
    const receiptBase = `/entities/${receiptEntity.id}`;
    const partnerNames = Array.from(
      { length: 100 },
      (_, i) => `ベンチ商店${String(i).padStart(3, "0")}`,
    );
    const receiptSetupStart = performance.now();
    const receiptUow = createReceiptUnitOfWork(openTenant(receiptEntity.id));
    const receiptResult = receiptUow.run((tx) => {
      for (let i = 0; i < RECEIPT_COUNT; i++) {
        const at = new Date(Date.UTC(FISCAL_YEAR, 0, 1, 0, 0, 0) + i * 60_000).toISOString();
        const sha256 = i.toString(16).padStart(64, "0");
        const partnerName = partnerNames[i % partnerNames.length] ?? "";
        const receipt: ReceiptRow = {
          id: randomUUIDv7(),
          receivedAt: at,
          channel: "local",
          category: i % 2 === 0 ? "paper_scan" : "electronic",
          currentSha256: sha256,
          transactionDate: dateOf(i, RECEIPT_COUNT),
          amount: 1_000 + ((i * 7_919) % 90_000),
          partnerName,
          partnerKey: normalizeReceiptText(partnerName),
          memo: null,
          deletedAt: null,
          deletedReason: null,
          version: 1,
          createdAt: at,
          updatedAt: at,
        };
        tx.receipts.insertReceipt(receipt);
        tx.receipts.insertFile({
          sha256,
          receiptId: receipt.id,
          fileVersion: 1,
          mediaType: "image/jpeg",
          sizeBytes: 1_000,
          originalName: `bench-${i}.jpg`,
          width: 2_400,
          height: 1_700,
          fullColor: true,
          addedAt: at,
          channel: "local",
        });
      }
      return ok(undefined);
    });
    if (!receiptResult.ok) throw new Error("証憑の行の登録に失敗しました");
    console.log(
      `証憑 ${RECEIPT_COUNT} 件（ファイルなし）を登録: ${(performance.now() - receiptSetupStart).toFixed(0)} ms`,
    );

    // 検索 10 通り（取引先の語・日付の範囲・金額の範囲を変える）
    const receiptSearches = Array.from({ length: RECEIPT_QUERIES }, (_, i) => {
      const monthFrom = String(1 + (i % 6)).padStart(2, "0");
      const monthTo = String(7 + (i % 6)).padStart(2, "0");
      const params = new URLSearchParams({
        dateFrom: `${FISCAL_YEAR}-${monthFrom}-01`,
        dateTo: `${FISCAL_YEAR}-${monthTo}-28`,
        amountMin: String(1_000 + i * 2_000),
        amountMax: String(60_000 + i * 3_000),
        partner: i % 3 === 0 ? "ベンチ商店" : `商店${String(i * 7).padStart(3, "0")}`,
      });
      return `${receiptBase}/receipts?${params.toString()}`;
    });
    await measure(receiptSearches[0] ?? ""); // ウォームアップ
    const receiptRows = [];
    for (const [i, path] of receiptSearches.entries()) {
      const elapsed = await measure(path);
      receiptRows.push({
        query: i + 1,
        "time (ms)": Number(elapsed.toFixed(1)),
        result: elapsed <= RECEIPT_LIMIT_MS ? "OK" : "NG",
      });
    }
    console.log(`証憑の検索: 証憑 ${RECEIPT_COUNT} 件（日付 × 金額 × 取引先）`);
    console.table(receiptRows);
    const receiptFailed = receiptRows.filter((r) => r.result === "NG");
    let sc002Ok = false;
    if (receiptFailed.length > 0) {
      console.error(
        `SC-002（010）を満たしません: 検索 ${receiptFailed.map((r) => r.query).join(", ")} が ${RECEIPT_LIMIT_MS} ms を超えました`,
      );
    } else {
      console.log(
        `SC-002（010）OK: 証憑の検索が ${RECEIPT_LIMIT_MS} ms 以内（${RECEIPT_QUERIES} 回の最大値）`,
      );
      sc002Ok = true;
    }
    return sc004Ok && sc006Ok && sc005Ok && sc002Ok;
  },
  () => tmp.cleanup(),
);
