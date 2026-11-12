/**
 * bench が `app.request` を直接呼ぶための道具（認証ヘッダー付きの呼び出し、JSON の読み取り、事業体の作成）。
 * ヘッダーは `bench-session.ts` の `createBenchHeaders`。
 */

/** `app.request` だけを使う（Hono の app） */
type BenchApp = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

export type BenchClient = ReturnType<typeof createBenchClient>;

export function createBenchClient(app: BenchApp, headers: Record<string, string>) {
  /** `/api` + path を呼ぶ。body があれば JSON で送る */
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit =
      body === undefined
        ? { method, headers }
        : {
            method,
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          };
    return app.request(`/api${path}`, init);
  }

  /** multipart（`file` と `options` の JSON など）。Content-Type は境界つきで fetch が付ける */
  async function callForm(path: string, form: FormData): Promise<Response> {
    return app.request(`/api${path}`, { method: "POST", headers, body: form });
  }

  /** 応答が `expected` の状態なら JSON を返す。違えば例外 */
  async function json<T>(res: Response, expected: number, what: string): Promise<T> {
    if (res.status !== expected) {
      throw new Error(`${what} が失敗しました: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /** 応答を JSON として読み終えるまでの時間（ミリ秒）と本文 */
  async function timed<T>(
    expected: number,
    what: string,
    send: () => Promise<Response>,
  ): Promise<{ ms: number; value: T }> {
    const start = performance.now();
    const res = await send();
    const value = await json<T>(res, expected, what);
    return { ms: performance.now() - start, value };
  }

  return { call, callForm, json, timed };
}

export type CreatedEntity = {
  id: string;
  /** `/entities/<id>`（`call` に渡すパスの先頭） */
  base: string;
  /** 科目名から勘定科目の ID。なければ例外 */
  acc: (name: string) => string;
};

/**
 * 事業体（個人事業・1 月始まり）を API で作り、勘定科目を取得し、期首残高があれば登録する。
 * 会計期間と勘定科目の初期セットは作成時に用意される。`label` は失敗の説明に付く
 */
export async function createEntityViaApi(
  client: BenchClient,
  options: {
    name: string;
    firstFiscalYear: number;
    /** 期首残高（科目名・貸借・金額）。なければ登録しない */
    openingBalances?: readonly { account: string; side: "debit" | "credit"; amount: number }[];
    label?: string;
  },
): Promise<CreatedEntity> {
  const { call, json } = client;
  const suffix = options.label === undefined ? "" : `（${options.label}）`;
  const { entity } = await json<{ entity: { id: string } }>(
    await call("POST", "/entities", {
      name: options.name,
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear: options.firstFiscalYear,
    }),
    201,
    `事業体の作成${suffix}`,
  );
  const base = `/entities/${entity.id}`;

  const { accounts } = await json<{ accounts: { id: string; name: string }[] }>(
    await call("GET", `${base}/accounts`),
    200,
    `勘定科目の取得${suffix}`,
  );
  const ids = new Map(accounts.map((a) => [a.name, a.id]));
  const acc = (name: string): string => {
    const id = ids.get(name);
    if (id === undefined) throw new Error(`科目がありません: ${name}`);
    return id;
  };

  if (options.openingBalances !== undefined) {
    await json(
      await call(
        "PUT",
        `${base}/fiscal-periods/${options.firstFiscalYear}/opening-balances`,
        options.openingBalances.map((b) => ({
          accountId: acc(b.account),
          side: b.side,
          amount: b.amount,
        })),
      ),
      200,
      `期首残高の登録${suffix}`,
    );
  }
  return { id: entity.id, base, acc };
}
