import { createFileRoute } from "@tanstack/react-router";
import { Pair } from "@/features/auth/Pair";

export const Route = createFileRoute("/pair")({
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    typeof search.token === "string" && search.token !== "" ? { token: search.token } : {},
  component: PairPage,
});

function PairPage() {
  const { token } = Route.useSearch();
  return <Pair token={token} />;
}
