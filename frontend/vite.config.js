import { defineConfig, loadEnv } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

const PROXY_TIMEOUT_MS = 600_000;

function apiProxyOptions(target) {
  return {
    target,
    changeOrigin: true,
    timeout: PROXY_TIMEOUT_MS,
    proxyTimeout: PROXY_TIMEOUT_MS,
  };
}

// Vite MPA mode only serves directory index.html when the path ends in '/'. Bare paths like
// `/dev` or `/admin` need to redirect to `/dev/` / `/admin/` so the browser updates its URL —
// otherwise relative asset paths in the served HTML resolve against the wrong base and 404.
function mpaTrailingSlashRedirect() {
  return {
    name: "mpa-trailing-slash-redirect",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (maybeRedirect(req, res)) return;
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (maybeRedirect(req, res)) return;
        next();
      });
    },
  };
}

function maybeRedirect(req, res) {
  if (!req.url || req.method !== "GET") return false;
  const [pathname, query = ""] = req.url.split("?");
  if (pathname.endsWith("/") || /\.[A-Za-z0-9]+$/.test(pathname)) return false;
  const candidate = resolve(__dirname, "." + pathname, "index.html");
  if (!fs.existsSync(candidate)) return false;
  const location = pathname + "/" + (query ? "?" + query : "");
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
  return true;
}

export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, repoRoot, ""),
    ...loadEnv(mode, __dirname, ""),
  };
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8010";
  const apiProxy = apiProxyOptions(apiProxyTarget);

  return {
    envDir: repoRoot,
    resolve: {
      alias: [
        { find: /^lenis$/, replacement: resolve(__dirname, "shared/vendor/lenis.mjs") },
        { find: /^lenis\/dist\/lenis\.css$/, replacement: resolve(__dirname, "shared/vendor/lenis.css") },
      ],
    },
    optimizeDeps: {
      include: ["heic2any", "lenis"],
    },
    plugins: [mpaTrailingSlashRedirect()],
    appType: "mpa",
    base: "/",
    server: {
      host: true,
      port: 5173,
      strictPort: false,
      allowedHosts: [
        "localhost",
        "127.0.0.1",
        ".ngrok-free.dev",
        ".ngrok-free.app",
        ".ngrok.app",
      ],
      proxy: {
        "/api": apiProxy,
        "/uploads": apiProxy,
      },
    },
    preview: {
      host: true,
      port: 5173,
      strictPort: false,
      allowedHosts: [
        "localhost",
        "127.0.0.1",
        ".ngrok-free.dev",
        ".ngrok-free.app",
        ".ngrok.app",
      ],
      proxy: {
        "/api": apiProxy,
        "/uploads": apiProxy,
      },
    },
    build: {
      outDir: "dist",
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          login: resolve(__dirname, "login/index.html"),
          register: resolve(__dirname, "register/index.html"),
          adminDashboard: resolve(__dirname, "admin/index.html"),
          adminLogin: resolve(__dirname, "admin/login/index.html"),
          devPortal: resolve(__dirname, "dev/index.html"),
          aiAnalysis: resolve(__dirname, "dashboard/ai-analysis/index.html"),
          imageAnalysis: resolve(__dirname, "dashboard/image-analysis/index.html"),
          live: resolve(__dirname, "dashboard/live/index.html"),
          remoteCamera: resolve(__dirname, "dashboard/live/remote/index.html"),
        },
      },
    },
  };
});
