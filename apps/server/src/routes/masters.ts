import {
  accountNotFoundError,
  addAccount,
  addSubAccount,
  addTag,
  deleteAccount,
  replaceTaxSettings,
  updateAccount,
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
import { accountUpdateDeps, masterDeps, type RouteOptions } from "../deps.ts";
import { fail, respond } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** `/api/entities/:entityId` の下のマスタ（FR-004〜FR-010） */
export function masterRoutes({ clock }: RouteOptions) {
  return (
    new Hono<TenantEnv>()
      // ---- 勘定科目 ----
      .get("/accounts", (c) =>
        c.json({ accounts: masterDeps(c.var.db, clock).repo.listAccounts() }, 200),
      )
      .post("/accounts", validate("json", AccountCreate), (c) => {
        const result = addAccount(masterDeps(c.var.db, clock), c.req.valid("json"));
        return respond(c, result, (account) => c.json({ account }, 201));
      })
      .patch("/accounts/:accountId", validate("json", AccountPatch), (c) => {
        // 名称・使用停止・決算書の欄のうち複数を指定されたら、どれかが失敗したときに全部を取り消す
        const result = updateAccount(
          accountUpdateDeps(c.var.db, clock),
          c.req.param("accountId"),
          c.req.valid("json"),
        );
        return respond(c, result, (account) => c.json({ account }, 200));
      })
      .delete("/accounts/:accountId", (c) => {
        const result = deleteAccount(masterDeps(c.var.db, clock), c.req.param("accountId"));
        return respond(c, result, () => c.body(null, 204));
      })

      // ---- 補助科目 ----
      .get("/accounts/:accountId/sub-accounts", (c) => {
        const accountId = c.req.param("accountId");
        const { repo } = masterDeps(c.var.db, clock);
        if (repo.getAccount(accountId) === undefined)
          return fail(c, accountNotFoundError(accountId));
        return c.json({ subAccounts: repo.listSubAccounts(accountId) }, 200);
      })
      .post("/accounts/:accountId/sub-accounts", validate("json", SubAccountCreate), (c) => {
        const result = addSubAccount(
          masterDeps(c.var.db, clock),
          c.req.param("accountId"),
          c.req.valid("json").name,
        );
        return respond(c, result, (subAccount) => c.json({ subAccount }, 201));
      })

      // ---- 取引先 ----
      .get("/partners", (c) =>
        c.json({ partners: masterDeps(c.var.db, clock).repo.listPartners() }, 200),
      )
      .post("/partners", validate("json", PartnerInput), (c) => {
        const result = upsertPartner(masterDeps(c.var.db, clock), c.req.valid("json"));
        return respond(c, result, (partner) => c.json({ partner }, 201));
      })
      .patch("/partners/:partnerId", validate("json", PartnerInput), (c) => {
        const result = upsertPartner(
          masterDeps(c.var.db, clock),
          c.req.valid("json"),
          c.req.param("partnerId"),
        );
        return respond(c, result, (partner) => c.json({ partner }, 200));
      })

      // ---- メモタグ ----
      .get("/tags", (c) => c.json({ tags: masterDeps(c.var.db, clock).repo.listTags() }, 200))
      .post("/tags", validate("json", TagCreate), (c) => {
        const result = addTag(masterDeps(c.var.db, clock), c.req.valid("json").name);
        return respond(c, result, (tag) => c.json({ tag }, 201));
      })

      // ---- 税区分・消費税の設定 ----
      .get("/tax-categories", (c) => {
        const { repo } = masterDeps(c.var.db, clock);
        return c.json(
          { taxCategories: repo.listTaxCategories(), taxRates: repo.listTaxRates() },
          200,
        );
      })
      .get("/tax-settings", (c) =>
        c.json({ taxSettings: masterDeps(c.var.db, clock).repo.listTaxSettings() }, 200),
      )
      .put("/tax-settings", validate("json", TaxSettingsPut), (c) => {
        const result = replaceTaxSettings(masterDeps(c.var.db, clock), c.req.valid("json"));
        return respond(c, result, (taxSettings) => c.json({ taxSettings }, 200));
      })
  );
}
