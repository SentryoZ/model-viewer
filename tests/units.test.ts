import {
  buildSearchQuery,
  lastReachablePage,
  parseInput,
} from "../src/github.ts";

let failures = 0;

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log("  pass  " + label);
  } else {
    failures += 1;
    console.log("  FAIL  " + label + "\n          expected " + e + "\n          actual   " + a);
  }
}

console.log("\nbuildSearchQuery");
eq("bare term", buildSearchQuery("spider"), "spider extension:bbmodel");
eq("term with extension", buildSearchQuery("spider.bbmodel"), "spider extension:bbmodel");
eq("multi-word term is quoted", buildSearchQuery("big spider"), '"big spider" extension:bbmodel');
eq("existing qualifier passes through", buildSearchQuery("path:*.bbmodel dragon"), "path:*.bbmodel dragon");
eq("filename qualifier passes through", buildSearchQuery("filename:foo.bbmodel"), "filename:foo.bbmodel");
eq("only the extension yields the bare filter", buildSearchQuery(".bbmodel"), "extension:bbmodel");
eq("empty stays empty", buildSearchQuery("   "), "");

console.log("\nparseInput");
eq("search url", parseInput("https://github.com/search?q=spider.bbmodel&type=code"), {
  kind: "search",
  query: "spider.bbmodel",
});
eq("blob url", parseInput("https://github.com/o/r/blob/main/assets/a.bbmodel"), {
  kind: "file",
  owner: "o",
  repo: "r",
  ref: "main",
  path: "assets/a.bbmodel",
});
eq("www raw url", parseInput("https://www.github.com/o/r/raw/v2/deep/a.bbmodel"), {
  kind: "file",
  owner: "o",
  repo: "r",
  ref: "v2",
  path: "deep/a.bbmodel",
});
eq("raw.githubusercontent url", parseInput("https://raw.githubusercontent.com/o/r/main/a.bbmodel"), {
  kind: "file",
  owner: "o",
  repo: "r",
  ref: "main",
  path: "a.bbmodel",
});
eq("plain term", parseInput("spider.bbmodel"), { kind: "search", query: "spider.bbmodel" });
eq("unrecognised url falls through", parseInput("https://example.com/nope"), {
  kind: "search",
  query: "https://example.com/nope",
});
eq("empty input", parseInput("   "), { kind: "search", query: "" });

console.log("\nlastReachablePage");
// GitHub rejects a page when page * perPage > 1000 (422), so the ceiling is
// floor(1000 / perPage) — verified live: page 34 at 30/page is rejected.
eq("cap at 30/page", lastReachablePage(22784, 30), 33);
eq("cap at 100/page", lastReachablePage(22784, 100), 10);
eq("cap at 50/page", lastReachablePage(22784, 50), 20);
eq("small result set", lastReachablePage(58, 30), 2);
eq("fewer than one page", lastReachablePage(5, 100), 1);
eq("no results", lastReachablePage(0, 30), 1);
eq("exactly the cap", lastReachablePage(1000, 100), 10);

let worstCase = 0;
for (const perPage of [10, 20, 30, 50, 100]) {
  for (const total of [0, 1, 29, 30, 31, 999, 1000, 1001, 22784, 99999]) {
    worstCase = Math.max(worstCase, lastReachablePage(total, perPage) * perPage);
  }
}
eq("no reachable page exceeds 1000 results", worstCase <= 1000, true);

console.log(
  failures === 0 ? "\nALL PASS\n" : "\n" + failures + " ASSERTION(S) FAILED\n",
);
process.exit(failures === 0 ? 0 : 1);
