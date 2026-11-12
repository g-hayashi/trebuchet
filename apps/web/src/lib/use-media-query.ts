import { useSyncExternalStore } from "react";

/** スマホの幅（Tailwind の `md`（768 px）未満。011 contracts/ui-shell.md §4） */
export const MOBILE_QUERY = "(max-width: 767px)";

/**
 * メディアクエリに当たっているか。画面の幅が変わると描き直す。
 * `matchMedia` がない環境（jsdom など）では、当たらない（= PC の幅）として扱う
 */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

/** スマホの幅か（`useMediaQuery(MOBILE_QUERY)`） */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
