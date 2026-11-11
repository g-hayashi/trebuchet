import { expect, type Page } from "@playwright/test";
import { ORIGIN_HEADERS } from "./auth.ts";
import { entityIdOf, mainOf } from "./ui.ts";

/**
 * 事業体の作成と、API での帳簿の準備。作成の画面の操作を確かめるのは `ledger-flow.spec.ts` の 1 本だけで、
 * ほかのテストは `createEntityViaApi` で作る（画面の手順を各テストに写さない）。
 * 呼ぶ前に `enterVault` で解錠していること。
 */

/**
 * 作成の画面（一覧）で事業体を作る（個人・1 月始まり）。作成後の事業体のホームに移る。事業体の ID を返す。
 * 事業体が 1 件だとトップはそのホームへ移るので、一覧と作成は `/?list=1` で開く
 */
export async function createEntityViaUi(
  page: Page,
  options: { name: string; firstFiscalYear: number },
): Promise<string> {
  await page.goto("/?list=1");
  const form = mainOf(page)
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "作成する", exact: true }) });
  await form.getByLabel("名称", { exact: true }).fill(options.name);
  await form.getByLabel("種別", { exact: true }).selectOption({ label: "個人" });
  await form.getByLabel("開始年度", { exact: true }).fill(String(options.firstFiscalYear));
  await form.getByLabel("期首の月", { exact: true }).selectOption({ label: "1月" });
  await form.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page).toHaveURL(/\/e\/[0-9a-f-]{36}$/);
  return entityIdOf(page);
}

/**
 * API で事業体を作る（個人・1 月始まり。画面は移らない）。事業体の ID を返す。
 * `page.request` は Origin を付けないので、CSRF の検査（FR-009）を通すために付ける。cookie は画面と共有する
 */
export async function createEntityViaApi(
  page: Page,
  options: { name: string; firstFiscalYear: number },
): Promise<string> {
  const res = await page.request.post("/api/entities", {
    headers: ORIGIN_HEADERS,
    data: {
      name: options.name,
      kind: "individual",
      fiscalStartMonth: 1,
      firstFiscalYear: options.firstFiscalYear,
    },
  });
  expect(res.status()).toBe(201);
  const { entity } = (await res.json()) as { entity: { id: string } };
  return entity.id;
}

/** 事業体の勘定科目の ID を、科目名から引く関数（科目がなければ例外） */
export async function accountIdLookup(
  page: Page,
  entityId: string,
): Promise<(name: string) => string> {
  const { accounts } = (await (
    await page.request.get(`/api/entities/${entityId}/accounts`)
  ).json()) as {
    accounts: { id: string; name: string }[];
  };
  return (name) => {
    const id = accounts.find((a) => a.name === name)?.id;
    if (id === undefined) throw new Error(`科目がありません: ${name}`);
    return id;
  };
}

/** API で仕訳を登録する（科目は名前で指す）。応答は呼び出し側が確かめる（拒否の確認にも使う） */
export async function postJournalViaApi(
  page: Page,
  entityId: string,
  journal: {
    date: string;
    lines: { side: "debit" | "credit"; account: string; amount: number }[];
  },
) {
  const accountId = await accountIdLookup(page, entityId);
  return page.request.post(`/api/entities/${entityId}/journals`, {
    headers: ORIGIN_HEADERS,
    data: {
      date: journal.date,
      lines: journal.lines.map((l) => ({
        side: l.side,
        accountId: accountId(l.account),
        amount: l.amount,
      })),
    },
  });
}
