import { YEN_LIMIT } from "@trebuchet/schema";
import { type DomainError, domainError, err, ok, type Result } from "./types.ts";

export type Yen = number & { readonly __brand: "Yen" };

export function isYen(n: number): n is Yen {
  return Number.isSafeInteger(n) && n > 0 && n < YEN_LIMIT;
}

export function toYen(n: number): Result<Yen, DomainError> {
  if (isYen(n)) return ok(n);
  return err(
    domainError("VALIDATION", "金額は 1 円以上 1 兆円未満の整数で入力してください", { amount: n }),
  );
}

/**
 * 税込額に含まれる消費税額（INV-10）。円未満は切り捨て。
 * amount < 1e12, rate <= 10 のとき amount * rate < 2^53 のため、浮動小数の除算でも正確に切り捨てられる。
 */
export function computeInclusiveTax(amount: number, rate: number): number {
  return Math.floor((amount * rate) / (100 + rate));
}

export function sumYen(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  if (!Number.isSafeInteger(total)) {
    throw new RangeError("金額の合計が安全な整数の範囲を超えました");
  }
  return total;
}
