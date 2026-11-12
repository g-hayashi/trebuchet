import { useRouterState } from "@tanstack/react-router";
import { useIsMobile } from "@/lib/use-media-query";
import { isMobileRoute } from "./MobileNav";

/** スマホの幅で、スマホの対象（`MOBILE_ROUTES`）の外の画面に出す案内（011/FR-059。禁止はしない） */
export function PcRecommended() {
  const mobile = useIsMobile();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (!mobile || isMobileRoute(pathname)) return null;
  return (
    <p role="note" className="mb-4 rounded-md border bg-muted px-3 py-2 text-sm">
      PC での操作を推奨
    </p>
  );
}
