import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SignOutButton } from "@/features/auth/SignOutButton";
import { EntitySwitcher } from "@/features/entities/EntitySwitcher";
import type { FileRouteTypes } from "@/routeTree.gen";
import { mobileNavItems } from "./EntityNav";

/**
 * スマホのメニューに出し、PC の推奨を出さない画面（011 contracts/ui-shell.md §4、011/FR-058）。
 * `$名前` は 1 区間（`new` は別の画面なので当たらない）、末尾の `*` はその下のすべて（なくてもよい）
 */
export const MOBILE_ROUTES = [
  "/",
  "/e/$entityId",
  "/e/$entityId/receipts",
  "/e/$entityId/receipts/new",
  "/e/$entityId/receipts/$receiptId",
  "/e/$entityId/journals",
  "/e/$entityId/journals/$journalId",
  "/e/$entityId/reports/*",
  "/settings/*",
] as const satisfies readonly (FileRouteTypes["to"] | `${string}/*`)[];

const segmentsOf = (path: string) => path.split("/").filter((s) => s !== "");

function matchesPattern(pattern: string, segments: readonly string[]): boolean {
  const parts = segmentsOf(pattern);
  const last = parts[parts.length - 1];
  const wildcard = last === "*";
  const fixed = wildcard ? parts.slice(0, -1) : parts;
  if (wildcard ? segments.length < fixed.length : segments.length !== fixed.length) return false;
  return fixed.every((part, i) => {
    const segment = segments[i];
    return part.startsWith("$") ? segment !== undefined && segment !== "new" : part === segment;
  });
}

/** パス名が `MOBILE_ROUTES`（スマホの対象）に当たるか */
export function isMobileRoute(pathname: string): boolean {
  const segments = segmentsOf(pathname);
  return MOBILE_ROUTES.some((pattern) => matchesPattern(pattern, segments));
}

/**
 * スマホの幅のヘッダーのメニュー（011/FR-059）。ボタン「メニュー」で `Sheet` を開く。
 * 事業体の切替（`EntitySwitcher`）をメニューの先頭に置く。
 * 事業体の項目は `EntityNav` の `mobile` を持つものだけ（`entityId` がなければ出さない）。
 * 設定と「施錠してサインアウト」はいつも出す
 */
export function MobileNav({ entityId }: { entityId: string | undefined }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="ml-auto">
          メニュー
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>メニュー</SheetTitle>
          <SheetDescription className="sr-only">
            画面を選ぶ、設定を開く、サインアウトする
          </SheetDescription>
        </SheetHeader>
        <EntitySwitcher onSelect={close} />
        <nav aria-label="スマホのメニュー" className="flex flex-col gap-3">
          {entityId !== undefined &&
            mobileNavItems().map((item) => (
              <Link
                key={item.to}
                to={item.to}
                params={{ entityId }}
                activeOptions={{ exact: true }}
                onClick={close}
                className="py-1"
              >
                {item.label}
              </Link>
            ))}
          <Link to="/settings/security" onClick={close} className="py-1">
            設定
          </Link>
        </nav>
        <div>
          <SignOutButton />
        </div>
      </SheetContent>
    </Sheet>
  );
}
