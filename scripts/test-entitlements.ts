#!/usr/bin/env node
/**
 * Checks the free/premium rules.
 *
 * These decide what a paying customer gets that a free one does not, so a bug
 * here is either giving away the product or withholding something someone paid
 * for. Both are worth a test.
 *
 * The last block is the important one. `redact` is the single enforcement point
 * every gated endpoint funnels through, and the property it must have is that a
 * locked row contains NO trace of the prediction — not a rounded version, not a
 * hidden field, nothing. The blur in the UI is a visual affordance over data
 * that was already withheld; if redact leaked, the blur would be decoration
 * over a full payload and the paywall would be an inconvenience rather than a
 * wall.
 *
 * Run:  npx tsx scripts/test-entitlements.ts
 */
import {
  ANONYMOUS_PREDICTIONS,
  canSeeParlay,
  canSeeProps,
  FREE_PREDICTIONS_PER_SPORT,
  isUnlimited,
  lockCopy,
  predictionAllowance,
  redact,
  splitByAllowance,
  type Tier,
} from "../src/lib/entitlements";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

const TIERS: Tier[] = ["anonymous", "free", "premium"];

// ---- the headline numbers
check("a free account gets three per sport", FREE_PREDICTIONS_PER_SPORT === 3);
check("a signed-out visitor gets none", ANONYMOUS_PREDICTIONS === 0);
check("premium is unlimited", isUnlimited("premium"));
check("free is not unlimited", !isUnlimited("free"));
check("anonymous is not unlimited", !isUnlimited("anonymous"));

// ---- props are premium, with no exceptions
check(
  "only premium sees props",
  canSeeProps("premium") && !canSeeProps("free") && !canSeeProps("anonymous"),
);
check(
  "the parlay follows the props rule, because it is built from props",
  TIERS.every((t) => canSeeParlay(t) === canSeeProps(t)),
);

// ---- the allowance goes to the strongest calls, not the first ones
{
  // Deliberately out of order, so "first three" and "best three" differ.
  const items = [
    { id: "a", p: 0.55 },
    { id: "b", p: 0.91 },
    { id: "c", p: 0.6 },
    { id: "d", p: 0.84 },
    { id: "e", p: 0.72 },
  ];
  const conf = (x: (typeof items)[number]) => x.p;

  const free = splitByAllowance(items, "free", conf);
  const got = [...free.visible].map((i) => items[i].id).sort();
  check(
    "free unlocks the three most confident, not the first three",
    got.join(",") === "b,d,e",
    got.join(","),
  );
  check("and reports the rest as locked", free.lockedCount === 2, `${free.lockedCount}`);

  const prem = splitByAllowance(items, "premium", conf);
  check("premium unlocks everything", prem.visible.size === items.length && prem.lockedCount === 0);

  const anon = splitByAllowance(items, "anonymous", conf);
  check("anonymous unlocks nothing", anon.visible.size === 0, `${anon.visible.size}`);
  check("and everything counts as locked", anon.lockedCount === items.length);
}

// ---- an unpriced item is not a prediction, so it cannot consume the allowance
{
  const items = [
    { id: "unpriced-1", p: null },
    { id: "a", p: 0.8 },
    { id: "unpriced-2", p: null },
    { id: "b", p: 0.7 },
    { id: "c", p: 0.6 },
    { id: "d", p: 0.55 },
  ];
  const free = splitByAllowance(items, "free", (x) => x.p);
  const got = [...free.visible].map((i) => items[i].id).sort();
  check("unpriced fixtures never eat the allowance", got.join(",") === "a,b,c", got.join(","));
  check(
    "and are not counted as locked either — there is nothing to unlock",
    free.lockedCount === 1,
    `${free.lockedCount}`,
  );
}

// ---- a short slate must not manufacture locked items
{
  const items = [{ id: "only", p: 0.7 }];
  const free = splitByAllowance(items, "free", (x) => x.p);
  check(
    "a one-match slate is fully visible on free",
    free.visible.size === 1 && free.lockedCount === 0,
  );
  const empty = splitByAllowance([] as { p: number | null }[], "free", (x) => x.p);
  check("an empty slate locks nothing", empty.visible.size === 0 && empty.lockedCount === 0);
}

