import { createFileRoute } from "@tanstack/react-router";
import { BackupSettings } from "@/features/backup/BackupSettings";
import { InspectBackup } from "@/features/backup/InspectBackup";

export const Route = createFileRoute("/settings/backup")({
  component: BackupPage,
});

function BackupPage() {
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6">
      <h1 className="text-xl font-semibold">バックアップ</h1>
      <BackupSettings />
      <InspectBackup />
    </main>
  );
}
