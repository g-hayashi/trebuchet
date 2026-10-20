import { beforeEach, describe, expect, it } from "vitest";
import { TAX_PARAMETERS } from "../../src/seed/tax-parameters.ts";
import {
  deleteFiledDocument,
  deleteTaxReturnMemo,
  getBlueReturn,
  listFiledDocuments,
  listTaxReturnMemos,
  saveFiledDocument,
  saveTaxReturnMemo,
} from "../../src/usecases/blue-return.ts";
import { FakeClosingUnitOfWork } from "../fakes.ts";
import { setupLedger } from "../ledger-fixture.ts";
import { InMemoryReportRepository } from "../reports/fake-report-repository.ts";

let fx: ReturnType<typeof setupLedger>;
let uow: FakeClosingUnitOfWork;

beforeEach(() => {
  fx = setupLedger();
  uow = new FakeClosingUnitOfWork(fx.ledger, fx.masters);
  uow.closing.taxParameters = [...TAX_PARAMETERS];
});

const deps = () => ({
  masters: fx.masters,
  closing: uow.closing,
  ids: fx.ids,
});
const readDeps = () => ({
  masters: fx.masters,
  closing: uow.closing,
  reports: new InMemoryReportRepository(fx.ledger, fx.masters),
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const corporate = () => {
  const profile = fx.masters.getProfile();
  if (profile === undefined) throw new Error("no profile");
  fx.masters.saveProfile({ ...profile, kind: "corporation" });
};

describe("控えの保存・一覧・削除（FR-033）", () => {
  it("登録すると ID を付け、年度ごとに一覧できる", () => {
    const memo = unwrap(
      saveTaxReturnMemo(deps(), {
        fiscalYear: 2025,
        kind: "salary",
        amount: 3_000_000,
        filePath: "/Users/me/docs/withholding.pdf",
        memo: "源泉徴収票",
      }),
    );
    expect(memo).toMatchObject({
      fiscalYear: 2025,
      kind: "salary",
      label: null,
      amount: 3_000_000,
      filePath: "/Users/me/docs/withholding.pdf",
      memo: "源泉徴収票",
    });
    expect(memo.id).toBeTruthy();
    expect(unwrap(listTaxReturnMemos(deps(), { fiscalYear: 2025 }))).toEqual([memo]);
    expect(unwrap(listTaxReturnMemos(deps(), { fiscalYear: 2024 }))).toEqual([]);
  });

  it("id を渡すと更新する", () => {
    const memo = unwrap(
      saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "donation", amount: 10_000 }),
    );
    const updated = unwrap(
      saveTaxReturnMemo(deps(), {
        fiscalYear: 2025,
        id: memo.id,
        kind: "donation",
        amount: 20_000,
      }),
    );
    expect(updated.id).toBe(memo.id);
    expect(unwrap(listTaxReturnMemos(deps(), { fiscalYear: 2025 }))).toEqual([updated]);
    expect(updated.amount).toBe(20_000);
  });

  it("存在しない id の更新・削除は VALIDATION", () => {
    const u = saveTaxReturnMemo(deps(), { fiscalYear: 2025, id: "nope", kind: "salary" });
    expect(!u.ok && u.error.code).toBe("VALIDATION");
    const d = deleteTaxReturnMemo(deps(), { fiscalYear: 2025, id: "nope" });
    expect(!d.ok && d.error.code).toBe("VALIDATION");
  });

  it("削除できる", () => {
    const memo = unwrap(saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "crypto" }));
    unwrap(deleteTaxReturnMemo(deps(), { fiscalYear: 2025, id: memo.id }));
    expect(unwrap(listTaxReturnMemos(deps(), { fiscalYear: 2025 }))).toEqual([]);
  });

  it("他の年度の控えは更新・削除できない", () => {
    const memo = unwrap(saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "crypto" }));
    const d = deleteTaxReturnMemo(deps(), { fiscalYear: 2024, id: memo.id });
    expect(!d.ok && d.error.code).toBe("VALIDATION");
  });

  it("「その他」は項目名が必須（空白だけも不可）", () => {
    const r = saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "other", label: " " });
    expect(!r.ok && r.error.code).toBe("VALIDATION");
    expect(saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "other", label: "寄附" }).ok).toBe(
      true,
    );
  });

  it("金額は 0 以上の整数、ファイルの場所は / 始まり", () => {
    const a = saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "salary", amount: -1 });
    expect(!a.ok && a.error.code).toBe("VALIDATION");
    const b = saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "salary", filePath: "a/b.pdf" });
    expect(!b.ok && b.error.code).toBe("VALIDATION");
  });

  it("法人の事業体は ENTITY_KIND_UNSUPPORTED（保存・一覧・削除とも）", () => {
    corporate();
    const s = saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "salary" });
    expect(!s.ok && s.error.code).toBe("ENTITY_KIND_UNSUPPORTED");
    const l = listTaxReturnMemos(deps(), { fiscalYear: 2025 });
    expect(!l.ok && l.error.code).toBe("ENTITY_KIND_UNSUPPORTED");
    const d = deleteTaxReturnMemo(deps(), { fiscalYear: 2025, id: "x" });
    expect(!d.ok && d.error.code).toBe("ENTITY_KIND_UNSUPPORTED");
  });
});

