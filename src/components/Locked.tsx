import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { lockCopy, FREE_PREDICTIONS_PER_SPORT, type Tier } from "@/lib/entitlements";

/**
 * The lock.
 *
 * `Blurred` covers content the server has ALREADY withheld — the numbers under
 * the blur are not in the payload, they were stripped before it was built. What
 * stays visible is the shape: which teams, how many fixtures, what the page
 * would look like. That is deliberate. A wall that shows nothing gives nobody a
 * reason to sign up, and a blur over real data would not be a wall at all.
 *
 * So the placeholder digits below are literally decoration. They are drawn from
 * nothing and mean nothing, which is why they are the same on every card rather
 * than randomised to look plausible — pretending to blur a real number the
 * viewer is not entitled to would be a lie about what is being withheld.
 */

export function Blurred({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none select-none blur-[6px] saturate-50" aria-hidden>
      {children}
    </div>
  );
}

/** The stand-in a locked probability leaves behind. */
export function LockedNumber({ size = "text-3xl" }: { size?: string }) {
  return <span className={`font-display ${size} text-muted-foreground/40`}>••%</span>;
}

/**
 * The upgrade prompt. One component, two audiences: a signed-out visitor is
 * asked to make an account, a free account is told what premium adds.
 */
export function UpgradePrompt({
  tier,
  lockedCount,
  what = "predictions",
  compact = false,
}: {
  tier: Tier;
  lockedCount?: number;
  /** What is behind the wall here, for the sentence. */
  what?: string;
  compact?: boolean;
}) {
  const copy = lockCopy(tier);
  return (
    <div className={`border border-primary/40 bg-primary/5 ${compact ? "px-5 py-4" : "px-6 py-6"}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-display text-xl text-foreground">{copy.heading}</div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {lockedCount != null && lockedCount > 0 && (
              <>
                <strong className="text-foreground">
                  {lockedCount} more {lockedCount === 1 ? what.replace(/s$/, "") : what}
                </strong>{" "}
                on this page.{" "}
              </>
            )}
            {copy.body}
          </p>
        </div>
        <Link
          to={copy.href}
          className="shrink-0 border border-primary bg-primary/10 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-primary transition-colors hover:bg-primary/20"
        >
          {copy.cta}
        </Link>
      </div>
    </div>
  );
}

/**
 * A whole page behind the wall — used for player props, which are premium at
 * every tier below premium and are never partially unlocked.
 */
export function PremiumWall({
  tier,
  title,
  children,
}: {
  tier: Tier;
  title: string;
  children?: ReactNode;
}) {
  const signedOut = tier === "anonymous";
  return (
    <div className="border border-border bg-card">
      <div className="border-b border-border px-6 py-6">
        <div className="font-mono text-[11px] uppercase tracking-widest text-primary">Premium</div>
        <h2 className="mt-2 font-display text-3xl">{title}</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Player props are premium only. Not a preview, not a daily allowance — the whole board,
          every market, or none of it.{" "}
          {signedOut
            ? `A free account is still worth making: it opens the ${FREE_PREDICTIONS_PER_SPORT} strongest match calls on every sport, every day.`
            : `Your free account covers the ${FREE_PREDICTIONS_PER_SPORT} strongest match calls per sport per day, which props are not part of.`}
        </p>
        <Link
          to="/account"
          className="mt-4 inline-block border border-primary bg-primary/10 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-primary transition-colors hover:bg-primary/20"
        >
          {signedOut ? "Create a free account" : "See premium"}
        </Link>
      </div>
      {children && <div className="px-6 py-6">{children}</div>}
    </div>
  );
}

/** Small tier chip for the nav. */
export function TierBadge({ tier }: { tier: Tier }) {
  if (tier === "anonymous") return null;
  const premium = tier === "premium";
  return (
    <span
      className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
        premium ? "border-primary text-primary" : "border-border text-muted-foreground"
      }`}
    >
      {premium ? "Premium" : "Free"}
    </span>
  );
}
