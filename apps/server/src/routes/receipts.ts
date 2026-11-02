import {
  addReceipt,
  createJournalFromReceipt,
  deleteReceipt,
  detectReceiptFormat,
  getReceipt,
  getReceiptHistory,
  linkReceipt,
  listJournalCandidates,
  listReceipts,
  ok,
  readReceipt,
  readReceiptFile,
  replaceReceiptFile,
  unlinkReceipt,
  updateReceipt,
} from "@trebuchet/domain";
import {
  RECEIPT_MAX_BYTES,
  ReceiptCreateOptions,
  ReceiptDeleteInput,
  ReceiptFileParam,
  ReceiptJournalInput,
  ReceiptLinkInput,
  ReceiptParam,
  ReceiptQuery,
  ReceiptReplaceOptions,
  ReceiptUnlinkInput,
  ReceiptUpdateInput,
} from "@trebuchet/schema";
import { Hono } from "hono";
import {
  type ReceiptRuntime,
  type RouteOptions,
  receiptDeps,
  receiptReadingDeps,
} from "../deps.ts";
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

  // 画素数・色は形式の判定の後に調べる（非同期。ここまでは何も書かない。R10）。
  // 形式が違うファイルは probe に渡さず、domain が RECEIPT_FORMAT_UNSUPPORTED で返す。
  // 画素数の超過（VALIDATION、details.maxPixels）は 422（contracts/http-api.md §1）
  const probeOf = async (bytes: Uint8Array) => {
    const mediaType = detectReceiptFormat(bytes);
    if (mediaType === undefined) return ok(null);
    const probed = await receipts.imageTool.probe(bytes, mediaType);
    return probed.ok ? ok(probed.value ?? null) : probed;
  };

  return (
    new Hono<TenantEnv>()
      // 追加。multipart: file（20 MB まで）と options（JSON）。経路は要求の Host で決める（R10）
      .post("/receipts", uploadLimitFor(1, RECEIPT_MAX_BYTES), async (c) => {
        const upload = await readUpload(c, RECEIPT_MAX_BYTES);
        const options = await readJsonField(c, "options", ReceiptCreateOptions);
        const channel = isLocalHost(requestHost(c.req)) ? "local" : "remote";

        const probed = await probeOf(upload.bytes);
        if (!probed.ok) return c.json(errorBody(probed.error), 422);

        // addReceipt は同期の区間（await を挟まない）。ここから先に await を足さない
        const result = addReceipt(deps(c), {
          bytes: upload.bytes,
          originalName: upload.name,
          channel,
          options,
          probe: probed.value,
        });
        return respond(c, result, (receipt) => c.json({ receipt }, 201));
      })
      // 外部の AI による読み取り（US4）。候補を返すだけで証憑の値は変えない（INV-67）。
      // 時間切れ・HTTP のエラー・形の不一致も 201 で記録の status・errorCode を返す。
      // 外部の AI か証憑の画像の送信が無効なら 422 AI_NOT_CONFIGURED（AI を呼ばない。INV-66）
      .post("/receipts/:receiptId/readings", validate("param", ReceiptParam), async (c) => {
        const result = await readReceipt(
          receiptReadingDeps(c.var.db, clock, c.var.entityId, receipts),
          c.req.valid("param").receiptId,
        );
        return respond(c, result, (reading) => c.json({ reading }, 201));
      })
      // ファイルの差し替え（撮り直し。版 +1、前の版も残る）。経路は追加と同じく Host で決める
      .post(
        "/receipts/:receiptId/files",
        validate("param", ReceiptParam),
        uploadLimitFor(1, RECEIPT_MAX_BYTES),
        async (c) => {
          const { receiptId } = c.req.valid("param");
          const upload = await readUpload(c, RECEIPT_MAX_BYTES);
          const options = await readJsonField(c, "options", ReceiptReplaceOptions);
          const channel = isLocalHost(requestHost(c.req)) ? "local" : "remote";

          const probed = await probeOf(upload.bytes);
          if (!probed.ok) return c.json(errorBody(probed.error), 422);

          // replaceReceiptFile は同期の区間（await を挟まない）
          const result = replaceReceiptFile(deps(c), receiptId, {
            bytes: upload.bytes,
            originalName: upload.name,
            channel,
            reason: options.reason,
            version: options.version,
            probe: probed.value,
          });
          return respond(c, result, (receipt) => c.json({ receipt }, 201));
        },
      )
      // 削除（DELETE ではなく POST。理由の本文を送る。001 の void と同じ形）
      .post(
        "/receipts/:receiptId/delete",
        validate("param", ReceiptParam),
        validate("json", ReceiptDeleteInput),
        (c) => {
          const result = deleteReceipt(
            deps(c),
            c.req.valid("param").receiptId,
            c.req.valid("json"),
          );
          return respond(c, result, (receipt) => c.json({ receipt }, 200));
        },
      )
      // 履歴（古い順。削除済みも引ける）
      .get("/receipts/:receiptId/history", validate("param", ReceiptParam), (c) => {
        const result = getReceiptHistory(deps(c), c.req.valid("param").receiptId);
        return respond(c, result, (history) => c.json({ history }, 200));
      })
      .get("/receipts", validate("query", ReceiptQuery), (c) => {
        const result = listReceipts(deps(c), c.req.valid("query"));
        return respond(c, result, (page) => c.json(page, 200));
      })
      .get("/receipts/:receiptId", validate("param", ReceiptParam), (c) => {
        const result = getReceipt(deps(c), c.req.valid("param").receiptId);
        return respond(c, result, (receipt) => c.json({ receipt }, 200));
      })
      // 値の更新。未入力の値を埋める・メモを変えるのは理由なし、入力済みの値の訂正は reason が要る（422 REASON_REQUIRED）
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
      // 結びつける仕訳の候補（取引年月日の前後。R6）
      .get("/receipts/:receiptId/journal-candidates", validate("param", ReceiptParam), (c) => {
        const result = listJournalCandidates(deps(c), c.req.valid("param").receiptId);
        return respond(c, result, (candidates) => c.json({ candidates }, 200));
      })
      // 仕訳に結びつける。付け替え（replace）は理由が要る（R5）
      .post(
        "/receipts/:receiptId/link",
        validate("param", ReceiptParam),
        validate("json", ReceiptLinkInput),
        (c) => {
          const result = linkReceipt(deps(c), c.req.valid("param").receiptId, c.req.valid("json"));
          return respond(c, result, (receipt) => c.json({ receipt }, 201));
        },
      )
      .post(
        "/receipts/:receiptId/unlink",
        validate("param", ReceiptParam),
        validate("json", ReceiptUnlinkInput),
        (c) => {
          const result = unlinkReceipt(
            deps(c),
            c.req.valid("param").receiptId,
            c.req.valid("json"),
          );
          // 有効な結びつきがない（domain は VALIDATION）は 422（contracts/http-api.md §3）。入力の形の違反は 400
          if (!result.ok && result.error.code === "VALIDATION") {
            return c.json(errorBody(result.error), 422);
          }
          return respond(c, result, (receipt) => c.json({ receipt }, 200));
        },
      )
      // 証憑から仕訳を登録して結びつける（1 つのトランザクション。FR-010）
      .post(
        "/receipts/:receiptId/journal",
        validate("param", ReceiptParam),
        validate("json", ReceiptJournalInput),
        (c) => {
          const input = c.req.valid("json");
          const result = createJournalFromReceipt(deps(c), c.req.valid("param").receiptId, {
            journal: input.journal,
            // 読み取りの候補との比べ（account_match・tax_match）を書く（FR-017、R14）
            readingId: input.readingId ?? undefined,
          });
          return respond(c, result, (value) => c.json(value, 201));
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
