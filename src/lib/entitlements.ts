/**
 * entitlements.ts — who can see what.
 *
 * Shared by client and server so the UI and the redaction agree on one set of
 * rules. The server is what actually enforces them: locked predictions are
 * stripped from the response before it is serialised, so a free user's payload
 * never contains the hidden probabilities. The blur in the UI is a visual
 * affordance over data that was already withheld — it is not the lock.
 *
 * That distinction is the whole design. A blur implemented in CSS over a full
 * payload is not a paywall; it is an inconvenience for anyone who opens the
 * network tab.
 */

export type Tier = "anonymous" | "free" | "premium";

/**
 * Match-outcome predictions a free account sees per sport, per day.
 *
 * Three, and they are the three the model is SUREST about rather than the first
 * three chronologically. That is deliberate: the free tier should be the good
 * part of the product, not a leftover. It also makes the allowance
 * deterministic — the same three all day, no usage counter to keep, nothing to
 * reset by clearing cookies, and no way to reroll for a better pick.
 */
export const FREE_PREDICTIONS_PER_SPORT = 3;

/**
 * A signed-out visitor sees none. Accounts are the price of the free tier, and
 * a paywall that can be bypassed by opening a private window is not one.
 *
 * They still see the shape of everything — how many matches, which teams, the
 * whole page — with the numbers withheld, because a wall that shows nothing
 * gives nobody a reason to sign up.
 */
export const ANONYMOUS_PREDICTIONS = 0;

/** Player props are premium, always. Never partially unlocked, never previewed. */
export function canSeeProps(tier: Tier): boolean {
  return tier === "premium";
}

/** Parlays are built out of props, so they inherit the props rule. */
export function canSeeParlay(tier: Tier): boolean {
  return canSeeProps(tier);
}

/** How many match predictions this tier may see on one sport's slate. */
export function predictionAllowance(tier: Tier): number {
  if (tier === "premium") return Number.POSITIVE_INFINITY;
  if (tier === "free") return FREE_PREDICTIONS_PER_SPORT;
  return ANONYMOUS_PREDICTIONS;
}

export function isUnlimited(tier: Tier): boolean {
  return predictionAllowance(tier) === Number.POSITIVE_INFINITY;
}

/**
 * Split a list of predictions into what this tier may see and what it may not.
 *
 * `confidence` ranks them: the allowance goes to the strongest calls. Items
 * without a usable confidence (an unpriced fixture, a match with no rating
 * history) sort last and are never spent from the allowance, because there is
 * nothing there to unlock.
 *
 * Returns indices rather than the items themselves so callers can redact in
 * place and keep their own row shape.
 */
export function splitByAllowance<T>(
  items: T[],
  tier: Tier,
  confidence: (item: T) => number | null,
): { visible: Set<number>; lockedCount: number } {
  const allowance = predictionAllowance(tier);
  if (allowance === Number.POSITIVE_INFINITY) {
    return { visible: new Set(items.map((_, i) => i)), lockedCount: 0 };
  }

  const ranked = items
    .map((item, i) => ({ i, c: confidence(item) }))
    .filter((r): r is { i: number; c: number } => r.c != null)
    .sort((a, b) => b.c - a.c);

  const visible = new Set(ranked.slice(0, allowance).map((r) => r.i));
  return { visible, lockedCount: Math.max(ranked.length - visible.size, 0) };
}

/**
 * Redact a list down to what the tier may see.
 *
 * This is THE enforcement point. Every gated endpoint funnels through it, so
 * there is one implementation to get right and one to test — rather than four
 * near-identical loops in four handler files, which is what this replaces.
 *
 * `strip` says what a locked item looks like with its prediction removed. It
 * must actually remove it: returning the item unchanged with a `locked: true`
 * flag would ship the very numbers being sold, and the blur in the UI would be
 * decoration over a full payload.
 */
export function redact<T>(
  items: T[],
  tier: Tier,
  confidence: (item: T) => number | null,
  strip: (item: T) => T,
): { items: (T & { locked: boolean })[]; lockedCount: number; allowance: number } {
  const { visible, lockedCount } = splitByAllowance(items, tier, confidence);
  return {
    items: items.map((item, i) =>
      visible.has(i) || confidence(item) == null
        ? { ...item, locked: false }
        : { ...strip(item), locked: true },
    ),
    lockedCount,
    allowance: predictionAllowance(tier),
  };
}

/** Copy for the lock, kept in one place so every surface says the same thing. */
export function lockCopy(tier: Tier) {
  if (tier === "anonymous") {
    return {
      heading: "Create a free account to see this",
      body: `A free account unlocks the ${FREE_PREDICTIONS_PER_SPORT} strongest calls on every sport, every day. No card, no trial timer.`,
      cta: "Create a free account",
      href: "/account",
    };
  }
  return {
    heading: "Premium",
    body: `Free accounts see the ${FREE_PREDICTIONS_PER_SPORT} strongest calls per sport each day. Premium opens the full slate and every player-prop market.`,
    cta: "See premium",
    href: "/account",
  };
}
