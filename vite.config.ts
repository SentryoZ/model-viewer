import { defineConfig } from "vite";

/**
 * GitHub's `GET /search/code` endpoint returns no `Access-Control-Allow-Origin`
 * header, so a browser can never read its response directly. Other endpoints
 * (`/user`, `/search/repositories`) do send CORS headers, and so does
 * `raw.githubusercontent.com` — only code search needs proxying.
 *
 * Forwarding through the dev server makes the call same-origin, which sidesteps
 * CORS entirely. The token still lives in the browser and is passed through
 * verbatim; nothing is stored server-side.
 */
const githubApiProxy = {
  "/gh-api": {
    target: "https://api.github.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/gh-api/, ""),
  },
};

export default defineConfig({
  server: { proxy: githubApiProxy },
  preview: { proxy: githubApiProxy },
  build: {
    // three.js (~550 kB) is lazily imported by main.ts, so it lands in its own
    // on-demand chunk rather than the entry bundle. The size is expected.
    chunkSizeWarningLimit: 700,
  },
});
