/**
 * Calls go through a same-origin dev-server proxy (see vite.config.ts).
 *
 * GitHub's `GET /search/code` sends no `Access-Control-Allow-Origin` header, so
 * a browser cannot call it directly — the response is delivered but the browser
 * refuses to let JavaScript read it. Routing via `/gh-api` makes the request
 * same-origin, so no CORS check applies.
 *
 * `raw.githubusercontent.com` does send CORS headers, so file downloads stay direct.
 */
const API = "/gh-api";
const RAW = "https://raw.githubusercontent.com";
const TOKEN_KEY = "bbmodel-viewer:token";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

/* ── Errors ─────────────────────────────────────────────────────────── */

export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

async function toError(res: Response): Promise<GitHubError> {
  const contentType = res.headers.get("content-type") ?? "";

  // A 404 with a non-JSON body means the request never reached GitHub — the
  // proxy route is missing, e.g. the built site is served without the dev server.
  if (res.status === 404 && !contentType.includes("json")) {
    return new GitHubError(
      "GitHub API proxy not reachable. Run this with `npm run dev` — the dev server forwards /gh-api to api.github.com.",
      404,
    );
  }

  let message = `HTTP ${res.status} ${res.statusText}`;

  try {
    const data = await res.json();
    if (typeof data?.message === "string" && data.message) message = data.message;
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      const detail = data.errors
        .map((e: { message?: string }) => e?.message ?? JSON.stringify(e))
        .join("; ");
      message += ` — ${detail}`;
    }
  } catch {
    /* body was not JSON; keep the status text */
  }

  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (res.status === 403 && remaining === "0" && Number.isFinite(reset)) {
    const at = new Date(reset * 1000).toLocaleTimeString();
    message = `Rate limit exceeded — try again after ${at}.`;
  }

  return new GitHubError(message, res.status);
}

/* ── Token storage ──────────────────────────────────────────────────── */

export function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing — token simply won't persist */
  }
}

function authHeaders(token: string): HeadersInit {
  const headers: Record<string, string> = {
    Accept: ACCEPT,
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/* ── Rate limit ─────────────────────────────────────────────────────── */

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: Date;
}

function readRateLimit(res: Response): RateLimit | null {
  const limit = Number(res.headers.get("x-ratelimit-limit"));
  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(reset)) {
    return null;
  }
  return { limit, remaining, resetAt: new Date(reset * 1000) };
}

/* ── Authenticated user ─────────────────────────────────────────────── */

export interface Viewer {
  login: string;
  name: string | null;
  scopes: string[];
}

export async function getAuthenticatedUser(token: string, signal?: AbortSignal): Promise<Viewer> {
  const res = await fetch(`${API}/user`, { headers: authHeaders(token), signal });
  if (!res.ok) throw await toError(res);

  const data = await res.json();
  const scopes = (res.headers.get("x-oauth-scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    login: String(data.login ?? ""),
    name: typeof data.name === "string" ? data.name : null,
    scopes,
  };
}

/* ── Code search ────────────────────────────────────────────────────── */

export interface CodeSearchItem {
  name: string;
  path: string;
  sha: string;
  htmlUrl: string;
  repository: {
    fullName: string;
    htmlUrl: string;
    description: string | null;
  };
}

export interface SearchResponse {
  totalCount: number;
  incomplete: boolean;
  items: CodeSearchItem[];
  rateLimit: RateLimit | null;
}

/** GitHub only serves the first 1000 results of any search; deeper pages return 422. */
export const MAX_SEARCH_RESULTS = 1000;

/** GitHub's documented ceiling for `per_page` on search endpoints. */
export const MAX_PER_PAGE = 100;

export interface SearchOptions {
  page?: number;
  perPage?: number;
  signal?: AbortSignal;
}

/**
 * The last page GitHub will serve for a search.
 *
 * A page is rejected with 422 ("Cannot access beyond the first 1000 results")
 * whenever `page * perPage` exceeds 1000, so the ceiling is
 * floor(1000 / perPage) — 33 pages at 30/page, 10 at 100/page. Note this is
 * *not* ceil(1000 / perPage): at 30/page, page 34 is rejected.
 */
export function lastReachablePage(totalCount: number, perPage: number): number {
  const size = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(perPage) || 1));
  const ceiling = Math.max(1, Math.floor(MAX_SEARCH_RESULTS / size));
  const pages = Math.ceil(Math.max(0, totalCount) / size);
  return Math.max(1, Math.min(pages, ceiling));
}

interface RawCodeSearchItem {
  name?: string;
  path?: string;
  sha?: string;
  html_url?: string;
  repository?: {
    full_name?: string;
    html_url?: string;
    description?: string | null;
  };
}

