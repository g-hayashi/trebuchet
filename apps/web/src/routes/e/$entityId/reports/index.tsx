import { createFileRoute, redirect } from "@tanstack/react-router";

/** 帳票の入口は残高試算表 */
export const Route = createFileRoute("/e/$entityId/reports/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/e/$entityId/reports/trial-balance", params });
  },
});
