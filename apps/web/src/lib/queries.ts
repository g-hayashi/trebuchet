import type { QueryClient } from "@tanstack/react-query";
import { blueReturnKeys } from "@/features/blue-return/api";
import { homeKeys } from "@/features/home/api";
import { invoiceKeys } from "@/features/invoicing/api";
import { journalKeys } from "@/features/journals/api";
import { receiptKeys } from "@/features/receipts/api";
import { recurringKeys } from "@/features/recurring/api";
import { reportKeys } from "@/features/reports/api";
import { statementKeys } from "@/features/statements/api";

/**
 * 仕訳が変わったとき（登録・訂正・取消、請求・入金・定期仕訳・決算整理・明細の承認・証憑の結びつきによる登録）に、
 * 仕訳と、仕訳に依存する帳票・請求・定期仕訳・決算書・明細・証憑（状態は仕訳から導く）のクエリを読み直す。
 * キーの置き場は各 features/<機能>/api.ts。ここには機能をまたぐこの関数だけを置く
 */
export const invalidateLedger = (queryClient: QueryClient, entityId: string) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: journalKeys.all(entityId) }),
    queryClient.invalidateQueries({ queryKey: reportKeys.all(entityId) }),
    queryClient.invalidateQueries({ queryKey: invoiceKeys.invoices(entityId) }),
    queryClient.invalidateQueries({ queryKey: recurringKeys.all(entityId) }),
    queryClient.invalidateQueries({ queryKey: blueReturnKeys.all(entityId) }),
    queryClient.invalidateQueries({ queryKey: statementKeys.all(entityId) }),
    // 証憑の結びつきの状態（取消済みの仕訳など）は仕訳から導く。候補・詳細も読み直す（010）
    queryClient.invalidateQueries({ queryKey: receiptKeys.all(entityId) }),
    // ホームの件数・今期の数字・最近の仕訳（011）
    queryClient.invalidateQueries({ queryKey: homeKeys.all(entityId) }),
  ]);
