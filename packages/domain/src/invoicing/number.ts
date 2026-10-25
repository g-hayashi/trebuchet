/** 請求番号 = 発行日の `YYYYMMDD` + `-` + 通し番号（3 桁に 0 埋め。1000 以上は桁が増える。R6） */
export function formatInvoiceNo(issueDate: string, seq: number): string {
  return `${issueDate.replaceAll("-", "")}-${String(seq).padStart(3, "0")}`;
}
