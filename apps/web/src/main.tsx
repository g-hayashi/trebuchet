import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { queryClient } from "./lib/api";
import { routeTree } from "./routeTree.gen";
import "./index.css";
import "./print.css";

// 共有スキーマで個別の文言を指定していない検証エラー（範囲外の数値など）を日本語にする
z.config(z.locales.ja());

const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
