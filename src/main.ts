import "./styles.css";
import {
  GitHubError,
  MAX_SEARCH_RESULTS,
  buildSearchQuery,
  fetchFileContent,
  getAuthenticatedUser,
  lastReachablePage,
  loadToken,
  parseInput,
  saveToken,
  searchCode,
  type CodeSearchItem,
  type Viewer,
} from "./github";
import type { ModelViewer } from "./viewer";

/* ── Element lookup ─────────────────────────────────────────────────── */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const authStatus = el("auth-status");
const tokenInput = el<HTMLInputElement>("token-input");
const tokenSave = el<HTMLButtonElement>("token-save");
const tokenClear = el<HTMLButtonElement>("token-clear");

const searchStatus = el("search-status");
const searchInput = el<HTMLInputElement>("search-input");
const searchButton = el<HTMLButtonElement>("search-button");
const resultsEl = el<HTMLUListElement>("results");

const pager = el("pager");
const pagePrev = el<HTMLButtonElement>("page-prev");
const pageNext = el<HTMLButtonElement>("page-next");
const pageInfo = el("page-info");
const perPageSelect = el<HTMLSelectElement>("per-page");

const filePanel = el("file-panel");
const fileStatus = el("file-status");
const fileLink = el<HTMLAnchorElement>("file-link");
const fileSub = el("file-sub");
const fileContent = el<HTMLTextAreaElement>("file-content");
const fileCopy = el<HTMLButtonElement>("file-copy");
const fileDownload = el<HTMLButtonElement>("file-download");
const fileClear = el<HTMLButtonElement>("file-clear");
const textareaStats = el("textarea-stats");

const tabPreview = el<HTMLButtonElement>("tab-preview");
const tabSource = el<HTMLButtonElement>("tab-source");
const canvasContainer = el("canvas-container");
const previewMessage = el("preview-message");
const animationSelect = el<HTMLSelectElement>("animation-select");

/* ── State ──────────────────────────────────────────────────────────── */

type Tone = "muted" | "ok" | "warn" | "error";
type View = "preview" | "source";

let token = loadToken();
let viewer: Viewer | null = null;

let results: CodeSearchItem[] = [];
let activeSha: string | null = null;
let searchController: AbortController | null = null;
let fileController: AbortController | null = null;

/** The query currently on screen, used to re-run it when paging. */
let currentQuery = "";
let currentPage = 1;
let perPage = Number(perPageSelect.value) || 30;
let totalCount = 0;

let modelViewer: ModelViewer | null = null;
let viewerPromise: Promise<ModelViewer | null> | null = null;
let previewTimer: number | null = null;
let renderToken = 0;

/** Where the loaded model came from, so relative texture paths can be resolved. */
let textureContext: { owner: string; repo: string; ref?: string; path: string } | null = null;

/* ── Small helpers ──────────────────────────────────────────────────── */

function setStatus(node: HTMLElement, text: string, tone: Tone = "muted"): void {
  node.textContent = text;
  node.dataset.tone = tone;
}

