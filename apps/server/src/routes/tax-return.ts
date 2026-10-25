import { existsSync } from "node:fs";
import {
  deleteFiledDocument,
  deleteTaxReturnMemo,
  listFiledDocuments,
  listTaxReturnMemos,
  saveFiledDocument,
  saveTaxReturnMemo,
} from "@trebuchet/domain";
import {
  FiledDocumentInput,
  FiledDocumentParam,
  FiscalYearParam,
  TaxReturnMemoInput,
  TaxReturnMemoParam,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { closingSettingsDeps, type RouteOptions } from "../deps.ts";
import { respond } from "../errors.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/**
 * ファイルがあるか（research R13）。ドメインは node:fs を使わないので、ここで確かめる。
 * 中身は読まない。パスがなければ false
 */
const fileExists = (filePath: string | null): boolean =>
  filePath !== null && filePath !== "" && existsSync(filePath);

/**
 * `/api/entities/:entityId` の下の申告の控えと提出書類の記録（003 US6。FR-033〜036）。個人の事業体だけ。
 * 決算書の計算には使わず、変更履歴（closing_audit_log）にも残さない
 */
export function taxReturnRoutes({ clock }: RouteOptions) {
  return new Hono<TenantEnv>()
    .get("/tax-return/:year/memos", validate("param", FiscalYearParam), (c) => {
      const result = listTaxReturnMemos(closingSettingsDeps(c.var.db, clock), {
        fiscalYear: c.req.valid("param").year,
      });
      return respond(c, result, (memos) =>
        c.json({ memos: memos.map((m) => ({ ...m, fileExists: fileExists(m.filePath) })) }, 200),
      );
    })
    .post(
      "/tax-return/:year/memos",
      validate("param", FiscalYearParam),
      validate("json", TaxReturnMemoInput),
      (c) => {
        const result = saveTaxReturnMemo(closingSettingsDeps(c.var.db, clock), {
          fiscalYear: c.req.valid("param").year,
          ...c.req.valid("json"),
        });
        return respond(c, result, (memo) =>
          c.json({ memo: { ...memo, fileExists: fileExists(memo.filePath) } }, 201),
        );
      },
    )
    .put(
      "/tax-return/:year/memos/:memoId",
      validate("param", TaxReturnMemoParam),
      validate("json", TaxReturnMemoInput),
      (c) => {
        const { year, memoId } = c.req.valid("param");
        const result = saveTaxReturnMemo(closingSettingsDeps(c.var.db, clock), {
          fiscalYear: year,
          id: memoId,
          ...c.req.valid("json"),
        });
        return respond(c, result, (memo) =>
          c.json({ memo: { ...memo, fileExists: fileExists(memo.filePath) } }, 200),
        );
      },
    )
    .delete("/tax-return/:year/memos/:memoId", validate("param", TaxReturnMemoParam), (c) => {
      const { year, memoId } = c.req.valid("param");
      const result = deleteTaxReturnMemo(closingSettingsDeps(c.var.db, clock), {
        fiscalYear: year,
        id: memoId,
      });
      return respond(c, result, () => c.body(null, 204));
    })
    .get("/tax-return/:year/documents", validate("param", FiscalYearParam), (c) => {
      const result = listFiledDocuments(closingSettingsDeps(c.var.db, clock), {
        fiscalYear: c.req.valid("param").year,
      });
      return respond(c, result, (documents) =>
        c.json(
          { documents: documents.map((d) => ({ ...d, fileExists: fileExists(d.filePath) })) },
          200,
        ),
      );
    })
    .post(
      "/tax-return/:year/documents",
      validate("param", FiscalYearParam),
      validate("json", FiledDocumentInput),
      (c) => {
        const result = saveFiledDocument(closingSettingsDeps(c.var.db, clock), {
          fiscalYear: c.req.valid("param").year,
          ...c.req.valid("json"),
        });
        return respond(c, result, (document) =>
          c.json({ document: { ...document, fileExists: fileExists(document.filePath) } }, 201),
        );
      },
    )
    .put(
      "/tax-return/:year/documents/:documentId",
      validate("param", FiledDocumentParam),
      validate("json", FiledDocumentInput),
      (c) => {
        const { year, documentId } = c.req.valid("param");
        const result = saveFiledDocument(closingSettingsDeps(c.var.db, clock), {
          fiscalYear: year,
          id: documentId,
          ...c.req.valid("json"),
        });
        return respond(c, result, (document) =>
          c.json({ document: { ...document, fileExists: fileExists(document.filePath) } }, 200),
        );
      },
    )
    .delete(
      "/tax-return/:year/documents/:documentId",
      validate("param", FiledDocumentParam),
      (c) => {
        const { year, documentId } = c.req.valid("param");
        const result = deleteFiledDocument(closingSettingsDeps(c.var.db, clock), {
          fiscalYear: year,
          id: documentId,
        });
        return respond(c, result, () => c.body(null, 204));
      },
    );
}
