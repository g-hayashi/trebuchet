import { useQuery } from "@tanstack/react-query";
import { entitiesQuery } from "./api";

/**
 * 事業体の一覧と、その中の現在の事業体（一覧の読み込み前、または一覧にないときは entity が undefined）。
 * entityId はヘッダーのように事業体の外の画面では undefined
 */
export function useEntity(entityId: string | undefined) {
  const { data: entities } = useQuery(entitiesQuery());
  return { entities, entity: entities?.find((e) => e.id === entityId) };
}