function describeError(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.status === 401) {
      return "GitHub rejected that token (401). Check that it is still valid.";
    }
    return error.message;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "";
  if (error instanceof TypeError) return "Network request failed — check your connection.";
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatReset(at: Date): string {
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

/* ── Auth ───────────────────────────────────────────────────────────── */

function renderAuth(): void {
  if (!viewer) {
    tokenClear.hidden = true;
    setStatus(authStatus, token ? "Token not verified" : "No token", token ? "warn" : "muted");
    return;
  }

  tokenClear.hidden = false;
  const scopeText = viewer.scopes.length > 0 ? viewer.scopes.join(", ") : "public only";
  setStatus(authStatus, `@${viewer.login} · ${scopeText}`, "ok");
}

async function verifyStoredToken(value: string): Promise<void> {
  try {
    viewer = await getAuthenticatedUser(value);
    renderAuth();
  } catch (error) {
    viewer = null;
    renderAuth();
    setStatus(authStatus, describeError(error), "error");
  }
}

async function handleTokenSave(): Promise<void> {
  const value = tokenInput.value.trim();
  if (!value) {
    setStatus(authStatus, "Paste a token first.", "error");
    return;
  }

  tokenSave.disabled = true;
  setStatus(authStatus, "Checking…");

  try {
    viewer = await getAuthenticatedUser(value);
    token = value;
    saveToken(value);
    tokenInput.value = "";
    renderAuth();
  } catch (error) {
    viewer = null;
    renderAuth();
    setStatus(authStatus, describeError(error), "error");
  } finally {
    tokenSave.disabled = false;
  }
}

function handleTokenClear(): void {
  token = "";
  viewer = null;
  saveToken("");
  tokenInput.value = "";
  renderAuth();
}

/* ── Results ────────────────────────────────────────────────────────── */

function renderResults(): void {
  resultsEl.replaceChildren();
  if (results.length === 0) return;

  const fragment = document.createDocumentFragment();

  for (const item of results) {
    const li = document.createElement("li");
    li.className = "result";
    if (item.sha && item.sha === activeSha) li.classList.add("is-active");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-button";
    button.addEventListener("click", () => {
      void loadFile(item);
    });

    const repo = document.createElement("span");
    repo.className = "result-repo";
    repo.textContent = item.repository.fullName || "unknown repository";

    const path = document.createElement("span");
    path.className = "result-path";
    path.textContent = item.path;

    button.append(repo, path);
    li.append(button);
    fragment.append(li);
  }

  resultsEl.append(fragment);
}

/* ── Pagination ─────────────────────────────────────────────────────── */

function lastPage(): number {
  return lastReachablePage(totalCount, perPage);
}

/** How many results can actually be paged to, given the API's 1000-result ceiling. */
function reachableResults(): number {
  return Math.min(totalCount, lastPage() * perPage);
}

function renderPager(): void {
  if (!currentQuery || totalCount === 0) {
    pager.hidden = true;
    return;
  }

  const last = lastPage();
  pager.hidden = false;
  pageInfo.textContent = `Page ${currentPage} of ${last.toLocaleString()}`;
  pagePrev.disabled = currentPage <= 1;
  pageNext.disabled = currentPage >= last;
}

/* ── Preview ────────────────────────────────────────────────────────── */

function setView(view: View): void {
  filePanel.dataset.view = view;
  const previewing = view === "preview";

  tabPreview.classList.toggle("is-active", previewing);
  tabSource.classList.toggle("is-active", !previewing);
  tabPreview.setAttribute("aria-selected", String(previewing));
  tabSource.setAttribute("aria-selected", String(!previewing));

  // The canvas had no layout box while hidden, so re-measure once it is shown.
  if (previewing) {
    requestAnimationFrame(() => modelViewer?.resize());
  }
}

function setStageMessage(text: string, tone: Tone = "muted"): void {
  previewMessage.textContent = text;
  previewMessage.dataset.tone = tone;
  previewMessage.hidden = text === "";
}

function ensureViewer(): Promise<ModelViewer | null> {
  if (viewerPromise) return viewerPromise;

  viewerPromise = (async () => {
    try {
      // three.js is ~550 kB, so it is only fetched the first time a model is
      // actually previewed — searching stays fast.
      const { createViewer } = await import("./viewer");
      modelViewer = createViewer(canvasContainer, {
        // Models commonly reference sibling PNGs instead of embedding them.
        resolveTexture: (source) => {
          const context = textureContext;
          if (!context) return source;
          const dir = context.path.includes("/")
            ? context.path.slice(0, context.path.lastIndexOf("/") + 1)
            : "";
          const ref = context.ref ?? "HEAD";
          return `https://raw.githubusercontent.com/${context.owner}/${context.repo}/${ref}/${dir}${source}`;
        },
        onError: (error) => {
          setStageMessage(`WebGL unavailable: ${error.message}`, "error");
        },
      });
    } catch {
      setStageMessage("This browser could not create a WebGL context.", "error");
      tabPreview.disabled = true;
      setView("source");
    }

    return modelViewer;
  })();

  return viewerPromise;
}

function setAnimationOptions(names: string[], selected: string): void {
  animationSelect.replaceChildren();

  const none = document.createElement("option");
  none.value = "";
  none.textContent = names.length > 0 ? "None" : "No animations";
  animationSelect.append(none);

  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    animationSelect.append(option);
  }

  animationSelect.value = selected;
  animationSelect.disabled = names.length === 0;
}

