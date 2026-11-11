import { randomUUIDv7 } from "node:crypto";
import type { IdGenerator } from "@trebuchet/domain";

/** R8: 主キーは UUIDv7 */
export const ids: IdGenerator = { next: () => randomUUIDv7() };
