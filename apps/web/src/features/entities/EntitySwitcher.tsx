import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { entitiesQuery, entityKeys } from "./api";

/** 最後に開いた事業体の ID を覚えるブラウザの鍵（011 R4） */
const LAST_ENTITY_KEY = "trebuchet:lastEntityId";

/** 切替の最後の項目「一覧・作成」の値（トップ画面 `/` へ移る）。事業体の ID と重ならない */
const LIST_VALUE = "__list__";

/**
 * 最後に開いた事業体の ID。一覧に残っているものだけ返す（消えた事業体の ID・一覧を読む前は undefined）。
 * ロゴ・トップ画面の一覧が使う
 */
export function lastEntityIdOf(
  entities: readonly { id: string }[] | undefined,
): string | undefined {
  const last = localStorage.getItem(LAST_ENTITY_KEY);
  return last !== null && entities?.some((e) => e.id === last) ? last : undefined;
}

/**
 * トップ画面（`/`）の beforeLoad から呼ぶ（011 FR-010）。事業体が 1 件ならその ID を返し（そのホームを開く）、
 * 0 件・2 件以上なら undefined（トップ画面が作成の案内・一覧を出す）
 */
export async function entityToRestore(queryClient: QueryClient): Promise<string | undefined> {
  try {
    const entities = await queryClient.ensureQueryData(entitiesQuery());
    if (entities.length === 1) return entities[0]?.id;
  } catch {
    // 一覧を読めなければ移動しない（トップ画面がエラーを表示する）
  }
  return undefined;
}

/** ヘッダーの事業体の切り替え（`#entity-switcher`）。開いている事業体を「最後に開いた事業体」として保存する */
export function EntitySwitcher() {
  const { entityId } = useParams({ strict: false });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: entities } = useQuery(entitiesQuery());
  const current = entities?.some((e) => e.id === entityId) ? entityId : undefined;

  useEffect(() => {
    if (current === undefined) return;
    localStorage.setItem(LAST_ENTITY_KEY, current);
    // 他の事業体のキャッシュを破棄する（キーは事業体ごとに分かれているが、古いデータを持ち越さない）
    queryClient.removeQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === entityKeys.all[0] && queryKey.length > 1 && queryKey[1] !== current,
    });
  }, [current, queryClient]);

  // 切り替える先があるとき（2 件以上）だけ出す
  if (entities === undefined || entities.length < 2) return null;

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
          if (next === LIST_VALUE) {
            void navigate({ to: "/" });
          } else if (next !== "" && next !== current) {
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
        <option value={LIST_VALUE}>一覧・作成</option>
      </NativeSelect>
    </div>
  );
}
