import { randomUUIDv7 } from "node:crypto";
import {
  type Account,
  type AccountCategory,
  type AuditEntry,
  createEntity,
  type EntityProfile,
  type FiscalPeriod,
  INDIVIDUAL_ACCOUNTS,
  NORMAL_SIDE,
  type OpeningBalance,
  ok,
  TAX_CATEGORIES,
  TAX_RATES,
} from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrizzleMasterRepository } from "../src/master-repository.ts";
import { DrizzleRegistryRepository } from "../src/registry-repository.ts";
import { openRegistry, openTenant, type TenantDb } from "../src/tenant-store.ts";
import { type TempDataDir, testClock, testIds, useTempDataDir } from "../src/testing.ts";

let tmp: TempDataDir;
let db: TenantDb;
let repo: DrizzleMasterRepository;
beforeEach(() => {
  tmp = useTempDataDir("master-repo");
  db = openTenant(randomUUIDv7());
  repo = new DrizzleMasterRepository(db);
});
afterEach(() => tmp.cleanup());

const SECTION: Record<AccountCategory, Account["reportSection"]> = {
  asset: "BS_ASSET",
  liability: "BS_LIABILITY",
  equity: "BS_EQUITY",
  revenue: "PL_SALES",
  expense: "PL_EXPENSE",
};

let seq = 0;
function account(category: AccountCategory, overrides: Partial<Account> = {}): Account {
  seq += 1;
  return {
    id: randomUUIDv7(),
    code: `9${String(seq).padStart(3, "0")}`,
    name: `科目${seq}`,
    category,
    normalSide: NORMAL_SIDE[category],
    reportSection: SECTION[category],
    reportLine: null,
    sortOrder: seq,
    isSystem: false,
    isActive: true,
    ...overrides,
  };
}

function period(fiscalYear: number, overrides: Partial<FiscalPeriod> = {}): FiscalPeriod {
  return {
    id: randomUUIDv7(),
    fiscalYear,
    startDate: `${fiscalYear}-01-01`,
    endDate: `${fiscalYear}-12-31`,
    status: "open",
    closedAt: null,
    ...overrides,
  };
}

function balance(
  fiscalPeriodId: string,
  accountId: string,
  side: OpeningBalance["side"],
  amount: number,
  subAccountId: string | null = null,
): OpeningBalance {
  return { id: randomUUIDv7(), fiscalPeriodId, accountId, subAccountId, side, amount };
}

/** 仕訳を1行だけ直接入れる（科目の使用判定の確認用。仕訳のリポジトリは US2 で実装する） */
function insertJournalLine(
  fiscalPeriodId: string,
  accountId: string,
  status: "active" | "voided",
): void {
  const journalId = randomUUIDv7();
  const now = "2026-10-18T00:00:00.000Z";
  db.$client
    .prepare(
      "INSERT INTO journals (id, journal_no, date, fiscal_period_id, memo, status, created_at, updated_at) VALUES (?, (SELECT COALESCE(MAX(journal_no), 0) + 1 FROM journals), '2026-01-10', ?, NULL, ?, ?, ?)",
    )
    .run(journalId, fiscalPeriodId, status, now, now);
  db.$client
    .prepare(
      "INSERT INTO journal_lines (id, journal_id, line_no, side, account_id, amount, tax_category, tax_amount) VALUES (?, ?, 1, 'debit', ?, 1000, 'OUT_OF_SCOPE', 0)",
    )
    .run(randomUUIDv7(), journalId, accountId);
}

