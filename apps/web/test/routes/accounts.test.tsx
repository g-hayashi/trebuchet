import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, SubAccount } from "@/features/accounts/api";
import { Route } from "@/routes/e/$entityId/accounts";
import { expectLedgerInvalidated, seedLedgerQueries } from "../ledger-cache";
import { apiError, mockApi, ok } from "../mock-api";
import { renderRoute } from "../render-route";

const BASE = "/api/entities/e1/accounts";

const account = (
  a: Pick<Account, "id" | "name" | "reportSection" | "sortOrder"> & Partial<Account>,
): Account => ({
  code: String(a.sortOrder),
  category: "asset",
  normalSide: "debit",
  reportLine: null,
  isSystem: false,
  isActive: true,
  ...a,
});

const cash = account({
  id: "cash",
  name: "現金",
  reportSection: "BS_ASSET",
  sortOrder: 1010,
  isSystem: true,
});
const bank = account({
  id: "bank",
  name: "普通預金",
  reportSection: "BS_ASSET",
  sortOrder: 1020,
  isActive: false,
});
const loan = account({
  id: "loan",
  name: "借入金",
  category: "liability",
  normalSide: "credit",
  reportSection: "BS_LIABILITY",
  sortOrder: 2010,
});
const sales = account({
  id: "sales",
  name: "売上高",
  category: "revenue",
  normalSide: "credit",
  reportSection: "PL_SALES",
  sortOrder: 4010,
  reportLine: 1,
});
const supplies = account({
  id: "supplies",
  name: "消耗品費",
  category: "expense",
  reportSection: "PL_EXPENSE",
  sortOrder: 6010,
});

/** API の順は決算書の順と限らない */
const initialAccounts = () => [supplies, cash, sales, bank, loan];

function renderAccounts() {
  return renderRoute(Route, { path: "/e/$entityId/accounts", url: "/e/e1/accounts" });
}

/** 一覧の行を上から順に、区分の見出し（[ ] で囲む）または科目の名称として読む */
function readList() {
  return within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => {
      const heading = row.querySelector('th[scope="colgroup"]');
      if (heading) return `[${heading.textContent}]`;
      return row.querySelectorAll("td")[1]?.textContent ?? "";
    });
}

