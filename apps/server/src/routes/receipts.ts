import {
  addReceipt,
  detectReceiptFormat,
  getReceipt,
  listReceipts,
  readReceiptFile,
  updateReceipt,
} from "@trebuchet/domain";
import {
  RECEIPT_MAX_BYTES,
  ReceiptCreateOptions,
  ReceiptFileParam,
  ReceiptParam,
  ReceiptQuery,
  ReceiptUpdateInput,
} from "@trebuchet/schema";
import { Hono } from "hono";
import { type ReceiptRuntime, type RouteOptions, receiptDeps } from "../deps.ts";
import { errorBody, fail, respond, validationError } from "../errors.ts";
import { isLocalHost, requestHost } from "../lib/origin.ts";
import { readJsonField, readUpload, uploadLimitFor } from "../lib/upload.ts";
import type { TenantEnv } from "../tenant.ts";
import { validate } from "../validator.ts";

/** RFC 5987 の `filename*` の値（`'()*` も符号化する） */
const encodeRfc5987 = (name: string): string =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `filename=` の代わり（ASCII の範囲に収める。引用符・バックスラッシュ・制御文字は `_`） */
const asciiFallback = (name: string): string => name.replace(/[^\x20-\x7e]|["\\]/g, "_");

const queryIssue = (name: string, message: string) => validationError([{ path: [name], message }]);

/**
 * `/api/entities/:entityId` の下の証憑（010。contracts/http-api.md §2）。
 * 画像の変換（`receipts.imageTool`）とファイルの置き場（`receipts.files`）は `createApp({ receipts })` で差し替えられる
 */
export function receiptRoutes({ clock, receipts }: RouteOptions & { receipts: ReceiptRuntime }) {
  const deps = (c: { var: TenantEnv["Variables"] }) =>
    receiptDeps(c.var.db, clock, c.var.entityId, receipts);

  return (
    new Hono<TenantEnv>()
      // 追加。multipart: file（20 MB まで）と options（JSON）。経路は要求の Host で決める（R10）
      .post("/receipts", uploadLimitFor(1, RECEIPT_MAX_BYTES), async (c) => {
        const upload = await readUpload(c, RECEIPT_MAX_BYTES);
        const options = await readJsonField(c, "options", ReceiptCreateOptions);
        const channel = isLocalHost(requestHost(c.req)) ? "local" : "remote";

        // 画素数・色は形式の判定の後に調べる（非同期。ここまでは何も書かない。R10）。
        // 形式が違うファイルは probe に渡さず、addReceipt が RECEIPT_FORMAT_UNSUPPORTED で返す
        const mediaType = detectReceiptFormat(upload.bytes);
        let probe = null;
        if (mediaType !== undefined) {
          const probed = await receipts.imageTool.probe(upload.bytes, mediaType);
          // 画素数の超過（VALIDATION、details.maxPixels）は 422（contracts/http-api.md §1）
          if (!probed.ok) return c.json(errorBody(probed.error), 422);
          probe = probed.value ?? null;
        }

        // addReceipt は同期の区間（await を挟まない）。ここから先に await を足さない
        const result = addReceipt(deps(c), {
          bytes: upload.bytes,
          originalName: upload.name,
          channel,
          options,
          probe,
        });
        return respond(c, result, (receipt) => c.json({ receipt }, 201));
      })
      .get("/receipts", validate("query", ReceiptQuery), (c) => {
        const result = listReceipts(deps(c), c.req.valid("query"));
        return respond(c, result, (page) => c.json(page, 200));
      })
      .get("/receipts/:receiptId", validate("param", ReceiptParam), (c) => {
        const result = getReceipt(deps(c), c.req.valid("param").receiptId);
        return respond(c, result, (receipt) => c.json({ receipt }, 200));
      })
      // 値の更新。US1 では未入力の値を埋める・メモを変えるだけ（入力済みの値の訂正は US5。D1）
      .patch(
        "/receipts/:receiptId",
        validate("param", ReceiptParam),
        validate("json", ReceiptUpdateInput),
        (c) => {
          const result = updateReceipt(
            deps(c),
            c.req.valid("param").receiptId,
            c.req.valid("json"),
          );
          return respond(c, result, (receipt) => c.json({ receipt }, 200));
        },
      )
      // ファイルの取り出し。variant=display（既定。HEIC は JPEG に変換）| original、download=1 で attachment。
      // 平文をブラウザのキャッシュに残さない（no-store。R9）
      .get("/receipts/:receiptId/files/:sha256", validate("param", ReceiptFileParam), async (c) => {
        const { receiptId, sha256 } = c.req.valid("param");
        const variant = c.req.query("variant") ?? "display";
        if (variant !== "display" && variant !== "original") {
          return fail(
            c,
            queryIssue("variant", "variant は original か display を指定してください"),
          );
        }
        const download = c.req.query("download");
        if (download !== undefined && download !== "0" && download !== "1") {
          return fail(c, queryIssue("download", "download は 0 か 1 を指定してください"));
        }

        const file = readReceiptFile(deps(c), receiptId, sha256);
        if (!file.ok) {
          return fail(
            c,
            file.error.code === "RECEIPT_FILE_UNREADABLE"
              ? { ...file.error, details: { sha256 } }
              : file.error,
          );
        }
        let { bytes, mediaType }: { bytes: Uint8Array; mediaType: string } = file.value;
        if (variant === "display") {
          const display = await receipts.imageTool.toDisplay(
            file.value.bytes,
            file.value.mediaType,
          );
          if (!display.ok) return fail(c, display.error);
          ({ bytes, mediaType } = display.value);
        }

        const name = file.value.originalName;
        return c.body(new Uint8Array(bytes), 200, {
          "Content-Type": mediaType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition":
            download === "1"
              ? `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`
              : "inline",
        });
      })
  );
}
