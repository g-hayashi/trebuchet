import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => (
    <main className="p-6">
      <h1 className="text-xl font-semibold">Trebuchet</h1>
    </main>
  ),
});
