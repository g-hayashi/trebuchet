import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/e/$entityId/reports/index";
import { mockApi } from "../mock-api";
import { renderRoute } from "../render-route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("帳票の入口（011 R1）", () => {
  it("/reports は損益計算書へ移る", async () => {
    mockApi({});
    const { router } = renderRoute(Route, { path: "/e/$entityId/reports/", url: "/e/e1/reports" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/e/e1/reports/profit-and-loss"),
    );
  });
});
