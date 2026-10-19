import { readFreeeFile } from "@trebuchet/domain";
import { Hono } from "hono";
import { fail } from "../errors.ts";
import { readUpload, sha256Hex, uploadLimit } from "../lib/upload.ts";
import type { TenantEnv } from "../tenant.ts";

/** `/api/entities/:entityId` の下の取込（002-freee-import、contracts/http-api.md） */
export const importRoutes = new Hono<TenantEnv>()
  .use("/imports/*", uploadLimit)
  .post("/imports/freee/preview", async (c) => {
    const upload = await readUpload(c);
    const read = readFreeeFile(upload.bytes);
    if (!read.ok) {
      return fail(c, {
        code: "IMPORT_UNKNOWN_FORMAT",
        message: "freee の仕訳帳として読めないファイルです",
        details: { expected: "journal", missingColumns: read.error.missingColumns },
      });
    }
    if (read.value.kind !== "journal") {
      return fail(c, {
        code: "IMPORT_WRONG_KIND",
        message: "仕訳帳ではなく総勘定元帳が選ばれています。freee の仕訳帳を選んでください",
        details: { expected: "journal", actual: read.value.kind },
      });
    }
    // 暫定の応答: ファイルの判別の結果だけを返す。US1 の T033 で { preview: ImportPreview } の本実装に置き換える
    return c.json(
      {
        file: {
          name: upload.name,
          sha256: sha256Hex(upload.bytes),
          kind: read.value.kind,
          encoding: read.value.encoding,
          rowCount: read.value.rows.length,
        },
      },
      200,
    );
  });
