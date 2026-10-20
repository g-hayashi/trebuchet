import {
  addAccount,
  addSubAccount,
  addTag,
  deleteAccount,
  domainError,
  renameAccount,
  replaceTaxSettings,
  setAccountActive,
  setAccountReportLine,
  upsertPartner,
} from "@trebuchet/domain";
import {
  AccountCreate,
  AccountPatch,
  PartnerInput,
  SubAccountCreate,
  TagCreate,
  TaxSettingsPut,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { masterClosingDeps, masterDeps } from "../deps.ts";
import { DomainException, fail, orThrow } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

const accountNotFound = (accountId: string) =>
  domainError("ACCOUNT_NOT_FOUND", "勘定科目が見つかりません", { accountId });

/** `/api/entities/:entityId` の下のマスタ（FR-004〜FR-010） */
export const masterRoutes = new Hono<TenantEnv>()
  // ---- 勘定科目 ----
  .get("/accounts", (c) => c.json({ accounts: masterDeps(c.var.db).repo.listAccounts() }, 200))
  .post("/accounts", validate("json", AccountCreate), (c) => {
    const result = addAccount(masterDeps(c.var.db), c.req.valid("json"));
    if (!result.ok) return fail(c, result.error);
    return c.json({ account: result.value }, 201);
  })
  .patch("/accounts/:accountId", validate("json", AccountPatch), (c) => {
    const accountId = c.req.param("accountId");
    const patch = c.req.valid("json");
    // 名称・使用停止・決算書の欄のうち複数を指定されたら、どれかが失敗したときに全部を取り消す。
    // マスタと ClosingStore（欄の変更の履歴）は同じトランザクションの接続で扱う
    const account = c.var.db.transaction((tx) => {
      const txDeps = masterClosingDeps(tx);
      let current = txDeps.repo.getAccount(accountId);
      if (current === undefined) throw new DomainException(accountNotFound(accountId));
      if (patch.name !== undefined) current = orThrow(renameAccount(txDeps, accountId, patch.name));
      if (patch.isActive !== undefined) {
        current = orThrow(setAccountActive(txDeps, accountId, patch.isActive));
      }
      if (patch.reportLine !== undefined) {
        current = orThrow(setAccountReportLine(txDeps, accountId, patch.reportLine));
      }
      return current;
    });
    return c.json({ account }, 200);
  })
  .delete("/accounts/:accountId", (c) => {
    const result = deleteAccount(masterDeps(c.var.db), c.req.param("accountId"));
    if (!result.ok) return fail(c, result.error);
    return c.body(null, 204);
  })

  // ---- 補助科目 ----
  .get("/accounts/:accountId/sub-accounts", (c) => {
    const accountId = c.req.param("accountId");
    const { repo } = masterDeps(c.var.db);
    if (repo.getAccount(accountId) === undefined) return fail(c, accountNotFound(accountId));
    return c.json({ subAccounts: repo.listSubAccounts(accountId) }, 200);
  })
  .post("/accounts/:accountId/sub-accounts", validate("json", SubAccountCreate), (c) => {
    const result = addSubAccount(
      masterDeps(c.var.db),
      c.req.param("accountId"),
      c.req.valid("json").name,
    );
    if (!result.ok) return fail(c, result.error);
    return c.json({ subAccount: result.value }, 201);
  })

  // ---- 取引先 ----
  .get("/partners", (c) => c.json({ partners: masterDeps(c.var.db).repo.listPartners() }, 200))
  .post("/partners", validate("json", PartnerInput), (c) => {
    const result = upsertPartner(masterDeps(c.var.db), c.req.valid("json"));
    if (!result.ok) return fail(c, result.error);
    return c.json({ partner: result.value }, 201);
  })
  .patch("/partners/:partnerId", validate("json", PartnerInput), (c) => {
    const result = upsertPartner(
      masterDeps(c.var.db),
      c.req.valid("json"),
      c.req.param("partnerId"),
    );
    if (!result.ok) return fail(c, result.error);
    return c.json({ partner: result.value }, 200);
  })

  // ---- メモタグ ----
  .get("/tags", (c) => c.json({ tags: masterDeps(c.var.db).repo.listTags() }, 200))
  .post("/tags", validate("json", TagCreate), (c) => {
    const result = addTag(masterDeps(c.var.db), c.req.valid("json").name);
    if (!result.ok) return fail(c, result.error);
    return c.json({ tag: result.value }, 201);
  })

  // ---- 税区分・消費税の設定 ----
  .get("/tax-categories", (c) => {
    const { repo } = masterDeps(c.var.db);
    return c.json({ taxCategories: repo.listTaxCategories(), taxRates: repo.listTaxRates() }, 200);
  })
  .get("/tax-settings", (c) =>
    c.json({ taxSettings: masterDeps(c.var.db).repo.listTaxSettings() }, 200),
  )
  .put("/tax-settings", validate("json", TaxSettingsPut), (c) => {
    const result = replaceTaxSettings(masterDeps(c.var.db), c.req.valid("json"));
    if (!result.ok) return fail(c, result.error);
    return c.json({ taxSettings: result.value }, 200);
  });
