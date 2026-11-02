import { createFileRoute } from "@tanstack/react-router";
import { RemoteSettingsForm } from "@/features/remote/RemoteSettingsForm";

export const Route = createFileRoute("/settings/remote")({
  component: RemoteSettingsPage,
});

function RemoteSettingsPage() {
  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6">
      <h1 className="text-xl font-semibold">リモート</h1>
      <RemoteSettingsForm />
    </main>
  );
}
