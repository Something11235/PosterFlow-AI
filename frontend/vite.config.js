import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const localBackendPort = process.env.POSTERFLOW_LOCAL_OWN_KEY === '1'
  ? Number(process.env.POSTERFLOW_LOCAL_BACKEND_PORT || 5001) : 5001;
if (!Number.isInteger(localBackendPort) || localBackendPort < 1024 || localBackendPort > 65535) {
  throw new Error('POSTERFLOW_LOCAL_BACKEND_PORT must be between 1024 and 65535.');
}

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
        target: `http://127.0.0.1:${localBackendPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
