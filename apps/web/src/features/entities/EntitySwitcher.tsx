import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { entitiesQuery, entityKeys } from "./api";

const LAST_ENTITY_KEY = "trebuchet:lastEntityId";
/** このタブで復元の機会を使ったか（トップ画面を表示した、または事業体の画面を開いた）。以降のトップ画面は一覧を見せる */
const RESTORED_KEY = "trebuchet:lastEntityRestored";

/** トップ画面の beforeLoad から呼ぶ。タブの最初の表示なら、前回の事業体（一覧に残っているもの）の ID を返す */
export async function entityToRestore(queryClient: QueryClient): Promise<string | undefined> {
  if (sessionStorage.getItem(RESTORED_KEY) !== null) return undefined;
  sessionStorage.setItem(RESTORED_KEY, "1");
  const last = localStorage.getItem(LAST_ENTITY_KEY);
  if (last === null) return undefined;
  try {
    const entities = await queryClient.ensureQueryData(entitiesQuery());
    if (entities.some((e) => e.id === last)) return last;
    localStorage.removeItem(LAST_ENTITY_KEY);
  } catch {
    // 一覧を読めなければ復元しない（トップ画面がエラーを表示する）
  }
  return undefined;
}

/** ヘッダーの事業体の切り替え（US6）。開いている事業体を「最後に選んだ事業体」として保存する */
export function EntitySwitcher() {
  const { entityId } = useParams({ strict: false });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: entities } = useQuery(entitiesQuery());
  const current = entities?.some((e) => e.id === entityId) ? entityId : undefined;

  useEffect(() => {
    if (current === undefined) return;
    localStorage.setItem(LAST_ENTITY_KEY, current);
    sessionStorage.setItem(RESTORED_KEY, "1");
    // 他の事業体のキャッシュを破棄する（キーは事業体ごとに分かれているが、古いデータを持ち越さない）
    queryClient.removeQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === entityKeys.all[0] && queryKey.length > 1 && queryKey[1] !== current,
    });
  }, [current, queryClient]);

  if (entities === undefined || entities.length === 0) return null;

  return (
    <div className="ml-auto flex items-center gap-2">
      <Label htmlFor="entity-switcher" className="text-muted-foreground">
        事業体
      </Label>
      <NativeSelect
        id="entity-switcher"
        className="h-8 w-56"
        value={current ?? ""}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next !== "" && next !== current) {
            void navigate({ to: "/e/$entityId", params: { entityId: next } });
          }
        }}
      >
        {current === undefined && (
          <option value="" disabled>
            選択してください
          </option>
        )}
        {entities.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
