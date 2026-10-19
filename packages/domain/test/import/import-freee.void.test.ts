import { describe, expect, it } from "vitest";
import { closePeriod } from "../../src/usecases/close-period.ts";
import { previewFreeeImport, voidImportBatch } from "../../src/usecases/import-freee.ts";
import { voidJournal } from "../../src/usecases/void-journal.ts";
import {
  commitFixture,
  journalInput,
  NOW,
  setup,
  stateOf,
  type UsecaseSetup,
} from "./import-usecase-setup.ts";

/** 取り込んだ仕訳を、同じ内容のまま訂正する（version が上がる） */
function correct(s: UsecaseSetup, journalId: string) {
  const j = s.ledger.getJournal(journalId);
  if (j === undefined) throw new Error(journalId);
  const { id: _id, journalNo: _no, createdAt: _c, updatedAt: _u, version, status: _s, ...rest } = j;
  s.ledger.replaceJournal(journalId, rest, version, NOW);
}

describe("voidImportBatch（T054, FR-024〜027, INV-15）", () => {
  it("取込の回の仕訳をすべて理由つきで取り消し、参照を取消済み・取込の回を voided にする", () => {
    const s = setup();
    const { batch } = commitFixture(s);
    const subAccounts = structuredClone(s.masters.state.subAccounts);
    const mappings = structuredClone(s.uow.imports.state.accountMappings);

    const r = voidImportBatch(s, { batchId: batch.id, reason: "  取り込むファイルを間違えた  " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.voidedCount).toBe(14);
    expect(r.value.batch).toMatchObject({
      id: batch.id,
      status: "voided",
      voidedAt: NOW,
      voidReason: "取り込むファイルを間違えた",
    });

    const journals = s.uow.imports.journalsOfBatch(batch.id);
    expect(journals).toHaveLength(14);
    for (const { journal, ref } of journals) {
      expect(journal.status).toBe("voided");
      expect(journal.version).toBe(2);
      expect(ref.revokedAt).toBe(NOW);
    }
    // 001 の仕訳の取消と同じ形の監査ログ（仕訳ごと）
    const audits = s.ledger.state.audits.filter((a) => a.action === "void");
    expect(audits).toHaveLength(14);
    for (const a of audits) {
      expect(a).toMatchObject({
        occurredAt: NOW,
        targetType: "journal",
        reason: "取り込むファイルを間違えた",
      });
      expect(JSON.parse(a.beforeJson ?? "null")).toMatchObject({ status: "active", version: 1 });
      expect(JSON.parse(a.afterJson ?? "null")).toMatchObject({ status: "voided", version: 2 });
    }
    // 作った補助科目・対応表は残す（FR-027）
    expect(s.masters.state.subAccounts).toEqual(subAccounts);
    expect(s.uow.imports.state.accountMappings).toEqual(mappings);
  });

  it("取り消した後は、同じファイルをもう一度取り込める（参照が取り消されている）", () => {
    const s = setup();
    const { batch } = commitFixture(s);
    const voided = voidImportBatch(s, { batchId: batch.id, reason: "やり直す" });
    expect(voided.ok).toBe(true);
    const preview = previewFreeeImport(s, journalInput());
    expect(preview.ok ? preview.value.counts : undefined).toMatchObject({ new: 14, already: 0 });
    const again = commitFixture(s);
    expect(again.batch.status).toBe("active");
  });

  it("利用者が個別に取り消した仕訳は数えず、そのまま残す", () => {
    const s = setup();
    const { batch } = commitFixture(s);
    const first = s.uow.imports.journalsOfBatch(batch.id)[0]?.journal;
    if (first === undefined) throw new Error("no journal");
    const v = voidJournal(s, first.id, { reason: "個別に取消", version: first.version });
    expect(v.ok).toBe(true);

    const r = voidImportBatch(s, { batchId: batch.id, reason: "まとめて取消" });
    expect(r.ok ? r.value.voidedCount : undefined).toBe(13);
    const audits = s.ledger.state.audits.filter(
      (a) => a.action === "void" && a.targetId === first.id,
    );
    expect(audits.map((a) => a.reason)).toEqual(["個別に取消"]);
  });

  it("理由が空・長すぎる → REASON_REQUIRED。何も変えない", () => {
    const s = setup();
    const { batch } = commitFixture(s);
    const before = stateOf(s);
    for (const reason of ["", "   ", "あ".repeat(501)]) {
      const r = voidImportBatch(s, { batchId: batch.id, reason });
      expect(r.ok ? undefined : r.error).toMatchObject({
        code: "REASON_REQUIRED",
        details: { field: "reason" },
      });
    }
    expect(stateOf(s)).toEqual(before);
  });

  it("取込の回がない → IMPORT_BATCH_NOT_FOUND、取消済み → IMPORT_BATCH_VOIDED", () => {
    const s = setup();
    const missing = voidImportBatch(s, { batchId: "nope", reason: "x" });
    expect(missing.ok ? undefined : missing.error).toMatchObject({
      code: "IMPORT_BATCH_NOT_FOUND",
      details: { batchId: "nope" },
    });

    const { batch } = commitFixture(s);
    expect(voidImportBatch(s, { batchId: batch.id, reason: "1回目" }).ok).toBe(true);
    const before = stateOf(s);
    const twice = voidImportBatch(s, { batchId: batch.id, reason: "2回目" });
    expect(twice.ok ? undefined : twice.error).toMatchObject({
      code: "IMPORT_BATCH_VOIDED",
      details: { batchId: batch.id },
    });
    expect(stateOf(s)).toEqual(before);
  });

  it("締め済みの年度の仕訳を含む → PERIOD_CLOSED（締めの解除が必要）。何も変えない", () => {
    const s = setup();
    const { batch } = commitFixture(s);
    expect(closePeriod(s.masterDeps, 2025).ok).toBe(true);
    const before = stateOf(s);
    const r = voidImportBatch(s, { batchId: batch.id, reason: "取消" });
    expect(r.ok ? undefined : r.error).toMatchObject({
      code: "PERIOD_CLOSED",
      details: { fiscalYears: [2025] },
    });
    expect(stateOf(s)).toEqual(before);
  });

  it("取込の後に訂正された仕訳がある → CORRECTED_JOURNALS（件数と仕訳）。confirmCorrected で取り消せる", () => {
    const s = setup();
    const { batch } = commitFixture(s);
    const ids = s.uow.imports
      .journalsOfBatch(batch.id)
      .slice(0, 2)
      .map((x) => x.journal.id);
    for (const id of ids) correct(s, id);
    const before = stateOf(s);

    for (const confirmCorrected of [undefined, false]) {
      const r = voidImportBatch(s, { batchId: batch.id, reason: "取消", confirmCorrected });
      expect(r.ok ? undefined : r.error).toMatchObject({
        code: "CORRECTED_JOURNALS",
        details: { count: 2, journalIds: ids },
      });
    }
    expect(stateOf(s)).toEqual(before);

    const confirmed = voidImportBatch(s, {
      batchId: batch.id,
      reason: "取消",
      confirmCorrected: true,
    });
    expect(confirmed.ok ? confirmed.value.voidedCount : undefined).toBe(14);
    expect(s.ledger.getJournal(ids[0] ?? "")?.status).toBe("voided");
  });

  it("訂正の確認より締め済みの確認を先に行う", () => {
    const s = setup();
    const { batch } = commitFixture(s);
    const first = s.uow.imports.journalsOfBatch(batch.id)[0]?.journal.id ?? "";
    correct(s, first);
    expect(closePeriod(s.masterDeps, 2025).ok).toBe(true);
    const r = voidImportBatch(s, { batchId: batch.id, reason: "取消", confirmCorrected: false });
    expect(r.ok ? undefined : r.error.code).toBe("PERIOD_CLOSED");
  });
});
