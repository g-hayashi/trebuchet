import { randomUUIDv7 } from "node:crypto";
import { openTenant } from "@trebuchet/db";
import {
  createTestEntity as createDbEntity,
  type TempDataDir,
  useTempDataDir,
} from "@trebuchet/db/testing";
import { domainError, err, ok, type SuggestionProvider } from "@trebuchet/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { statementDeps, unavailableSuggestionProvider } from "../src/deps.ts";
import { aiSettingsRoutes } from "../src/routes/ai-settings.ts";
import { statementRoutes } from "../src/routes/statements.ts";

// 006 T006。依存の組み立てと、空のルートの登録（実物の AI は T025 で差す）

let tmp: TempDataDir;
beforeEach(() => {
  tmp = useTempDataDir("server-statement-deps");
});
afterEach(() => tmp.cleanup());

const clock = { now: () => "2026-10-31T03:00:00.000Z" };

describe("statementDeps", () => {
  it("UnitOfWork・ids・clock と、端末内・外部の SuggestionProvider を返す", () => {
    const db = openTenant(createDbEntity().id);
    const deps = statementDeps(db, clock);
    expect(typeof deps.uow.run).toBe("function");
    expect(deps.clock).toBe(clock);
    expect(deps.ids.next()).not.toBe(deps.ids.next());
    expect(deps.suggestion.local).toBeDefined();
    expect(deps.suggestion.external).toBeDefined();
  });

  it("既定の SuggestionProvider は「使えない」を返す", async () => {
    const db = openTenant(createDbEntity().id);
    const { suggestion } = statementDeps(db, clock);
    for (const provider of [suggestion.local, suggestion.external]) {
      expect(await provider.available()).toBe(false);
      const r = await provider.suggest({}, {});
      expect(r.ok).toBe(false);
    }
    expect(await unavailableSuggestionProvider.available()).toBe(false);
  });

  it("端末内・外部の SuggestionProvider を差し替えられる", async () => {
    const db = openTenant(createDbEntity().id);
    const local: SuggestionProvider = {
      available: async () => true,
      suggest: async () => ok({ from: "local" }),
    };
    const external: SuggestionProvider = {
      available: async () => true,
      suggest: async () => err(domainError("AI_NOT_CONFIGURED", "未設定")),
    };
    const deps = statementDeps(db, clock, { local, external });
    expect(deps.suggestion.local).toBe(local);
    expect(deps.suggestion.external).toBe(external);
    expect(await deps.suggestion.local.suggest({}, {})).toEqual(ok({ from: "local" }));
  });

  it("db を取り違えない（別の事業体の UnitOfWork は別の DB）", () => {
    const a = statementDeps(openTenant(createDbEntity().id), clock);
    const b = statementDeps(openTenant(randomUUIDv7()), clock);
    expect(a.uow).not.toBe(b.uow);
  });
});

describe("ルートの登録", () => {
  it("statementRoutes・aiSettingsRoutes が組み立てられ、createApp に登録される（空のルート）", () => {
    expect(statementRoutes({ clock })).toBeDefined();
    expect(aiSettingsRoutes({ clock })).toBeDefined();
    expect(createApp({ clock })).toBeDefined();
  });
});
