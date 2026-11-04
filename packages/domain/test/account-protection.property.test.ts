import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createEntity } from "../src/usecases/create-entity.ts";
import {
  addAccount,
  deleteAccount,
  type MasterDeps,
  renameAccount,
  setAccountActive,
  setAccountReportLine,
  updateAccount,
} from "../src/usecases/masters.ts";
import {
  FixedClock,
  fakeClosingUnitOfWork,
  InMemoryClosingStore,
  InMemoryLedgerRepository,
  InMemoryMasterRepository,
  InMemoryRegistry,
  SequentialIds,
} from "./fakes.ts";

/** INV-70: isSystem の科目は名前の変更と削除が ACCOUNT_SYSTEM_PROTECTED で拒まれ、拒まれた後の科目の表は変わらない */

function setup() {
  const repo = new InMemoryMasterRepository();
  const closing = new InMemoryClosingStore(new InMemoryLedgerRepository());
  const ids = new SequentialIds();
  const clock = new FixedClock("2026-10-18T00:00:00.000Z");
  const created = createEntity(
    { registry: new InMemoryRegistry(), openTenant: () => repo, ids, clock },
    { name: "個人事業", kind: "individual", fiscalStartMonth: 1, firstFiscalYear: 2026 },
  );
  if (!created.ok) throw new Error(created.error.message);
  const deps: MasterDeps & { closing: InMemoryClosingStore } = { repo, closing, ids, clock };
  const uowDeps = {
    uow: fakeClosingUnitOfWork(new InMemoryLedgerRepository(), repo, closing),
    ids,
    clock,
  };
  return { repo, deps, uowDeps };
}

type Op =
  | { kind: "rename"; index: number; name: string }
  | { kind: "delete"; index: number }
  | { kind: "patchName"; index: number; name: string }
  | { kind: "setActive"; index: number; active: boolean }
  | { kind: "reportLine"; index: number; line: number | null };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("rename" as const),
    index: fc.nat(200),
    name: fc.string({ minLength: 1, maxLength: 12 }),
  }),
  fc.record({ kind: fc.constant("delete" as const), index: fc.nat(200) }),
  fc.record({
    kind: fc.constant("patchName" as const),
    index: fc.nat(200),
    name: fc.string({ minLength: 1, maxLength: 12 }),
  }),
  fc.record({
    kind: fc.constant("setActive" as const),
    index: fc.nat(200),
    active: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("reportLine" as const),
    index: fc.nat(200),
    line: fc.option(fc.integer({ min: 8, max: 31 }), { nil: null }),
  }),
);

describe("INV-70 最初からある科目の保護", () => {
  it("isSystem の科目の名前の変更・削除は ACCOUNT_SYSTEM_PROTECTED で拒まれ、科目の表は変わらない", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 12 }), (ops) => {
        const { repo, deps, uowDeps } = setup();
        for (const op of ops) {
          const accounts = repo.listAccounts();
          const target = accounts[op.index % accounts.length];
          if (target === undefined) throw new Error("科目がない");
          const before = structuredClone(repo.state.accounts);
          const auditsBefore = repo.audits.length;
          const attempts =
            op.kind === "rename"
              ? [renameAccount(deps, target.id, op.name)]
              : op.kind === "delete"
                ? [deleteAccount(deps, target.id)]
                : op.kind === "patchName"
                  ? [updateAccount(uowDeps, target.id, { name: op.name, isActive: false })]
                  : op.kind === "setActive"
                    ? [setAccountActive(deps, target.id, op.active)]
                    : [setAccountReportLine(deps, target.id, op.line)];
          const protectedOp =
            target.isSystem &&
            (op.kind === "delete" ||
              ((op.kind === "rename" || op.kind === "patchName") &&
                op.name.trim() !== "" &&
                op.name.trim() !== target.name));
          for (const r of attempts) {
            if (protectedOp) {
              expect(r.ok).toBe(false);
              if (!r.ok) expect(r.error.code).toBe("ACCOUNT_SYSTEM_PROTECTED");
              expect(repo.state.accounts).toEqual(before);
              expect(repo.audits).toHaveLength(auditsBefore);
            } else if (!r.ok) {
              expect(r.error.code).not.toBe("ACCOUNT_SYSTEM_PROTECTED");
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("isSystem の科目でも使用停止・再開と reportLine の変更は通る", () => {
    const { repo, deps, uowDeps } = setup();
    const supplies = repo.listAccounts().find((a) => a.name === "消耗品費");
    if (supplies === undefined) throw new Error("消耗品費がない");
    expect(supplies.isSystem).toBe(true);
    expect(setAccountActive(deps, supplies.id, false).ok).toBe(true);
    expect(setAccountActive(deps, supplies.id, true).ok).toBe(true);
    expect(setAccountReportLine(deps, supplies.id, 31).ok).toBe(true);
    expect(updateAccount(uowDeps, supplies.id, { isActive: false, reportLine: 25 }).ok).toBe(true);
    expect(repo.getAccount(supplies.id)).toMatchObject({ isActive: false, reportLine: 25 });
    // 名前が変わらない PATCH（同じ名前を添える）は通る
    expect(updateAccount(uowDeps, supplies.id, { name: supplies.name, isActive: true }).ok).toBe(
      true,
    );
  });

  it("isSystem でない科目は今の規則のまま（名前の変更・未使用なら削除、使用中は ACCOUNT_IN_USE）", () => {
    const { repo, deps } = setup();
    const added = addAccount(deps, {
      name: "セミナー費",
      category: "expense",
      reportSection: "PL_EXPENSE",
      reportLine: 25,
    });
    if (!added.ok) throw new Error(added.error.message);
    expect(added.value.isSystem).toBe(false);
    expect(renameAccount(deps, added.value.id, "研修セミナー費").ok).toBe(true);
    expect(repo.getAccount(added.value.id)?.name).toBe("研修セミナー費");
    repo.usedAccountIds.add(added.value.id);
    const used = deleteAccount(deps, added.value.id);
    expect(used.ok).toBe(false);
    if (!used.ok) expect(used.error.code).toBe("ACCOUNT_IN_USE");
    repo.usedAccountIds.delete(added.value.id);
    expect(deleteAccount(deps, added.value.id).ok).toBe(true);
    expect(repo.getAccount(added.value.id)).toBeUndefined();
  });
});
