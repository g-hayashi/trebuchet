import { createFileRoute } from "@tanstack/react-router";
import { BackupHistory, BackupSettings } from "@/features/backup/BackupSettings";
import { InspectBackup } from "@/features/backup/InspectBackup";

export const Route = createFileRoute("/settings/backup")({
  component: BackupPage,
});

/** 状態（と置き場所の設定）→ 復元 → 履歴の順（011/FR-057） */
function BackupPage() {
  return (
    <main className="grid gap-6 px-4 py-6">
      <h1 className="text-xl font-semibold">バックアップ</h1>
      <BackupSettings />
      <InspectBackup />
      <BackupHistory />
    </main>
  );
}
