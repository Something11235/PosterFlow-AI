import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  ...(process.env.POSTERFLOW_LOCAL_OWN_KEY === "1" ? {
    envDir: false,
    define: {
      "import.meta.env.VITE_SUPABASE_URL": '""',
      "import.meta.env.VITE_SUPABASE_ANON_KEY": '""',
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": '""',
    },
  } : {}),
  plugins: [react(), tailwindcss()],
  server: {
    port: 3001,
    proxy: {
      "/api": {
        target: "http://localhost:5001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
