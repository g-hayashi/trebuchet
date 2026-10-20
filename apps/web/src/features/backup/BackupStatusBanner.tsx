import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { backupStatusQuery } from "./api";
import { ALERT_MESSAGES } from "./labels";

/**
 * バックアップの知らせ（FR-020）。`GET /api/backup/status` の `alert` があるときだけ、全画面の上部に出す。
 * 状態を読めないとき（読み込み中・エラー）は、画面の邪魔をしないよう何も出さない
 */
export function BackupStatusBanner() {
  const { data } = useQuery(backupStatusQuery());
  if (!data?.alert) return null;
  return (
    <section
      aria-label="バックアップの知らせ"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
        <p className="flex-1">{ALERT_MESSAGES[data.alert.reason]}</p>
        <Link to="/settings/backup" className="underline underline-offset-4">
          バックアップの設定を開く
        </Link>
      </div>
    </section>
  );
}
