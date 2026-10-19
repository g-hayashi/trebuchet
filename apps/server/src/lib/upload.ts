import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { DomainException, fail } from "../errors.ts";

/** 取込のファイルの上限（contracts/http-api.md、research R11） */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** multipart の境界・ヘッダと、`options` などの他のフィールドのための余裕 */
const MULTIPART_ALLOWANCE_BYTES = 64 * 1024;

const FILE_TOO_LARGE = {
  code: "FILE_TOO_LARGE",
  message: "ファイルが大きすぎます（上限 5 MB）",
  details: { maxBytes: MAX_UPLOAD_BYTES },
} as const;

/**
 * 要求のボディの大きさを制限する（413 FILE_TOO_LARGE）。
 * ボディには multipart の境界などが含まれるため少し余裕を持たせ、ファイルそのものの大きさは readUpload で確かめる
 */
export const uploadLimit: MiddlewareHandler = bodyLimit({
  maxSize: MAX_UPLOAD_BYTES + MULTIPART_ALLOWANCE_BYTES,
  onError: (c: Context) => fail(c, FILE_TOO_LARGE),
});

export type Upload = {
  /** 送られたファイル名 */
  name: string;
  bytes: Uint8Array;
};

/**
 * multipart/form-data のフィールド `file` を読む。
 * `file` がない・ファイルでない → 400 VALIDATION、5 MB を超える → 413 FILE_TOO_LARGE（DomainException を投げ、onError が応答にする）
 */
export async function readUpload(c: Context): Promise<Upload> {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    const message = "ファイルを選んでください";
    throw new DomainException({
      code: "VALIDATION",
      message,
      details: { issues: [{ path: ["file"], message }] },
    });
  }
  if (file.size > MAX_UPLOAD_BYTES) throw new DomainException(FILE_TOO_LARGE);
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** バイト列の SHA-256（小文字16進64文字。schema の Sha256） */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Issue = { path: readonly PropertyKey[]; message: string };

/** Zod のスキーマの safeParse（server は zod に直接依存しないため、形で受け取る） */
type SafeParser<T> = {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
};

function invalidField(name: string, issues: readonly Issue[]): DomainException {
  return new DomainException({
    code: "VALIDATION",
    message: "入力が正しくありません",
    details: {
      issues: issues.map((i) => ({ path: [name, ...i.path.map(String)], message: i.message })),
    },
  });
}

/**
 * multipart/form-data の JSON 文字列のフィールド（`options`・`expected`）を読み、スキーマで検証する。
 * フィールドがなければ fallback（JSON 文字列）を使う。fallback もなければ、JSON でない・スキーマに合わない
 * ときと同じく 400 VALIDATION（DomainException を投げる）。details.issues の path は [name, ...]
 */
export async function readJsonField<T>(
  c: Context,
  name: string,
  schema: SafeParser<T>,
  fallback?: string,
): Promise<T> {
  // parseBody の結果は要求ごとにキャッシュされる（readUpload と同じ本文を読む）
  const body = await c.req.parseBody();
  const raw = body[name] ?? fallback;
  if (typeof raw !== "string") {
    throw invalidField(name, [{ path: [], message: `${name} を JSON の文字列で指定してください` }]);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidField(name, [{ path: [], message: `${name} が JSON として読めません` }]);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidField(name, parsed.error.issues);
  return parsed.data;
}
