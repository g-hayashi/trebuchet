import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/registry.ts",
  out: "./drizzle/registry",
});
