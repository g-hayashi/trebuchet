import { createFileRoute } from "@tanstack/react-router";
import { PairingSection } from "@/features/remote/PairingSection";
import { RemoteSettingsForm } from "@/features/remote/RemoteSettingsForm";
import { TailscaleCard } from "@/features/remote/TailscaleCard";

export const Route = createFileRoute("/settings/remote")({
  component: RemoteSettingsPage,
});

function RemoteSettingsPage() {
  return (
    <main className="grid gap-6 px-4 py-6">
      <h1 className="text-xl font-semibold">リモート</h1>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <TailscaleCard />
        <RemoteSettingsForm />
        <div className="lg:col-span-2">
          <PairingSection />
        </div>
      </div>
    </main>
  );
}