describe("提出書類の保存・一覧・削除（FR-035）", () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    fiscalYear: 2025,
    kind: "blue_return" as const,
    filePath: "/Users/me/docs/blue.pdf",
    filedOn: "2026-03-10",
    memo: "e-Tax で提出",
    ...over,
  });

  it("登録・一覧・更新・削除ができる", () => {
    const saved = unwrap(saveFiledDocument(deps(), doc()));
    expect(saved).toMatchObject({ kind: "blue_return", filedOn: "2026-03-10" });
    expect(unwrap(listFiledDocuments(deps(), { fiscalYear: 2025 }))).toEqual([saved]);
    const updated = unwrap(saveFiledDocument(deps(), doc({ id: saved.id, filedOn: null })));
    expect(updated).toMatchObject({ id: saved.id, filedOn: null });
    unwrap(deleteFiledDocument(deps(), { fiscalYear: 2025, id: saved.id }));
    expect(unwrap(listFiledDocuments(deps(), { fiscalYear: 2025 }))).toEqual([]);
  });

  it("存在しない id は VALIDATION、提出日の形が違うのも VALIDATION", () => {
    const u = saveFiledDocument(deps(), doc({ id: "nope" }));
    expect(!u.ok && u.error.code).toBe("VALIDATION");
    const d = deleteFiledDocument(deps(), { fiscalYear: 2025, id: "nope" });
    expect(!d.ok && d.error.code).toBe("VALIDATION");
    const f = saveFiledDocument(deps(), doc({ filedOn: "2026-13-40" }));
    expect(!f.ok && f.error.code).toBe("VALIDATION");
  });

  it("相対パスは VALIDATION", () => {
    const r = saveFiledDocument(deps(), doc({ filePath: "docs/blue.pdf" }));
    expect(!r.ok && r.error.code).toBe("VALIDATION");
  });

  it("法人の事業体は ENTITY_KIND_UNSUPPORTED", () => {
    corporate();
    const s = saveFiledDocument(deps(), doc());
    expect(!s.ok && s.error.code).toBe("ENTITY_KIND_UNSUPPORTED");
    const l = listFiledDocuments(deps(), { fiscalYear: 2025 });
    expect(!l.ok && l.error.code).toBe("ENTITY_KIND_UNSUPPORTED");
  });
});

describe("控え・書類は決算書の計算に使わず、履歴にも残さない（FR-034、data-model §1.10）", () => {
  it("控えと書類を足し・消しても getBlueReturn の値は変わらない", () => {
    const before = unwrap(getBlueReturn(readDeps(), { fiscalYear: 2025 }));
    const memo = unwrap(
      saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "salary", amount: 9_999_999 }),
    );
    const document = unwrap(
      saveFiledDocument(deps(), {
        fiscalYear: 2025,
        kind: "tax_return",
        filePath: "/x/y.pdf",
      }),
    );
    expect(unwrap(getBlueReturn(readDeps(), { fiscalYear: 2025 }))).toEqual(before);
    unwrap(deleteTaxReturnMemo(deps(), { fiscalYear: 2025, id: memo.id }));
    unwrap(deleteFiledDocument(deps(), { fiscalYear: 2025, id: document.id }));
    expect(unwrap(getBlueReturn(readDeps(), { fiscalYear: 2025 }))).toEqual(before);
  });

  it("closing_audit_log に何も残さない", () => {
    const memo = unwrap(saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "salary" }));
    const document = unwrap(
      saveFiledDocument(deps(), {
        fiscalYear: 2025,
        kind: "other",
        filePath: "/x/y.pdf",
      }),
    );
    unwrap(deleteTaxReturnMemo(deps(), { fiscalYear: 2025, id: memo.id }));
    unwrap(deleteFiledDocument(deps(), { fiscalYear: 2025, id: document.id }));
    expect(uow.closing.audits).toEqual([]);
  });

  it("締め済みの年度でも保存できる", () => {
    fx.closeYear(2025);
    expect(saveTaxReturnMemo(deps(), { fiscalYear: 2025, kind: "salary" }).ok).toBe(true);
  });
});
