import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/features/home/HomePage";

export const Route = createFileRoute("/e/$entityId/")({
  component: EntityHome,
});

/** 事業体のホーム（011 US1）。名前の変更は「事業体の設定 → 基本」へ移した */
function EntityHome() {
  const { entityId } = Route.useParams();
  return <HomePage entityId={entityId} />;
}