const count = (table: string) =>
  (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("DrizzleMasterRepository", () => {
  it("事業体のプロファイルを保存・取得でき、保存し直すと上書きされる", () => {
    expect(repo.getProfile()).toBeUndefined();
    const profile: EntityProfile = {
      id: randomUUIDv7(),
      name: "個人事業",
      kind: "individual",
      fiscalStartMonth: 1,
      createdAt: "2026-10-18T00:00:00.000Z",
    };
    repo.saveProfile(profile);
    expect(repo.getProfile()).toEqual(profile);
    repo.saveProfile({ ...profile, name: "屋号あり" });
    expect(repo.getProfile()).toEqual({ ...profile, name: "屋号あり" });
    expect(count("entity_profile")).toBe(1);
  });

  describe("勘定科目", () => {
    it("保存した科目を取得でき、一覧は sortOrder、code の順", () => {
      const c = account("expense", { sortOrder: 20, code: "5002", reportLine: 23 });
      const a = account("asset", { sortOrder: 10, isSystem: true });
      const b = account("expense", { sortOrder: 20, code: "5001", isActive: false });
      for (const x of [c, a, b]) repo.insertAccount(x);
      expect(repo.listAccounts()).toEqual([a, b, c]);
      expect(repo.getAccount(c.id)).toEqual(c);
      expect(repo.getAccount(randomUUIDv7())).toBeUndefined();
    });

    it("科目を更新できる", () => {
      const a = account("asset");
      repo.insertAccount(a);
      const updated = { ...a, name: "変更後", isActive: false };
      repo.updateAccount(updated);
      expect(repo.getAccount(a.id)).toEqual(updated);
    });

    it("科目を削除すると補助科目もあわせて削除される", () => {
      const a = account("asset");
      const other = account("asset");
      repo.insertAccount(a);
      repo.insertAccount(other);
      repo.insertSubAccount({ id: randomUUIDv7(), accountId: a.id, name: "A銀行", isActive: true });
      const keep = { id: randomUUIDv7(), accountId: other.id, name: "B銀行", isActive: true };
      repo.insertSubAccount(keep);
      repo.deleteAccount(a.id);
      expect(repo.getAccount(a.id)).toBeUndefined();
      expect(repo.listSubAccounts()).toEqual([keep]);
    });

    it("仕訳行（取消済みを含む）または期首残高で参照されていれば使用中", () => {
      const p = period(2026);
      repo.insertFiscalPeriod(p);
      const [unused, inJournal, inVoided, inOpening, counter] = [1, 2, 3, 4, 5].map(() =>
        account("asset"),
      ) as [Account, Account, Account, Account, Account];
      for (const a of [unused, inJournal, inVoided, inOpening, counter]) repo.insertAccount(a);
      insertJournalLine(p.id, inJournal.id, "active");
      insertJournalLine(p.id, inVoided.id, "voided");
      repo.replaceOpeningBalances(p.id, [
        balance(p.id, inOpening.id, "debit", 100),
        balance(p.id, counter.id, "credit", 100),
      ]);
      expect(repo.isAccountUsed(unused.id)).toBe(false);
      expect(repo.isAccountUsed(inJournal.id)).toBe(true);
      expect(repo.isAccountUsed(inVoided.id)).toBe(true);
      expect(repo.isAccountUsed(inOpening.id)).toBe(true);
    });
  });

  it("補助科目は科目で絞り込める", () => {
    const a = account("asset");
    const b = account("asset");
    repo.insertAccount(a);
    repo.insertAccount(b);
    const s1 = { id: randomUUIDv7(), accountId: a.id, name: "A銀行", isActive: true };
    const s2 = { id: randomUUIDv7(), accountId: b.id, name: "B銀行", isActive: false };
    const s3 = { id: randomUUIDv7(), accountId: a.id, name: "C銀行", isActive: true };
    for (const s of [s1, s2, s3]) repo.insertSubAccount(s);
    expect(repo.listSubAccounts()).toEqual([s1, s2, s3]);
    expect(repo.listSubAccounts(a.id)).toEqual([s1, s3]);
  });

  it("取引先を追加・更新できる", () => {
    const p1 = { id: randomUUIDv7(), name: "株式会社A", honorific: "御中" as const, memo: null };
    const p2 = { id: randomUUIDv7(), name: "山田太郎", honorific: null, memo: "個人" };
    repo.insertPartner({ ...p1, isActive: true });
    repo.insertPartner({ ...p2, isActive: true });
    repo.updatePartner({ ...p2, honorific: "様", isActive: false });
    expect(repo.listPartners()).toEqual([
      { ...p1, isActive: true },
      { ...p2, honorific: "様", isActive: false },
    ]);
  });

  it("メモタグを追加・取得できる", () => {
    const t1 = { id: randomUUIDv7(), name: "出張" };
    const t2 = { id: randomUUIDv7(), name: "案件X" };
    repo.insertTag(t1);
    repo.insertTag(t2);
    expect(repo.listTags()).toEqual([t1, t2]);
  });

  it("税区分と税率はマイグレーションで投入された値（ドメインの正本と同じ）", () => {
    expect(repo.listTaxCategories()).toEqual(TAX_CATEGORIES);
    const key = (r: { categoryCode: string; effectiveFrom: string }) =>
      `${r.categoryCode}@${r.effectiveFrom}`;
    const sorted = <T extends { categoryCode: string; effectiveFrom: string }>(rows: T[]) =>
      rows.sort((a, b) => key(a).localeCompare(key(b)));
    expect(sorted(repo.listTaxRates())).toEqual(sorted([...TAX_RATES]));
  });

  it("消費税の設定を一括置換でき、一覧は effectiveFrom の順", () => {
    const later = {
      id: randomUUIDv7(),
      effectiveFrom: "2027-01-01",
      taxpayerStatus: "general" as const,
      accountingMethod: "tax_included" as const,
    };
    const first = {
      id: randomUUIDv7(),
      effectiveFrom: "2026-01-01",
      taxpayerStatus: "exempt" as const,
      accountingMethod: "tax_included" as const,
    };
    repo.replaceTaxSettings([later, first]);
    expect(repo.listTaxSettings()).toEqual([first, later]);
    repo.replaceTaxSettings([first]);
    expect(repo.listTaxSettings()).toEqual([first]);
  });

  it("会計期間を保存・取得でき、一覧は fiscalYear の順で、更新できる", () => {
    const p2027 = period(2027);
    const p2026 = period(2026);
    repo.insertFiscalPeriod(p2027);
    repo.insertFiscalPeriod(p2026);
    expect(repo.listFiscalPeriods()).toEqual([p2026, p2027]);
    expect(repo.getFiscalPeriodByYear(2027)).toEqual(p2027);
    expect(repo.getFiscalPeriodByYear(2025)).toBeUndefined();
    const closed = { ...p2026, status: "closed" as const, closedAt: "2027-03-01T00:00:00.000Z" };
    repo.updateFiscalPeriod(closed);
    expect(repo.getFiscalPeriodByYear(2026)).toEqual(closed);
  });

  describe("期首残高", () => {
    it("会計期間ごとに一括置換・取得できる", () => {
      const p2026 = period(2026);
      const p2027 = period(2027);
      repo.insertFiscalPeriod(p2026);
      repo.insertFiscalPeriod(p2027);
      const cash = account("asset");
      const capital = account("equity");
      repo.insertAccount(cash);
      repo.insertAccount(capital);
      const sub = { id: randomUUIDv7(), accountId: cash.id, name: "手元", isActive: true };
      repo.insertSubAccount(sub);

      const rows2026 = [
        balance(p2026.id, cash.id, "debit", 300_000, sub.id),
        balance(p2026.id, capital.id, "credit", 300_000),
      ];
      const rows2027 = [
        balance(p2027.id, cash.id, "debit", 500_000),
        balance(p2027.id, capital.id, "credit", 500_000),
      ];
      repo.replaceOpeningBalances(p2026.id, rows2026);
      repo.replaceOpeningBalances(p2027.id, rows2027);
      expect(repo.listOpeningBalances(p2026.id)).toEqual(rows2026);

      const replaced = [
        balance(p2026.id, cash.id, "debit", 999_999_999_999),
        balance(p2026.id, capital.id, "credit", 999_999_999_999),
      ];
      repo.replaceOpeningBalances(p2026.id, replaced);
      expect(repo.listOpeningBalances(p2026.id)).toEqual(replaced);
      expect(repo.listOpeningBalances(p2027.id)).toEqual(rows2027);
    });

    it("一括置換は1トランザクションで行われ、途中で失敗すると元の行が残る", () => {
      const p = period(2026);
      repo.insertFiscalPeriod(p);
      const cash = account("asset");
      const capital = account("equity");
      repo.insertAccount(cash);
      repo.insertAccount(capital);
      const original = [
        balance(p.id, cash.id, "debit", 1000),
        balance(p.id, capital.id, "credit", 1000),
      ];
      repo.replaceOpeningBalances(p.id, original);

      // 2行目は存在しない科目を参照するため、外部キーの制約で失敗する
      expect(() =>
        repo.replaceOpeningBalances(p.id, [
          balance(p.id, cash.id, "debit", 2000),
          balance(p.id, randomUUIDv7(), "credit", 2000),
        ]),
      ).toThrow();
      expect(repo.listOpeningBalances(p.id)).toEqual(original);
    });
  });

  describe("transaction", () => {
    it("トランザクション内のリポジトリで書いた内容がコミットされ、戻り値が返る", () => {
      const a = account("asset");
      const result = repo.transaction((tx) => {
        tx.insertAccount(a);
        return ok(tx.getAccount(a.id));
      });
      expect(result).toEqual(ok(a));
      expect(repo.getAccount(a.id)).toEqual(a);
    });

    it("例外が起きるとすべての書き込みがロールバックされる", () => {
      const a = account("asset");
      const p = period(2026);
      expect(() =>
        repo.transaction((tx) => {
          tx.insertAccount(a);
          tx.insertFiscalPeriod(p);
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(repo.getAccount(a.id)).toBeUndefined();
      expect(repo.listFiscalPeriods()).toEqual([]);
    });

    it("入れ子のトランザクションの失敗は、外側の例外としてまとめてロールバックされる", () => {
      const a = account("asset");
      const b = account("asset");
      expect(() =>
        repo.transaction((tx) => {
          tx.insertAccount(a);
          return tx.transaction((inner) => {
            inner.insertAccount(b);
            throw new Error("inner");
          });
        }),
      ).toThrow("inner");
      expect(repo.listAccounts()).toEqual([]);
    });
  });

  it("監査ログを追記できる", () => {
    const entry: AuditEntry = {
      id: randomUUIDv7(),
      occurredAt: "2026-10-18T00:00:00.000Z",
      targetType: "account",
      targetId: randomUUIDv7(),
      action: "rename",
      reason: null,
      beforeJson: JSON.stringify({ name: "旧" }),
      afterJson: JSON.stringify({ name: "新" }),
    };
    repo.appendAudit(entry);
    const rows = db.$client
      .prepare(
        "SELECT id, occurred_at AS occurredAt, target_type AS targetType, target_id AS targetId, action, reason, before_json AS beforeJson, after_json AS afterJson FROM audit_log",
      )
      .all();
    expect(rows).toEqual([entry]);
  });

  it("会計期間の audit_log（締め・解除）だけを記録の順で取得できる", () => {
    const entry = (
      targetType: AuditEntry["targetType"],
      action: AuditEntry["action"],
      occurredAt: string,
    ): AuditEntry => ({
      id: randomUUIDv7(),
      occurredAt,
      targetType,
      targetId: randomUUIDv7(),
      action,
      reason: action === "reopen" ? "修正申告" : null,
      beforeJson: null,
      afterJson: null,
    });
    // 日時の順と記録の順が異なっても、記録の順で返す
    const close = entry("fiscal_period", "close", "2027-03-15T00:00:00.000Z");
    const rename = entry("account", "rename", "2027-03-16T00:00:00.000Z");
    const reopen = entry("fiscal_period", "reopen", "2027-03-01T00:00:00.000Z");
    for (const e of [close, rename, reopen]) repo.appendAudit(e);
    expect(repo.fiscalPeriodHistory()).toEqual([close, reopen]);
  });
});

describe("DrizzleRegistryRepository", () => {
  it("事業体を登録・取得・名称変更でき、一覧は作成日時の順", () => {
    const registry = new DrizzleRegistryRepository(openRegistry());
    const later = {
      id: randomUUIDv7(),
      name: "法人",
      kind: "corporation" as const,
      createdAt: "2026-10-18T00:00:01.000Z",
      demo: false,
    };
    const first = {
      id: randomUUIDv7(),
      name: "個人",
      kind: "individual" as const,
      createdAt: "2026-10-18T00:00:00.000Z",
      demo: false,
    };
    registry.insertEntity(later);
    registry.insertEntity(first);
    expect(registry.listEntities()).toEqual([first, later]);

    registry.renameEntity(first.id, "個人（屋号）");
    expect(registry.listEntities()).toEqual([{ ...first, name: "個人（屋号）" }, later]);
  });

  it("DB ファイルは data ディレクトリからの相対パスで記録される", () => {
    const registryDb = openRegistry();
    const id = randomUUIDv7();
    new DrizzleRegistryRepository(registryDb).insertEntity({
      id,
      name: "個人",
      kind: "individual",
      createdAt: "2026-10-18T00:00:00.000Z",
      demo: false,
    });
    const row = registryDb.$client.prepare("SELECT db_file FROM entities WHERE id = ?").get(id);
    expect(row).toEqual({ db_file: `tenants/${id}.sqlite` });
  });
});

describe("createEntity と DB のリポジトリの結合", () => {
  it("事業体を作成すると、テナントの DB に初期データが入り、registry に登録される", () => {
    const registry = new DrizzleRegistryRepository(openRegistry());
    const result = createEntity(
      {
        registry,
        openTenant: (entityId) => new DrizzleMasterRepository(openTenant(entityId)),
        ids: testIds(),
        clock: testClock("2026-10-18T00:00:00.000Z"),
      },
      { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
    );
    if (!result.ok) throw new Error(result.error.message);
    const tenant = new DrizzleMasterRepository(openTenant(result.value.id));
    expect(tenant.getProfile()).toEqual(result.value);
    expect(tenant.listAccounts().map((a) => a.code)).toHaveLength(INDIVIDUAL_ACCOUNTS.length);
    expect(tenant.listFiscalPeriods()).toMatchObject([
      { fiscalYear: 2026, startDate: "2026-01-01", endDate: "2026-12-31", status: "open" },
    ]);
    expect(tenant.listTaxSettings()).toMatchObject([
      { effectiveFrom: "2026-01-01", taxpayerStatus: "exempt", accountingMethod: "tax_included" },
    ]);
    expect(registry.listEntities()).toEqual([
      {
        id: result.value.id,
        name: "個人事業",
        kind: "individual",
        createdAt: "2026-10-18T00:00:00.000Z",
        demo: false,
      },
    ]);
  });
});
