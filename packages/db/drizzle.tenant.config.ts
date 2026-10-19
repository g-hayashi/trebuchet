import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/tenant.ts",
  out: "./drizzle/tenant",
});
