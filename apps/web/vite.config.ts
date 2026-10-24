import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    // パスキー（WebAuthn）の RP ID は IP アドレスにできないため、localhost でも開けるようにする（004 R2）
    allowedHosts: ["localhost"],
    port: 5173,
    strictPort: true,
    // 文字列の短縮形は changeOrigin: true になり Host が 127.0.0.1:8787 に書き換わる。
    // server は Host（localhost:5173）で RP ID と Origin を決めるので、書き換えない（004 R6）
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
});
