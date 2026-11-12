import type { QueryClient } from "@tanstack/react-query";
import { expect } from "vitest";
import { blueReturnKeys } from "@/features/blue-return/api";
import { homeKeys } from "@/features/home/api";
import { reportKeys } from "@/features/reports/api";

const ledgerKeys = (entityId: string) => [
  [...reportKeys.all(entityId), "trial-balance", {}] as const,
  [...blueReturnKeys.all(entityId), "2026"] as const,
  [...homeKeys.all(entityId), "summary"] as const,
];

/** 帳票・決算書・ホームのキャッシュを 1 件ずつ入れておく（読み直されたかを調べるため。観測者はいない） */
export function seedLedgerQueries(queryClient: QueryClient, entityId = "e1") {
  for (const key of ledgerKeys(entityId)) queryClient.setQueryData(key, { seeded: true });
}

/** 入れておいた帳票・決算書・ホームのキャッシュが、古いと印を付けられている */
export function expectLedgerInvalidated(queryClient: QueryClient, entityId = "e1") {
  for (const key of ledgerKeys(entityId)) {
    expect(queryClient.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
  }
}
