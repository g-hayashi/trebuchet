import { Link, useParams } from "@tanstack/react-router";
import { SignOutButton } from "@/features/auth/SignOutButton";
import {
  EntitySwitcher,
  lastEntityIdOf,
  useRememberEntity,
} from "@/features/entities/EntitySwitcher";
import { useEntity } from "@/features/entities/use-entity";
import { useIsMobile } from "@/lib/use-media-query";
import { MobileNav } from "./MobileNav";

const LINK_CLASS = "underline-offset-4 hover:underline";

/**
 * 全画面のヘッダー（011 contracts/ui-shell.md §1）。解錠している間だけ描く（AuthGate の中に置く。
 * 施錠中・未サインインは解錠の画面だけで、右の 2 つは出さない）。
 * ロゴと事業体の名前は、最後に開いた事業体のホームへ（なければ `/`）。右は「設定」と「施錠してサインアウト」だけ
 */
export function AppHeader() {
  const { entityId } = useParams({ strict: false });
  const { entities, entity } = useEntity(entityId);
  const homeId = entity?.id ?? lastEntityIdOf(entities);
  const mobile = useIsMobile();
  useRememberEntity();
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex min-h-12 max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-1">
        {homeId === undefined ? (
          <Link to="/" className="font-semibold">
            Trebuchet
          </Link>
        ) : (
          <Link to="/e/$entityId" params={{ entityId: homeId }} className="font-semibold">
            Trebuchet
          </Link>
        )}
        {entity && (
          <Link
            to="/e/$entityId"
            params={{ entityId: entity.id }}
            className={`text-sm ${LINK_CLASS}`}
          >
            {entity.name}
          </Link>
        )}
        {mobile ? (
          // スマホの幅: ロゴ・事業体の名前・メニューのボタンだけ（設定と施錠はメニューの中。011/FR-059）
          <MobileNav entityId={homeId} />
        ) : (
          <>
            <div className="flex flex-1 items-center gap-4">
              <EntitySwitcher />
            </div>
            <Link to="/settings/security" className={`text-sm ${LINK_CLASS}`}>
              設定
            </Link>
            <SignOutButton />
          </>
        )}
      </div>
    </header>
  );
}
