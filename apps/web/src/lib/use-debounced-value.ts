import { useEffect, useState } from "react";

/**
 * `value` が `delayMs` ミリ秒変わらなかったら、その値を返す。待つ間は前の値のまま。
 * 最初に返す値は `initial`（省略は `value`）
 */
export function useDebouncedValue<T>(value: T, delayMs: number, initial: T = value): T {
  const [debounced, setDebounced] = useState(initial);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
