/**
 * 見本のバックアップ（`scripts/make-backup-fixture.ts`）の合成の帳簿。server の API（`app.request`）だけで作る
 * （リポジトリへ直接書かない。各機能の不変条件は通常と同じに保たれる）。取引先・摘要はすべて架空。AI は呼ばない
 * （証憑の読み取りは make-backup-fixture.ts が渡す偽の読み取りを使う）。
 * 各機能の表に 1 行以上入ることを目指す（行のない表は make-backup-fixture.ts が表示する）。
 * freee の取込は、合成のフィクスチャ `packages/domain/test/fixtures/freee/journal-2025.csv`（README の匿名化の方針）を読む
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Request = (path: string, init?: RequestInit) => Promise<Response>;

type Json = Record<string, unknown>;

const FREEE_JOURNAL = fileURLToPath(
  new URL("../../packages/domain/test/fixtures/freee/journal-2025.csv", import.meta.url),
);

function makeCall(request: Request) {
  return async <T = Json>(method: string, path: string, body?: unknown): Promise<T> => {
    const init: RequestInit = { method };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    const res = await request(`/api${path}`, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return (text === "" ? {} : JSON.parse(text)) as T;
  };
}

type Call = ReturnType<typeof makeCall>;
type Account = { id: string; code: string; name: string };
type JournalLine = {
  side: "debit" | "credit";
  accountId: string;
  amount: number;
  description?: string;
};
type Proposal = { kind: string; sourceId: string; journal: { lines: JournalLine[] } };
type StatementView = {
  id: string;
  status: string;
  candidate: {
    draft: Json | null;
    match?: { journalId: string; lineId: string } | undefined;
  } | null;
};

/** 科目の名前かコードから ID を引く関数 */
async function accountsOf(call: Call, base: string): Promise<(nameOrCode: string) => string> {
  const { accounts } = await call<{ accounts: Account[] }>("GET", `${base}/accounts`);
  return (nameOrCode) => {
    const found = accounts.find((a) => a.name === nameOrCode || a.code === nameOrCode);
    if (found === undefined) throw new Error(`科目がない: ${nameOrCode}`);
    return found.id;
  };
}

/** 事業体 1: デモ事業（014 の計画）に、決算整理の登録・地代家賃の内訳・明細の承認と除外・証憑の読み取りを足す */
async function buildDemoEntity(call: Call): Promise<void> {
  // 期首残高・取引先・仕訳・訂正・取消・按分・資産・開業費・定期・請求と入金（源泉徴収）・証憑・明細
  const { entity } = await call<{ entity: { id: string } }>("POST", "/entities/demo");
  const base = `/entities/${entity.id}`;
  const { fiscalPeriods } = await call<{ fiscalPeriods: { fiscalYear: number }[] }>(
    "GET",
    `${base}/fiscal-periods`,
  );
  const year = fiscalPeriods[0]?.fiscalYear;
  if (year === undefined) throw new Error("デモ事業に会計期間がない");

  // 開業費の今年度の償却額を決め（009）、決算整理（按分・償却・開業費の償却）の案を、利用者と同じく案のまま
  // 登録する（003・009）
  const { deferredAssets } = await call<{ deferredAssets: { id: string }[] }>(
    "GET",
    `${base}/deferred-assets`,
  );
  for (const d of deferredAssets) {
    await call("PUT", `${base}/deferred-assets/${d.id}/amortizations/${year}`, {
      amount: 10_000,
    });
  }
  const { proposals } = await call<{ proposals: Proposal[] }>(
    "GET",
    `${base}/blue-return/${year}/adjustments`,
  );
  for (const p of proposals) {
    const amount = p.journal.lines
      .filter((l) => l.side === "debit")
      .reduce((sum, l) => sum + l.amount, 0);
    await call("POST", `${base}/blue-return/${year}/adjustments`, {
      kind: p.kind,
      sourceId: p.sourceId,
      expected: { amount },
    });
  }
  await call("PUT", `${base}/blue-return/${year}/rent-details`, {
    rows: [
      {
        payee: "見本不動産株式会社",
        property: "見本市見本町 1-2-3 の事務所",
        annualRent: 600_000,
        deductibleAmount: 300_000,
      },
    ],
  });

  // 明細（006・007）: 設定、候補、1 件の承認（ルールを学ぶ）、1 件の除外
  await call("PUT", `${base}/statement-settings`, { bulkThreshold: 90, externalThreshold: 70 });
  await call("POST", `${base}/statements/candidates`, {});
  const { statements } = await call<{ statements: StatementView[] }>("GET", `${base}/statements`);
  const pending = statements.filter((s) => s.status === "unprocessed" || s.status === "pending");
  // 候補の案（draft）か、既存の仕訳との対応（match）のあるものを、候補のとおりに承認する
  const approvable = pending.find((s) => s.candidate?.draft != null || s.candidate?.match);
  if (approvable?.candidate?.draft != null) {
    await call("POST", `${base}/statements/${approvable.id}/approve`, {
      draft: approvable.candidate.draft,
    });
  } else if (approvable?.candidate?.match !== undefined) {
    await call("POST", `${base}/statements/${approvable.id}/approve`, {
      match: approvable.candidate.match,
    });
  }
  const toExclude = pending.find((s) => s.id !== approvable?.id);
  if (toExclude !== undefined) {
    await call("POST", `${base}/statements/${toExclude.id}/exclude`, { reason: "私用の支払い" });
  }

  // 証憑の読み取り（010。偽の読み取りの結果を記録する）
  const { receipts } = await call<{ receipts: { id: string }[] }>("GET", `${base}/receipts`);
  const first = receipts[0];
  if (first !== undefined) await call("POST", `${base}/receipts/${first.id}/readings`);
}