function rowOf(name: string) {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`${name} の行がありません`);
  return row;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("勘定科目の画面", () => {
  it("決算書の順（sortOrder）に区分ごとにまとめる。使用停止の科目は既定では隠し、外すと薄く表示する", async () => {
    mockApi({ [`GET ${BASE}`]: () => ok({ accounts: initialAccounts() }) });
    const user = userEvent.setup();
    renderAccounts();

    await screen.findByText("現金");
    expect(screen.getByRole("checkbox", { name: "使用停止を隠す" })).toBeChecked();
    expect(readList()).toEqual([
      "[資産]",
      "現金最初からある科目",
      "[負債]",
      "借入金",
      "[売上]",
      "売上高",
      "[経費]",
      "消耗品費",
    ]);
    expect(screen.getByText("使用停止の科目 1 件を隠しています。")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "使用停止を隠す" }));
    expect(readList()).toEqual([
      "[資産]",
      "現金最初からある科目",
      "普通預金（使用停止）",
      "[負債]",
      "借入金",
      "[売上]",
      "売上高",
      "[経費]",
      "消耗品費",
    ]);
    expect(rowOf("普通預金")).toHaveClass("opacity-50");
    expect(rowOf("現金")).not.toHaveClass("opacity-50");
    expect(within(rowOf("売上高")).getAllByRole("cell")[2]).toHaveTextContent("収益");
    expect(screen.getByRole("button", { name: "使用再開（普通預金）" })).toBeEnabled();
  });

  it("最初からある科目には印を出し、名前の変更・削除を出さない。使用停止は出す（outline）", async () => {
    mockApi({ [`GET ${BASE}`]: () => ok({ accounts: initialAccounts() }) });
    renderAccounts();
    await screen.findByText("現金");

    const system = within(rowOf("現金"));
    expect(system.getByText("最初からある科目")).toBeInTheDocument();
    expect(system.queryByRole("button", { name: "名称変更（現金）" })).not.toBeInTheDocument();
    expect(system.queryByRole("button", { name: "削除（現金）" })).not.toBeInTheDocument();
    expect(system.getByRole("button", { name: "補助科目（現金）" })).toBeInTheDocument();

    const mine = within(rowOf("消耗品費"));
    expect(mine.queryByText("最初からある科目")).not.toBeInTheDocument();
    expect(mine.getByRole("button", { name: "名称変更（消耗品費）" })).toBeInTheDocument();
    expect(mine.getByRole("button", { name: "削除（消耗品費）" })).toBeInTheDocument();

    for (const name of ["現金", "消耗品費"]) {
      const stop = within(rowOf(name)).getByRole("button", { name: `使用停止（${name}）` });
      expect(stop).toHaveClass("border");
      // 各行の右端
      expect(stop.parentElement?.lastElementChild).toBe(stop);
    }
  });

  it("検索で名前・コード・初期科目の読みを絞り込み、見つからなければ知らせる", async () => {
    mockApi({ [`GET ${BASE}`]: () => ok({ accounts: initialAccounts() }) });
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("現金");

    const search = screen.getByRole("searchbox", { name: "科目を検索" });
    await user.type(search, "消耗");
    expect(readList()).toEqual(["[経費]", "消耗品費"]);

    await user.clear(search);
    await user.type(search, "げんきん");
    expect(readList()).toEqual(["[資産]", "現金最初からある科目"]);

    await user.clear(search);
    await user.type(search, "6010");
    expect(readList()).toEqual(["[経費]", "消耗品費"]);

    await user.clear(search);
    await user.type(search, "存在しない科目");
    expect(screen.getByText("条件に合う科目はありません。")).toBeInTheDocument();
  });

  it("区分に応じて決算書の区分を選び、科目を追加する", async () => {
    let accounts = initialAccounts();
    const calls = mockApi({
      [`GET ${BASE}`]: () => ok({ accounts }),
      [`POST ${BASE}`]: () => {
        const created = account({
          id: "fees",
          name: "受取手数料",
          category: "revenue",
          normalSide: "credit",
          reportSection: "PL_OTHER",
          sortOrder: 4020,
        });
        accounts = [...accounts, created];
        return ok({ account: created }, 201);
      },
    });
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("現金");

    const section = () => screen.getByLabelText("決算書の区分");
    const sectionOptions = () =>
      within(section())
        .getAllByRole("option")
        .map((o) => o.textContent);
    expect(sectionOptions()).toEqual(["売上原価", "経費", "その他の損益"]);
    expect(section()).toHaveValue("PL_EXPENSE");

    await user.selectOptions(screen.getByLabelText("区分"), "収益");
    expect(sectionOptions()).toEqual(["売上", "その他の損益"]);
    expect(section()).toHaveValue("PL_SALES");

    await user.selectOptions(section(), "その他の損益");
    await user.type(screen.getByLabelText("名称"), "受取手数料");
    await user.click(screen.getByRole("button", { name: "追加する" }));

    expect(await screen.findByText("受取手数料")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "受取手数料",
      category: "revenue",
      reportSection: "PL_OTHER",
    });
    expect(screen.getByLabelText("名称")).toHaveValue("");
  });

  it("名称が空なら追加せずにエラーを表示する", async () => {
    const calls = mockApi({ [`GET ${BASE}`]: () => ok({ accounts: initialAccounts() }) });
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("現金");

    await user.click(screen.getByRole("button", { name: "追加する" }));

    expect(await screen.findByText("名称を入力してください")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("科目の名称を変更する", async () => {
    let accounts = initialAccounts();
    const calls = mockApi({
      [`GET ${BASE}`]: () => ok({ accounts }),
      [`PATCH ${BASE}/supplies`]: () => {
        accounts = accounts.map((a) => (a.id === "supplies" ? { ...a, name: "事務用品費" } : a));
        return ok({ account: accounts.find((a) => a.id === "supplies") });
      },
    });
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("消耗品費");

    await user.click(screen.getByRole("button", { name: "名称変更（消耗品費）" }));
    const input = screen.getByLabelText("「消耗品費」の新しい名称");
    await user.clear(input);
    await user.type(input, "事務用品費");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("事務用品費")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "事務用品費" });
    expect(screen.queryByLabelText("「消耗品費」の新しい名称")).not.toBeInTheDocument();
  });

  it("科目の名称を変更すると、帳票・決算書・ホームを読み直す", async () => {
    mockApi({
      [`GET ${BASE}`]: () => ok({ accounts: initialAccounts() }),
      [`PATCH ${BASE}/supplies`]: () =>
        ok({
          account: { ...initialAccounts().find((a) => a.id === "supplies"), name: "事務用品費" },
        }),
    });
    const user = userEvent.setup();
    const { queryClient } = renderAccounts();
    await screen.findByText("消耗品費");
    seedLedgerQueries(queryClient);

    await user.click(screen.getByRole("button", { name: "名称変更（消耗品費）" }));
    const input = screen.getByLabelText("「消耗品費」の新しい名称");
    await user.clear(input);
    await user.type(input, "事務用品費");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(screen.queryByLabelText("「消耗品費」の新しい名称")).not.toBeInTheDocument(),
    );
    expectLedgerInvalidated(queryClient);
  });

  it("科目を使用停止・使用再開する（隠す表示を外すと行が残る）", async () => {
    let accounts = initialAccounts();
    const setActive = (id: string) => (call: { body: unknown }) => {
      const { isActive } = call.body as { isActive: boolean };
      accounts = accounts.map((a) => (a.id === id ? { ...a, isActive } : a));
      return ok({ account: accounts.find((a) => a.id === id) });
    };
    const calls = mockApi({
      [`GET ${BASE}`]: () => ok({ accounts }),
      [`PATCH ${BASE}/cash`]: setActive("cash"),
      [`PATCH ${BASE}/bank`]: setActive("bank"),
    });
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("現金");
    await user.click(screen.getByRole("checkbox", { name: "使用停止を隠す" }));

    await user.click(screen.getByRole("button", { name: "使用停止（現金）" }));
    expect(await screen.findByRole("button", { name: "使用再開（現金）" })).toBeInTheDocument();
    expect(rowOf("現金")).toHaveClass("opacity-50");

    await user.click(screen.getByRole("button", { name: "使用再開（普通預金）" }));
    expect(await screen.findByRole("button", { name: "使用停止（普通預金）" })).toBeInTheDocument();
    expect(rowOf("普通預金")).not.toHaveClass("opacity-50");

    expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.path, c.body])).toEqual([
      [`${BASE}/cash`, { isActive: false }],
      [`${BASE}/bank`, { isActive: true }],
    ]);
  });

  it("使用停止にすると、隠す表示のときは一覧から消える", async () => {
    let accounts = initialAccounts();
    mockApi({
      [`GET ${BASE}`]: () => ok({ accounts }),
      [`PATCH ${BASE}/supplies`]: () => {
        accounts = accounts.map((a) => (a.id === "supplies" ? { ...a, isActive: false } : a));
        return ok({ account: accounts.find((a) => a.id === "supplies") });
      },
    });
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("消耗品費");

    await user.click(screen.getByRole("button", { name: "使用停止（消耗品費）" }));
    await waitFor(() => expect(screen.queryByText("消耗品費")).not.toBeInTheDocument());
  });

  it("確認してから科目を削除する", async () => {
    let accounts = initialAccounts();
    const calls = mockApi({
      [`GET ${BASE}`]: () => ok({ accounts }),
      [`DELETE ${BASE}/supplies`]: () => {
        accounts = accounts.filter((a) => a.id !== "supplies");
        return ok(undefined, 204);
      },
    });
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("消耗品費");

    await user.click(screen.getByRole("button", { name: "削除（消耗品費）" }));
    expect(confirm).toHaveBeenLastCalledWith("「消耗品費」を削除しますか？");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "削除（消耗品費）" }));
    await waitFor(() => expect(screen.queryByText("消耗品費")).not.toBeInTheDocument());
    expect(readList()).not.toContain("[経費]");
  });

  it("使われている科目を削除しようとすると、使用停止を促すエラーを表示する", async () => {
    mockApi({
      [`GET ${BASE}`]: () => ok({ accounts: initialAccounts() }),
      [`DELETE ${BASE}/supplies`]: () => apiError(409, "ACCOUNT_IN_USE", "account is in use"),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("消耗品費");

    await user.click(screen.getByRole("button", { name: "削除（消耗品費）" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "この科目は仕訳や期首残高で使われているため削除できません。代わりに使用停止にしてください。",
    );
    expect(screen.getByText("消耗品費")).toBeInTheDocument();
  });

  it("費用の科目の決算書の欄を選んで変更する（8〜31 と「なし」）。費用以外には選択を出さない", async () => {
    let accounts = initialAccounts();
    const calls = mockApi({
      [`GET ${BASE}`]: () => ok({ accounts }),
      [`PATCH ${BASE}/supplies`]: (call) => {
        const { reportLine } = call.body as { reportLine: number | null };
        accounts = accounts.map((a) => (a.id === "supplies" ? { ...a, reportLine } : a));
        return ok({ account: accounts.find((a) => a.id === "supplies") });
      },
    });
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("消耗品費");

    expect(screen.queryByLabelText("決算書の欄（現金）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("決算書の欄（売上高）")).not.toBeInTheDocument();
    expect(within(rowOf("売上高")).getAllByRole("cell")[3]).toHaveTextContent("1");

    const select = screen.getByLabelText("決算書の欄（消耗品費）");
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["なし", ...Array.from({ length: 24 }, (_, i) => String(i + 8))]);
    expect(select).toHaveValue("");

    await user.selectOptions(select, "17");
    await waitFor(() => expect(screen.getByLabelText("決算書の欄（消耗品費）")).toHaveValue("17"));
    await user.selectOptions(screen.getByLabelText("決算書の欄（消耗品費）"), "なし");
    await waitFor(() => expect(screen.getByLabelText("決算書の欄（消耗品費）")).toHaveValue(""));

    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([
      { reportLine: 17 },
      { reportLine: null },
    ]);
  });

  it("欄の変更が拒否されたら、理由を表示する", async () => {
    mockApi({
      [`GET ${BASE}`]: () => ok({ accounts: initialAccounts() }),
      [`PATCH ${BASE}/supplies`]: () =>
        apiError(422, "REPORT_LINE_INVALID", "reportLine must be 8-31"),
    });
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("消耗品費");

    await user.selectOptions(screen.getByLabelText("決算書の欄（消耗品費）"), "9");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "決算書の欄は、費用の科目の 8〜31 から選んでください。",
    );
  });

  it("補助科目を表示し、追加する", async () => {
    let subAccounts: SubAccount[] = [];
    const calls = mockApi({
      [`GET ${BASE}`]: () => ok({ accounts: initialAccounts() }),
      [`GET ${BASE}/cash/sub-accounts`]: () => ok({ subAccounts }),
      [`POST ${BASE}/cash/sub-accounts`]: (call) => {
        const { name } = call.body as { name: string };
        const created = { id: "s1", accountId: "cash", name, isActive: true };
        subAccounts = [...subAccounts, created];
        return ok({ subAccount: created }, 201);
      },
    });
    const user = userEvent.setup();
    renderAccounts();
    await screen.findByText("現金");

    const toggle = screen.getByRole("button", { name: "補助科目（現金）" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("補助科目はありません。")).toBeInTheDocument();

    await user.type(screen.getByLabelText("補助科目を追加"), "○○銀行");
    await user.click(screen.getByRole("button", { name: "追加" }));

    const list = await screen.findByRole("list", { name: "「現金」の補助科目" });
    expect(within(list).getByText("○○銀行")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "○○銀行" });
    expect(screen.getByLabelText("補助科目を追加")).toHaveValue("");
  });
});
