/**
 * Runs the browser regression harness in tests/render.html against a fresh Vite
 * dev server, using headless Chrome with software WebGL.
 *
 * Models are fetched from GitHub, so this needs network access. Exits non-zero
 * if any model fails to load, renders nothing, or its animation is frozen.
 *
 *   node tests/run-render.mjs           # whole suite
 *   node tests/run-render.mjs wheel     # only models whose path matches
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "vite";

const PORT = 5199;
const filter = process.argv[2] ?? "";

const BROWSERS = [
  process.env.CHROME,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
].filter(Boolean);

function findBrowser() {
  for (const candidate of BROWSERS) {
    const probe = spawnSync("which", [candidate], { encoding: "utf8" });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  return null;
}

const browser = findBrowser();
if (!browser) {
  console.error(
    "No Chrome/Chromium found. Install one, or set CHROME=/path/to/chrome.",
  );
  process.exit(2);
}

const server = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: "warn",
});
await server.listen();

const url = `http://localhost:${PORT}/tests/render.html${filter ? `?only=${encodeURIComponent(filter)}` : ""}`;

const chrome = spawn(
  browser,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--hide-scrollbars",
    "--window-size=900,900",
    "--virtual-time-budget=600000",
    "--dump-dom",
    url,
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);

let dom = "";
chrome.stdout.setEncoding("utf8");
chrome.stdout.on("data", (chunk) => {
  dom += chunk;
});

const code = await new Promise((resolve) => chrome.on("close", resolve));
await server.close();

const match = dom.match(/<pre id="log"[^>]*>([\s\S]*?)<\/pre>/);
if (!match) {
  console.error("Harness produced no output (chrome exit code " + code + ").");
  process.exit(1);
}

// The harness builds the log from <span> elements; strip the markup.
const text = match[1]
  .replace(/<[^>]+>/g, "")
  .replace(/&quot;/g, '"')
  .replace(/&gt;/g, ">")
  .replace(/&lt;/g, "<")
  .replace(/&amp;/g, "&")
  .trim();

console.log(text);

const summary = text.match(/RENDER_DONE failures=(\d+) total=(\d+)/);
if (!summary) {
  console.error("\nHarness did not report a result.");
  process.exit(1);
}

const failures = Number(summary[1]);
const total = Number(summary[2]);
console.log(failures === 0 ? `\nAll ${total} models passed.` : "");
process.exit(failures === 0 ? 0 : 1);
