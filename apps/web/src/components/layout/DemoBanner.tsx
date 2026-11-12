import { Link } from "@tanstack/react-router";
import { useEntity } from "@/features/entities/use-entity";

/**
 * デモの事業体（`demo: true`。014）の全画面の上部に出す帯（014/FR-008・009）。架空のデータであることと、
 * 試し終わったら一覧で非表示（アーカイブ）にして、完全に削除する案内。通常の事業体では出さない
 */
export function DemoBanner({ entityId }: { entityId: string }) {
  const { entity } = useEntity(entityId);
  if (entity?.demo !== true) return null;
  return (
    <div
      role="note"
      aria-label="デモ事業の案内"
      className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
    >
      <p className="font-medium">デモ用の架空のデータです</p>
      <p>
        <Link to="/list" className="underline underline-offset-4">
          試し終わったら削除
        </Link>
        （一覧で「非表示にする」→「非表示の組織」から完全に削除できます）
      </p>
    </div>
  );
}