async function renderPreview(jsonText: string): Promise<void> {
  if (!jsonText.trim()) {
    modelViewer?.clear();
    setAnimationOptions([], "");
    setStageMessage(
      "Pick a search result on the left, or paste a .bbmodel file's contents into the Source tab.",
    );
    return;
  }

  const active = await ensureViewer();
  if (!active) return;

  const request = ++renderToken;
  setStageMessage("");

  try {
    const result = await active.load(jsonText);
    // A newer render started while this one was in flight.
    if (request !== renderToken) return;

    setStageMessage("");
    setAnimationOptions(result.animations, result.animations[0] ?? "");

    const drawn = result.elements - result.skipped;
    const bits = [
      `${drawn} element${drawn === 1 ? "" : "s"}`,
      `${result.textures} texture${result.textures === 1 ? "" : "s"}`,
      result.animations.length > 0
        ? `${result.animations.length} animation${result.animations.length === 1 ? "" : "s"}`
        : "no animations",
    ];
    if (result.skipped > 0) {
      bits.push(
        `${result.skipped} mesh element${result.skipped === 1 ? "" : "s"} not rendered`,
      );
    }

    setStatus(fileStatus, bits.join(" · "), result.skipped > 0 ? "warn" : "ok");
  } catch (error) {
    if (request !== renderToken) return;
    active.clear();
    setAnimationOptions([], "");
    const message = error instanceof SyntaxError ? "Not valid JSON." : describeError(error);
    setStageMessage(message, error instanceof SyntaxError ? "warn" : "error");
    setStatus(fileStatus, message, error instanceof SyntaxError ? "warn" : "error");
  }
}

function schedulePreview(): void {
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    previewTimer = null;
    void renderPreview(fileContent.value);
  }, 400);
}

/* ── File loading ───────────────────────────────────────────────────── */

function setFileMeta(name: string, href: string, sub: string): void {
  if (href) {
    fileLink.href = href;
    fileLink.textContent = name;
    fileLink.hidden = false;
  } else {
    fileLink.removeAttribute("href");
    fileLink.textContent = name;
    fileLink.hidden = !name;
  }
  fileSub.textContent = sub;
}

function updateFileActions(): void {
  const empty = fileContent.value.length === 0;
  fileCopy.disabled = empty;
  fileDownload.disabled = empty;
  fileClear.disabled = empty;
}

function updateStats(): void {
  const text = fileContent.value;
  if (!text) {
    textareaStats.textContent = "";
  } else {
    const lines = text.split("\n").length;
    textareaStats.textContent = `${text.length.toLocaleString()} chars · ${lines.toLocaleString()} lines`;
  }
  updateFileActions();
}

function setFileContent(content: string): void {
  fileContent.value = content;
  updateStats();
}

async function loadFile(item: CodeSearchItem): Promise<void> {
  const [owner, repo] = item.repository.fullName.split("/");
  if (!owner || !repo) {
    setStatus(fileStatus, "Could not determine the repository for this result.", "error");
    return;
  }

  activeSha = item.sha || null;
  renderResults();

  await loadFromRepo({
    owner,
    repo,
    path: item.path,
    htmlUrl: item.repository.htmlUrl
      ? `${item.repository.htmlUrl}/blob/HEAD/${item.path}`
      : item.htmlUrl,
  });
}

interface LoadRequest {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
  htmlUrl?: string;
}

async function loadFromRepo(request: LoadRequest): Promise<void> {
  fileController?.abort();
  fileController = new AbortController();

  setStatus(fileStatus, "Loading…");
  setFileMeta(
    basename(request.path),
    request.htmlUrl ?? "",
    `${request.owner}/${request.repo}${request.ref ? `@${request.ref}` : ""}`,
  );

  try {
    const content = await fetchFileContent(request.owner, request.repo, request.path, {
      token,
      ref: request.ref,
      signal: fileController.signal,
    });

    textureContext = {
      owner: request.owner,
      repo: request.repo,
      ref: request.ref,
      path: request.path,
    };

    setFileContent(content.text);
    setView("preview");
    await renderPreview(content.text);
  } catch (error) {
    if (isAbort(error)) return;
    setFileContent("");
    textureContext = null;
    setStatus(fileStatus, describeError(error), "error");
    modelViewer?.clear();
    setStageMessage(describeError(error), "error");
  }
}

/* ── Search ─────────────────────────────────────────────────────────── */