/**
 * 事業体 2: freee の取込（002）、タグ・訂正・取消、決算のメモと青色申告特別控除の回答、2025 年度の締め、
 * 次の年度、入力途中の仕訳（011）
 */
async function buildClosedEntity(call: Call): Promise<void> {
  const { entity } = await call<{ entity: { id: string } }>("POST", "/entities", {
    name: "見本の事業（合成）",
    kind: "individual",
    fiscalStartMonth: 1,
    firstFiscalYear: 2025,
  });
  const base = `/entities/${entity.id}`;
  const account = await accountsOf(call, base);
  const cash = account("現金");
  const bank = account("普通預金");
  const sales = account("売上高");
  const supplies = account("消耗品費");

  // freee の取込（対応表を先に保存する）
  await call("PUT", `${base}/import-mappings`, {
    // 5140 は帳簿の交際費の科目のコード（freee の「交際費」を対応づける）
    accounts: [{ sourceName: "交際費", accountId: account("5140") }],
    taxes: [{ sourceName: "課対仕入８％（軽）", taxCategory: "PURCHASE_8R" }],
  });
  const csv = readFileSync(FREEE_JOURNAL);
  const form = (expected?: { fileSha256: string; countNew: number }) => {
    const data = new FormData();
    data.append("file", new File([csv], "journal-2025.csv", { type: "text/csv" }));
    data.append("options", "{}");
    if (expected !== undefined) data.append("expected", JSON.stringify(expected));
    return data;
  };
  const { preview } = await call<{
    preview: { file: { sha256: string }; counts: { new: number }; ready: boolean };
  }>("POST", `${base}/imports/freee/preview`, form());
  if (!preview.ready) throw new Error("freee の取込の準備ができていない");
  await call(
    "POST",
    `${base}/imports/freee/commit`,
    form({ fileSha256: preview.file.sha256, countNew: preview.counts.new }),
  );

  // タグつきの仕訳、訂正、取消
  const { tag } = await call<{ tag: { id: string } }>("POST", `${base}/tags`, {
    name: "見本の案件",
  });
  const journal = (date: string, memo: string, lines: (JournalLine & { tagIds?: string[] })[]) =>
    call<{ journal: { id: string; version: number } }>("POST", `${base}/journals`, {
      date,
      memo,
      lines,
    });
  await journal("2025-05-10", "見本の売上（案件）", [
    { side: "debit", accountId: bank, amount: 110_000, tagIds: [tag.id] },
    { side: "credit", accountId: sales, amount: 110_000, tagIds: [tag.id] },
  ]);
  const toCorrect = await journal("2025-06-15", "見本の売上", [
    { side: "debit", accountId: bank, amount: 55_000 },
    { side: "credit", accountId: sales, amount: 55_000 },
  ]);
  await call("PUT", `${base}/journals/${toCorrect.journal.id}`, {
    date: "2025-06-15",
    memo: "見本の売上（金額の訂正）",
    lines: [
      { side: "debit", accountId: bank, amount: 66_000 },
      { side: "credit", accountId: sales, amount: 66_000 },
    ],
    reason: "金額の誤り",
    version: toCorrect.journal.version,
  });
  const toVoid = await journal("2025-07-01", "見本の二重登録", [
    { side: "debit", accountId: supplies, amount: 1_100 },
    { side: "credit", accountId: cash, amount: 1_100 },
  ]);
  await call("POST", `${base}/journals/${toVoid.journal.id}/void`, {
    reason: "二重登録",
    version: toVoid.journal.version,
  });

  // 摘要つきの仕訳から推定のルールを作る（006。inference_rules と履歴）
  for (const date of ["2025-08-05", "2025-09-05"]) {
    await journal(date, "見本の文具", [
      { side: "debit", accountId: supplies, amount: 2_200, description: "見本文具店" },
      { side: "credit", accountId: bank, amount: 2_200, description: "見本文具店" },
    ]);
  }
  await call("POST", `${base}/inference-rules/seed`, {});

  // 決算（003）: メモと控除の回答 → 次の年度 → 2025 年度の締め
  await call("PUT", `${base}/blue-return/2025/notes/special_circumstances`, {
    body: "見本の特別な事情（合成）",
  });
  await call("PUT", `${base}/blue-return/2025/deduction-answers`, {
    doubleEntry: true,
    statementsAttached: true,
    filedOnTime: true,
    eTax: true,
    electronicBooks: false,
  });
  await call("POST", `${base}/fiscal-periods`);
  await call("POST", `${base}/fiscal-periods/2025/close`);
  await journal("2026-01-20", "見本の消耗品（翌年度）", [
    { side: "debit", accountId: supplies, amount: 3_300 },
    { side: "credit", accountId: cash, amount: 3_300 },
  ]);

  // 入力途中の仕訳（011/R6。仕訳として検証しない）
  await call("PUT", `${base}/journal-draft`, {
    mode: "quick",
    date: "2026-02-01",
    memo: "見本の入力途中",
    partnerId: null,
    tagIds: [],
    lines: [
      {
        side: "debit",
        accountId: supplies,
        subAccountId: null,
        amount: 2_200,
        taxCategory: null,
        partnerId: null,
        tagIds: [],
        description: null,
      },
    ],
  });
}

/** 合成の帳簿（事業体 2 つ）を、空のデータ場所に作る */
export async function buildFixtureLedger(request: Request): Promise<void> {
  const call = makeCall(request);
  // デモ事業は空のデータ場所でだけ作れるので先に作る
  await buildDemoEntity(call);
  await buildClosedEntity(call);
}