export async function searchCode(
  query: string,
  token: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(options.perPage ?? 30)));

  const params = new URLSearchParams({
    q: query,
    per_page: String(perPage),
    page: String(page),
  });
  const res = await fetch(`${API}/search/code?${params.toString()}`, {
    headers: authHeaders(token),
    signal: options.signal,
  });
  if (!res.ok) throw await toError(res);

  const data = await res.json();
  const items: RawCodeSearchItem[] = Array.isArray(data.items) ? data.items : [];

  return {
    totalCount: Number(data.total_count ?? 0),
    incomplete: Boolean(data.incomplete_results),
    items: items.map((item) => ({
      name: item.name ?? "",
      path: item.path ?? "",
      sha: item.sha ?? "",
      htmlUrl: item.html_url ?? "",
      repository: {
        fullName: item.repository?.full_name ?? "",
        htmlUrl: item.repository?.html_url ?? "",
        description: item.repository?.description ?? null,
      },
    })),
    rateLimit: readRateLimit(res),
  };
}

/* ── File contents ──────────────────────────────────────────────────── */

export interface FileContent {
  text: string;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  options: { token?: string; ref?: string; signal?: AbortSignal } = {},
): Promise<FileContent> {
  const ref = options.ref?.trim() || "HEAD";
  const rawUrl = `${RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(
    ref,
  )}/${encodePath(path)}`;

  // Raw is the fast path: no core-API rate limit is consumed and it streams large
  // files that the REST contents endpoint refuses (>1 MB).
  const rawRes = await fetch(rawUrl, { signal: options.signal });
  if (rawRes.ok) {
    return { text: await rawRes.text() };
  }

  // Fall back to the REST contents API, which can read private repositories when
  // the supplied token has access.
  const url = new URL(`${API}/repos/${owner}/${repo}/contents/${encodePath(path)}`);
  if (options.ref?.trim()) url.searchParams.set("ref", options.ref.trim());

  const res = await fetch(url.toString(), {
    headers: authHeaders(options.token ?? ""),
    signal: options.signal,
  });

  if (!res.ok) {
    if (rawRes.status === 404 && res.status === 404) {
      throw new GitHubError(
        `Not found: ${owner}/${repo}/${path}${options.ref ? `@${options.ref}` : ""}. The repository may be private, or the file may have moved.`,
        404,
      );
    }
    throw await toError(res);
  }

  const data = await res.json();
  if (Array.isArray(data)) {
    throw new GitHubError(`"${path}" is a directory, not a file.`, 400);
  }

  if (typeof data.content === "string" && data.encoding === "base64") {
    const bytes = decodeBase64(data.content.replace(/\s/g, ""));
    return { text: new TextDecoder().decode(bytes) };
  }

  if (typeof data.download_url === "string") {
    const followUp = await fetch(data.download_url, { signal: options.signal });
    if (!followUp.ok) {
      throw new GitHubError(`Could not download the file (HTTP ${followUp.status}).`, followUp.status);
    }
    return { text: await followUp.text() };
  }

  throw new GitHubError("The file is empty or has no downloadable content.", 400);
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ── Input parsing ──────────────────────────────────────────────────── */

export type ParsedInput =
  | { kind: "search"; query: string }
  | { kind: "file"; owner: string; repo: string; path: string; ref?: string };

/**
 * Restricts a search to Blockbench model files.
 *
 * Must stay a plain `extension:` qualifier. GitHub's *web* code search supports
 * globs in `path:` (e.g. `path:*.bbmodel`), but the REST code search API does
 * not — it matches `path:*.bbmodel` literally and returns zero results.
 */
export const MODEL_FILTER = "extension:bbmodel";

/**
 * A bare term gets the model filter appended so the search stays scoped to
 * `.bbmodel` files. Queries that already carry a qualifier pass through.
 */
export function buildSearchQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/\b(?:extension|filename|path|language|repo|user|org|in|size|topic):/i.test(trimmed)) {
    return trimmed;
  }

  const term = trimmed.replace(/\.bbmodel$/i, "").trim();
  if (!term) return MODEL_FILTER;
  return `${term.includes(" ") ? `"${term}"` : term} ${MODEL_FILTER}`;
}

/**
 * Understands the shapes of link a user is likely to paste:
 *   - github.com/search?q=…&type=code
 *   - github.com/owner/repo/blob/<ref>/path/to/file.bbmodel
 *   - github.com/owner/repo/raw/<ref>/path/to/file.bbmodel
 *   - raw.githubusercontent.com/owner/repo/<ref>/path/to/file.bbmodel
 * Anything else is treated as a search term.
 */
export function parseInput(raw: string): ParsedInput {
  const value = raw.trim();
  if (!value) return { kind: "search", query: "" };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "search", query: value };
  }

  const host = url.hostname.replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "github.com") {
    if (segments[0] === "search") {
      return { kind: "search", query: url.searchParams.get("q") ?? "" };
    }
    const marker = segments.findIndex((s) => s === "blob" || s === "raw" || s === "tree");
    if (marker === 2 && segments.length > 3) {
      return {
        kind: "file",
        owner: segments[0],
        repo: segments[1],
        ref: segments[3],
        path: segments.slice(4).join("/"),
      };
    }
  }

  if (host === "raw.githubusercontent.com" && segments.length >= 4) {
    return {
      kind: "file",
      owner: segments[0],
      repo: segments[1],
      ref: segments[2],
      path: segments.slice(3).join("/"),
    };
  }

  return { kind: "search", query: value };
}