async function runSearch(page = 1): Promise<void> {
  const parsed = parseInput(searchInput.value);

  if (parsed.kind === "file") {
    currentQuery = "";
    totalCount = 0;
    results = [];
    renderResults();
    renderPager();
    setStatus(searchStatus, "Link detected — loading file…", "ok");
    await loadFromRepo(parsed);
    return;
  }

  const query = buildSearchQuery(parsed.query);
  if (!query) {
    setStatus(searchStatus, "Enter a search term or paste a link.", "error");
    return;
  }

  if (!token) {
    setStatus(searchStatus, "A GitHub token is required for code search.", "error");
    return;
  }

  searchController?.abort();
  searchController = new AbortController();

  searchButton.disabled = true;
  setStatus(searchStatus, page > 1 ? `Loading page ${page}…` : "Searching…");
  resultsEl.replaceChildren();

  try {
    const response = await searchCode(query, token, {
      page,
      perPage,
      signal: searchController.signal,
    });

    currentQuery = query;
    currentPage = page;
    totalCount = response.totalCount;
    results = response.items;
    activeSha = null;

    renderResults();
    renderPager();

    if (results.length === 0) {
      setStatus(searchStatus, `No files matched ${query}`, "warn");
      return;
    }

    const rate = response.rateLimit;
    const bits = [
      response.incomplete
        ? `${totalCount.toLocaleString()}+ matches`
        : `${totalCount.toLocaleString()} matches`,
      `page ${currentPage}/${lastPage()}`,
    ];
    if (totalCount > MAX_SEARCH_RESULTS) bits.push(`${reachableResults().toLocaleString()} browsable`);
    if (rate) bits.push(`${rate.remaining}/${rate.limit} left until ${formatReset(rate.resetAt)}`);

    setStatus(searchStatus, bits.join(" · "), "ok");
  } catch (error) {
    if (isAbort(error)) return;
    results = [];
    totalCount = 0;
    renderPager();
    setStatus(searchStatus, describeError(error), "error");
  } finally {
    searchButton.disabled = false;
  }
}

/* ── Wiring ─────────────────────────────────────────────────────────── */

tokenSave.addEventListener("click", () => void handleTokenSave());
tokenClear.addEventListener("click", handleTokenClear);
tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void handleTokenSave();
  }
});

searchButton.addEventListener("click", () => void runSearch(1));
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void runSearch(1);
  }
});

pagePrev.addEventListener("click", () => {
  if (currentPage > 1) void runSearch(currentPage - 1);
});
pageNext.addEventListener("click", () => {
  if (currentPage < lastPage()) void runSearch(currentPage + 1);
});
perPageSelect.addEventListener("change", () => {
  perPage = Number(perPageSelect.value) || 30;
  if (currentQuery) void runSearch(1);
});

tabPreview.addEventListener("click", () => setView("preview"));
tabSource.addEventListener("click", () => setView("source"));

animationSelect.addEventListener("change", () => {
  modelViewer?.playAnimation(animationSelect.value);
});

fileContent.addEventListener("input", () => {
  updateStats();
  schedulePreview();
});

fileCopy.addEventListener("click", async () => {
  if (!fileContent.value) return;
  try {
    await navigator.clipboard.writeText(fileContent.value);
    setStatus(fileStatus, "Copied to clipboard", "ok");
  } catch {
    fileContent.select();
    setStatus(fileStatus, "Press Ctrl/Cmd+C to copy", "warn");
  }
});

fileDownload.addEventListener("click", () => {
  if (!fileContent.value) return;
  const blob = new Blob([fileContent.value], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileLink.textContent || "model.bbmodel";
  anchor.click();
  URL.revokeObjectURL(url);
});

fileClear.addEventListener("click", () => {
  fileController?.abort();
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
    previewTimer = null;
  }
  renderToken += 1;

  setFileContent("");
  activeSha = null;
  textureContext = null;
  setFileMeta("", "", "");
  setStatus(fileStatus, "");
  modelViewer?.clear();
  setAnimationOptions([], "");
  setStageMessage(
    "Pick a search result on the left, or paste a .bbmodel file's contents into the Source tab.",
  );
  renderResults();
});

// Keep the renderer in step with the panel, including window resizes.
new ResizeObserver(() => modelViewer?.resize()).observe(canvasContainer);

if (token) {
  tokenInput.placeholder = "Token saved — paste a new one to replace it";
  void verifyStoredToken(token);
} else {
  renderAuth();
}

updateFileActions();
setView("preview");
