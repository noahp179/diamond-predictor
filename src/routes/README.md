# Routes

TanStack Start uses **file-based routing**. Every `.tsx` file in this directory
is a route. Do **not** create `src/pages/`, `src/routes/_app/index.tsx`, or
`app/layout.tsx` — those are Next.js / Remix conventions. The only root layout
is `src/routes/__root.tsx`.

## Conventions

| File                     | URL                                                     |
| ------------------------ | ------------------------------------------------------- |
| `index.tsx`              | `/`                                                     |
| `about.tsx`              | `/about`                                                |
| `users/index.tsx`        | `/users`                                                |
| `users/$id.tsx`          | `/users/:id` (dynamic — bare `$`, no curly braces)      |
| `posts/{-$category}.tsx` | `/posts/:category?` (optional segment)                  |
| `files/$.tsx`            | `/files/*` (splat — read via `_splat` param, never `*`) |
| `_layout.tsx`            | layout route (renders children via `<Outlet />`)        |
| `__root.tsx`             | app shell — wraps every page; preserve `<Outlet />`     |

`routeTree.gen.ts` is auto-generated. Don't edit it by hand.

## This site's URL grammar

Declared once in `src/lib/nav.ts`, which every navigation surface reads from —
the sport switcher, the view tabs, the league bar and the hub. Adding a page
means adding a line there as well as a file here.

```
/                        the hub — what is on the site
/<sport>                 that sport's slate       /mlb, /nfl, /nba
/<sport>/<view>          a view within it         /mlb/props, /nfl/td-scorers
/soccer                  the league picker
/soccer/<league>         a competition's fixtures /soccer/seriea
/soccer/<league>/<view>  a view within it         /soccer/seriea/props
/teams                   cross-sport, outside the grammar
```

Soccer carries the league in the **path**, not a query string, because each
league is a separate model with a separate calibration and backtest. Crossing
that segment changes which model's numbers you are reading.

### Legacy routes

`/model`, `/best-odds`, `/props` and `/history` are from when MLB was the whole
site and lived at the root. They are now redirect stubs pointing at their
`/mlb/*` homes — kept because they are in people's bookmarks. `LEGACY_REDIRECTS`
in `nav.ts` lists them and `scripts/test-nav.ts` checks both ends still resolve.

### Why nav.ts is asserted rather than typed

Hrefs are built by joining segments, so TypeScript sees `string` where the
router wants its generated union of literal routes. `AppShell` asserts the type
once. `scripts/test-nav.ts` replaces the guarantee that gives up: every href
`nav.ts` can produce is checked against `routeTree.gen.ts`, so a page renamed on
disk fails the test rather than 404ing in production.
