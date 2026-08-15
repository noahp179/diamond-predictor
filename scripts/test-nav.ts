#!/usr/bin/env node
/**
 * Checks the site's information architecture against the router's own tree.
 *
 * src/lib/nav.ts builds hrefs by joining segments, so TypeScript sees `string`
 * where the router wants its union of literal routes, and AppShell asserts the
 * type once to bridge that. This test is what replaces the guarantee that
 * assertion gives up: every href nav.ts can produce — for every sport, every
 * view, every league — must exist in routeTree.gen.ts. A page renamed on disk
 * without updating nav.ts fails here rather than 404ing in production.
 *
 * It also pins the legacy redirects, because the whole point of keeping
 * /model, /best-odds, /props and /history alive is that someone's bookmark
 * still works, and a redirect pointing at a route that no longer exists is
 * worse than no redirect at all.
 *
 * Run:  npx tsx scripts/test-nav.ts
 */
import { readFileSync } from "node:fs";

import {
  divisionsOf,
  LEAGUES,
  LEGACY_REDIRECTS,
  SPORTS,
  TOURS,
  viewHref,
  viewsFor,
  type DivisionSlug,
} from "../src/lib/nav";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

/**
 * The routes the router actually knows about, read out of the generated tree.
 * `fullPath` lines are the addressable paths; parameterised ones keep their
 * `$league` placeholder, which is matched against below.
 */
const tree = readFileSync("src/routeTree.gen.ts", "utf8");
const routes = new Set(
  [...tree.matchAll(/fullPath:\s*'([^']+)'/g)].map((m) => m[1].replace(/\/$/, "") || "/"),
);

/** A concrete href matches either itself or a `$param` route of the same shape. */
function known(href: string): boolean {
  const clean = href.replace(/\/$/, "") || "/";
  if (routes.has(clean)) return true;
  const parts = clean.split("/");
  for (const r of routes) {
    const rp = r.split("/");
    if (rp.length !== parts.length) continue;
    if (rp.every((seg, i) => seg.startsWith("$") || seg === parts[i])) return true;
  }
  return false;
}

check(`route tree parsed (${routes.size} routes)`, routes.size > 10, [...routes].join(", "));

// ---- every sport's landing page exists
for (const s of SPORTS) {
  check(`${s.label}: landing route ${s.href} exists`, known(s.href));
}

// ---- every view of every sport, in every division, resolves
for (const s of SPORTS) {
  const divs = divisionsOf(s.key);
  // Divisions come from nav.ts rather than being hardcoded here: a sport whose
  // divisions were wired to the wrong list would otherwise still pass, because
  // /tennis/$tour happily matches a soccer slug.
  check(
    `${s.label}: leagued flag matches whether it has divisions`,
    s.leagued === divs.length > 0,
    `leagued=${s.leagued} but ${divs.length} divisions`,
  );
  const slugs: (DivisionSlug | undefined)[] = divs.length ? divs.map((d) => d.slug) : [undefined];
  for (const div of slugs) {
    const views = viewsFor(s.key, div);
    const bad = views.filter((v) => !known(v.href));
    check(
      `${s.label}${div ? ` / ${div}` : ""}: all ${views.length} views resolve`,
      bad.length === 0,
      bad.map((v) => `${v.key} -> ${v.href}`).join(", "),
    );
    // And the division must actually appear in the path, not silently vanish.
    if (div) {
      check(
        `${s.label} / ${div}: the division is in the URL`,
        views.every((v) => v.href.includes(`/${div}`)),
        views.map((v) => v.href).join(", "),
      );
    }
  }
}

// ---- divisions are drawn from the right list per sport
check(
  "soccer divisions are the leagues",
  divisionsOf("soccer").map((d) => d.slug).join(",") === LEAGUES.map((l) => l.slug).join(","),
);
check(
  "tennis divisions are the tours",
  divisionsOf("tennis").map((d) => d.slug).join(",") === TOURS.map((t) => t.slug).join(","),
);
check(
  "no sport borrows another's divisions",
  divisionsOf("tennis").every((d) => !LEAGUES.some((l) => l.slug === d.slug)),
);

// ---- the hub and Teams sit outside the sport grammar but must still exist
check("hub route / exists", known("/"));
check("teams route exists", known("/teams"));

// ---- legacy paths still resolve, and point somewhere real
for (const r of LEGACY_REDIRECTS) {
  check(`legacy ${r.from} still routed`, known(r.from));
  check(`legacy ${r.from} targets a real page (${r.to})`, known(r.to));
}

// ---- the URL grammar itself
check(
  "a leagued sport puts the league in the path, not a query",
  viewHref("soccer", "props", "seriea") === "/soccer/seriea/props",
  viewHref("soccer", "props", "seriea"),
);
check(
  "tennis puts the tour in the path too",
  viewHref("tennis", "model", "wta") === "/tennis/wta/model",
  viewHref("tennis", "model", "wta"),
);
check(
  "an unleagued sport does not",
  viewHref("mlb", "props") === "/mlb/props",
  viewHref("mlb", "props"),
);
check(
  "the slate is the section index, with no extra segment",
  viewHref("nfl", "slate") === "/nfl" && viewHref("soccer", "slate", "epl") === "/soccer/epl",
);
check(
  "soccer defaults to a league rather than producing a broken href",
  viewHref("soccer", "props") === `/soccer/${LEAGUES[0].slug}/props`,
);
check(
  "tennis defaults to a tour rather than producing a broken href",
  viewHref("tennis", "model") === `/tennis/${TOURS[0].slug}/model`,
);

// ---- no duplicate hrefs within one sport (a copy-paste in the view table)
for (const s of SPORTS) {
  const d0 = divisionsOf(s.key)[0]?.slug;
  const hrefs = viewsFor(s.key, d0).map((v) => v.href);
  check(
    `${s.label}: view hrefs are distinct`,
    new Set(hrefs).size === hrefs.length,
    hrefs.join(", "),
  );
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
