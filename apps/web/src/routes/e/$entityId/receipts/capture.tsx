import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * 旧い「撮影の画面」の URL。追加の入口は証憑の一覧の 1 つだけにしたので、一覧へ送る
 * （ホーム画面に追加したアプリやブックマークを壊さない）
 */
export const Route = createFileRoute("/e/$entityId/receipts/capture")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/e/$entityId/receipts", params, replace: true });
  },
});
