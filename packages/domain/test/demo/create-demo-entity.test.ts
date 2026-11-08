import { describe, expect, it } from "vitest";
import { buildDemoPlan } from "../../src/demo/plan.ts";
import { cleanupPreparingEntities, createDemoEntity } from "../../src/usecases/demo-entity.ts";
import { type DemoSetup, setupDemo } from "./demo-setup.ts";

const TODAY = "2026-11-08";

const created = (s: DemoSetup, today = TODAY) => {
  const result = createDemoEntity(s.deps, { today });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe("createDemoEntity（成功時。US1）", () => {
  it("demo: true の active な事業体を 1 つ作り、activateEntity を 1 回呼ぶ", () => {
    const s = setupDemo();
    const entity = created(s);
    expect(entity).toMatchObject({ name: "デモ事業（サンプル）", kind: "individual", demo: true });
    expect(s.registry.listEntities()).toEqual([entity]);
    expect(s.registry.listPreparingEntities()).toEqual([]);
    expect(s.activated).toEqual([entity.id]);
    expect(s.purged).toEqual([]);
    expect(s.masters.state.profile?.fiscalStartMonth).toBe(1);
  });

  it("投入の間は、事業体は一覧に出ない（preparing）", () => {
    const s = setupDemo();
    created(s);
    expect(s.tenantCalls).toHaveLength(1);
    expect(s.visibleWhilePreparing).toEqual([0]);
  });

  it("計画の件数のとおりに、マスタ・仕訳・資産・請求・証憑・明細が入る", () => {
    const s = setupDemo();
    created(s);
    const plan = buildDemoPlan(TODAY);

    // マスタ
    expect(s.masters.state.subAccounts.map((x) => x.name).sort()).toEqual(
      plan.subAccounts.map((x) => x.name).sort(),
    );
    expect(s.masters.state.partners).toHaveLength(plan.partners.length);
    expect(s.masters.state.openingBalances).toHaveLength(plan.openingBalances.length);
    expect(s.masters.state.periods.map((p) => p.fiscalYear)).toEqual([plan.fiscalYear]);

    // 仕訳: 登録 + 請求・入金・定期仕訳の分。訂正は version 2、取消は voided
    const journals = s.ledger.state.journals;
    const bySource = (source: string) => journals.filter((j) => j.source === source);
    expect(bySource("manual")).toHaveLength(plan.journals.length);
    expect(bySource("invoice")).toHaveLength(plan.invoicing.invoices.length);
    expect(bySource("payment")).toHaveLength(
      plan.invoicing.invoices.filter((i) => i.payment !== undefined).length,
    );
    expect(bySource("recurring").length).toBeGreaterThan(0);
    expect(journals.filter((j) => j.status === "voided")).toHaveLength(plan.voids.length);
    expect(journals.filter((j) => j.version === 2 && j.status === "active")).toHaveLength(
      plan.corrections.length,
    );
    // すべての仕訳は貸借一致
    for (const j of journals) {
      const sum = (side: string) =>
        j.lines.filter((l) => l.side === side).reduce((a, l) => a + l.amount, 0);
      expect(sum("debit")).toBe(sum("credit"));
    }

    // 決算の設定・資産
    expect(s.closing.state.homeUseAllocations).toHaveLength(plan.homeUse.length);
    expect(s.closing.state.fixedAssets.map((a) => a.method).sort()).toEqual([
      "lump_sum",
      "small_asset_28_2",
      "straight_line",
    ]);
    expect(s.closing.state.deferredAssets).toHaveLength(1);

    // 定期仕訳・請求書
    expect(s.recurring.state.defs).toHaveLength(1);
    expect(s.recurring.state.runs.length).toBeGreaterThan(0);
    const invoices = s.invoicing.state.invoices;
    expect(invoices).toHaveLength(2);
    expect(s.invoicing.state.payments).toHaveLength(1);
    const paid = s.invoicing.state.payments[0];
    const paidInvoice = invoices.find((i) => i.id === paid?.invoiceId);
    expect(paidInvoice?.withholdingTax).toBeGreaterThan(0);
    expect(s.invoicing.state.workHours).toHaveLength(plan.invoicing.workHours.length);

    // 証憑は仕訳に結びつく。明細は未処理のまま
    expect(s.receipts.state.receipts).toHaveLength(plan.receipts.length);
    expect(s.receipts.state.links).toHaveLength(plan.receipts.length);
    expect(s.files.files.size).toBe(plan.receipts.length);
    expect(s.statements.state.statements).toHaveLength(10);
    expect(s.statements.state.links).toEqual([]);
    expect(s.statements.state.batches).toHaveLength(1);
    expect(s.statements.state.sources).toHaveLength(1);
  });

  it("証憑の画像の寸法（assets.receiptProbe）が証憑のファイルに保存される。null なら寸法なし", () => {
    const s = setupDemo();
    created(s);
    const plan = buildDemoPlan(TODAY);
    const files = s.receipts.state.files;
    expect(files).toHaveLength(plan.receipts.length);
    const dims = files.map((f) => `${f.originalName}:${f.width}x${f.height}:${f.fullColor}`);
    for (const rc of plan.receipts) {
      const size =
        rc.asset === "receipt-05"
          ? "nullxnull:null"
          : `${rc.asset === "receipt-06" ? 600 : 800}x400:true`;
      expect(dims, rc.asset).toContain(`${rc.originalName}:${size}`);
    }
  });

  it("作成日が 1 月なら前の年度で作り、請求書の日付も前の年に収まる", () => {
    const s = setupDemo({ now: "2027-01-20T03:00:00.000Z" });
    created(s, "2027-01-20");
    expect(s.masters.state.periods.map((p) => p.fiscalYear)).toEqual([2026]);
    for (const j of s.ledger.state.journals) expect(j.date.startsWith("2026-")).toBe(true);
  });

  it("作成日が 3 月 1 日でも成功する（年度は今年で、日付は作成日以下）", () => {
    const s = setupDemo({ now: "2027-03-01T03:00:00.000Z" });
    created(s, "2027-03-01");
    expect(s.masters.state.periods.map((p) => p.fiscalYear)).toEqual([2027]);
    for (const j of s.ledger.state.journals) {
      expect(j.date.startsWith("2027-")).toBe(true);
      expect(j.date <= "2027-03-01").toBe(true);
    }
  });
});

describe("createDemoEntity（作れない・名前）", () => {
  it("active な事業体があれば DEMO_NOT_AVAILABLE。何も作らない", () => {
    const s = setupDemo();
    s.registry.insertEntity({
      id: "existing",
      name: "本業",
      kind: "individual",
      createdAt: "2026-01-01T00:00:00.000Z",
      demo: false,
    });
    const result = createDemoEntity(s.deps, { today: TODAY });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DEMO_NOT_AVAILABLE");
    expect(s.tenantFiles.size).toBe(0);
    expect(s.tenantCalls).toEqual([]);
    expect(s.purged).toEqual([]);
    expect(s.registry.listEntities()).toHaveLength(1);
  });

  it("preparing が残っていても DEMO_NOT_AVAILABLE（その行は消さない）", () => {
    const s = setupDemo();
    s.registry.insertEntity({
      id: "leftover",
      name: "作りかけ",
      kind: "individual",
      createdAt: "2026-01-01T00:00:00.000Z",
      demo: true,
      status: "preparing",
    });
    const result = createDemoEntity(s.deps, { today: TODAY });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DEMO_NOT_AVAILABLE");
    expect(s.purged).toEqual([]);
    expect(s.registry.listPreparingEntities()).toHaveLength(1);
  });

  it("アーカイブ済みのデモが残っていれば、名前が重ならないように作る", () => {
    const s = setupDemo({
      archived: [
        {
          id: "old",
          name: "デモ事業（サンプル）",
          kind: "individual",
          createdAt: "2025-01-01T00:00:00.000Z",
          demo: true,
        },
      ],
    });
    expect(created(s).name).toBe("デモ事業（サンプル 2）");
  });
});

describe("createDemoEntity の失敗（US1。INV-77 の例）", () => {
  it("ユースケースが err を返したら、事業体ごと消して DEMO_FAILED（原因の符号だけを details に）", () => {
    const s = setupDemo({ fault: { at: 3, mode: "err" } });
    const result = createDemoEntity(s.deps, { today: TODAY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DEMO_FAILED");
    expect(result.error.details).toMatchObject({ cause: "VALIDATION" });
    expect(s.purged).toHaveLength(1);
    expect(s.tenantFiles.size).toBe(0);
    expect(s.registry.listEntities()).toEqual([]);
    expect(s.registry.listPreparingEntities()).toEqual([]);
  });

  it("例外でも同じ（再び投げない）", () => {
    const s = setupDemo({ fault: { at: 10, mode: "throw" } });
    const result = createDemoEntity(s.deps, { today: TODAY });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DEMO_FAILED");
    expect(s.purged).toHaveLength(1);
    expect(s.registry.listPreparingEntities()).toEqual([]);
  });

  it("証憑のファイルを書いた後の失敗でも、ファイルは残らない", () => {
    const clean = setupDemo();
    created(clean);
    // 最後のユースケース（明細の取込）の直前までは成功させ、明細で失敗させる
    const s = setupDemo({ fault: { at: clean.counter.n - 1, mode: "err" } });
    const result = createDemoEntity(s.deps, { today: TODAY });
    expect(result.ok).toBe(false);
    expect(s.files.files.size).toBe(0);
    expect(s.registry.listEntities()).toEqual([]);
  });

  it("後片づけも失敗したら DEMO_FAILED のまま（details.cleanup = failed）。起動時の後始末が消す", () => {
    const s = setupDemo({ fault: { at: 2, mode: "err" }, failOnPurge: true });
    const result = createDemoEntity(s.deps, { today: TODAY });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DEMO_FAILED");
    expect(result.error.details).toMatchObject({ cleanup: "failed" });
    expect(s.registry.listPreparingEntities()).toHaveLength(1);
  });

  it("作成日が範囲外（2000 年より前の年度）なら、作らずに DEMO_FAILED", () => {
    const s = setupDemo();
    const result = createDemoEntity(s.deps, { today: "2000-01-15" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DEMO_FAILED");
    expect(s.registry.listEntities()).toEqual([]);
    expect(s.registry.listPreparingEntities()).toEqual([]);
    expect(s.tenantFiles.size).toBe(0);
  });
});

describe("cleanupPreparingEntities（起動時の後始末。R2）", () => {
  it("preparing の事業体を消し、active は触らない", () => {
    const s = setupDemo();
    const base = { kind: "individual" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    s.registry.insertEntity({ id: "a", name: "A", demo: true, ...base, status: "preparing" });
    s.registry.insertEntity({ id: "b", name: "B", demo: false, ...base });
    s.registry.insertEntity({ id: "c", name: "C", demo: true, ...base, status: "preparing" });
    s.tenantFiles.add("a");
    s.tenantFiles.add("c");
    const result = cleanupPreparingEntities(s.deps);
    expect(result).toEqual({ purged: 2, failed: 0 });
    expect(s.purged.sort()).toEqual(["a", "c"]);
    expect(s.registry.listPreparingEntities()).toEqual([]);
    expect(s.registry.listEntities().map((e) => e.id)).toEqual(["b"]);
  });

  it("1 件の削除が失敗しても、残りを続ける", () => {
    const s = setupDemo({ failOnPurge: true });
    const base = { kind: "individual" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    s.registry.insertEntity({ id: "a", name: "A", demo: true, ...base, status: "preparing" });
    s.registry.insertEntity({ id: "c", name: "C", demo: true, ...base, status: "preparing" });
    expect(cleanupPreparingEntities(s.deps)).toEqual({ purged: 0, failed: 2 });
    expect(s.purged).toHaveLength(2);
  });

  it("preparing がなければ何もしない", () => {
    const s = setupDemo();
    expect(cleanupPreparingEntities(s.deps)).toEqual({ purged: 0, failed: 0 });
    expect(s.purged).toEqual([]);
  });
});
