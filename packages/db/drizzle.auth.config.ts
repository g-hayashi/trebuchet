import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/auth.ts",
  out: "./drizzle/auth",
});