// ---- ties must not hand out more than the allowance
{
  const items = Array.from({ length: 8 }, (_, i) => ({ id: String(i), p: 0.7 }));
  const free = splitByAllowance(items, "free", (x) => x.p);
  check(
    "an all-tied slate still unlocks exactly three",
    free.visible.size === FREE_PREDICTIONS_PER_SPORT,
    `${free.visible.size}`,
  );
}

// ---- for a two-way market, confidence is distance from a coin flip
{
  // A 12% call is the same conviction as an 88% one, stated about the other side.
  const items = [
    { id: "strong-away", p: 0.12 },
    { id: "coin-flip", p: 0.51 },
    { id: "strong-home", p: 0.88 },
    { id: "mild", p: 0.6 },
  ];
  const twoWay = (x: (typeof items)[number]) => Math.max(x.p, 1 - x.p);
  const free = splitByAllowance(items, "free", twoWay);
  const got = [...free.visible].map((i) => items[i].id).sort();
  check(
    "a heavy underdog counts as a confident call",
    got.includes("strong-away") && got.includes("strong-home") && !got.includes("coin-flip"),
    got.join(","),
  );
}

// ---- the copy has to change with the tier, or the funnel makes no sense
{
  const anon = lockCopy("anonymous");
  const free = lockCopy("free");
  check("a signed-out visitor is asked to make an account", /account/i.test(anon.cta));
  check("a free account is shown premium instead", /premium/i.test(free.heading + free.cta));
  check("both point somewhere real", anon.href === "/account" && free.href === "/account");
  check(
    "the free allowance is stated in the copy, not hardcoded separately",
    anon.body.includes(String(FREE_PREDICTIONS_PER_SPORT)),
    anon.body,
  );
}

// ---- allowances are ordered, always
check(
  "premium > free > anonymous, on every measure",
  predictionAllowance("premium") > predictionAllowance("free") &&
    predictionAllowance("free") > predictionAllowance("anonymous"),
);

// ---- redact(): the enforcement point
{
  type Row = { id: string; prob: number | null; elo: number | null; team: string };
  const rows: Row[] = [
    { id: "top", prob: 0.9, elo: 300, team: "A" },
    { id: "second", prob: 0.85, elo: 250, team: "B" },
    { id: "third", prob: 0.8, elo: 200, team: "C" },
    { id: "fourth", prob: 0.75, elo: 150, team: "D" },
    { id: "fifth", prob: 0.7, elo: 100, team: "E" },
  ];
  const conf = (r: Row) => r.prob;
  const strip = (r: Row): Row => ({ ...r, prob: null, elo: null });

  const free = redact(rows, "free", conf, strip);
  const locked = free.items.filter((r) => r.locked);
  const open = free.items.filter((r) => !r.locked);

  check("redact keeps every row, so the page shape survives", free.items.length === rows.length);
  check("three open on free", open.length === 3 && free.lockedCount === 2);
  check(
    "a locked row carries NO probability",
    locked.every((r) => r.prob === null),
    JSON.stringify(locked),
  );
  check(
    "and no secondary signal either — an Elo gap reconstructs the pick",
    locked.every((r) => r.elo === null),
  );
  check(
    "but keeps the harmless identifying fields",
    locked.every((r) => typeof r.team === "string" && r.team.length > 0),
  );
  check(
    "a serialised locked row contains no digits from the original",
    !JSON.stringify(locked).includes("0.75") && !JSON.stringify(locked).includes("150"),
    JSON.stringify(locked),
  );
  check(
    "the open rows are the strongest ones",
    open.map((r) => r.id).join(",") === "top,second,third",
  );

  const anon = redact(rows, "anonymous", conf, strip);
  check(
    "anonymous leaks nothing at all",
    anon.items.every((r) => r.prob === null && r.elo === null),
  );
  const prem = redact(rows, "premium", conf, strip);
  check(
    "premium is untouched",
    prem.items.every((r, i) => r.prob === rows[i].prob && r.elo === rows[i].elo && !r.locked),
  );

  // An unpriced row is not a prediction: it must not be marked locked, and it
  // must not be stripped (there is nothing there to strip).
  const withNull = redact(
    [{ id: "x", prob: null, elo: null, team: "Z" }, ...rows],
    "free",
    conf,
    strip,
  );
  check("an unpriced row is not reported as locked", withNull.items[0].locked === false);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
