import { createFileRoute, redirect } from "@tanstack/react-router";

/** 帳票の入口は損益計算書（011 R1。帳票の中は画面のタブで行き来する） */
export const Route = createFileRoute("/e/$entityId/reports/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/e/$entityId/reports/profit-and-loss", params });
  },
});
