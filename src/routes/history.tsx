import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy path from when MLB was the whole site. Redirects to /mlb/track-record so the
 * links people saved and shared keep working; see LEGACY_REDIRECTS in
 * src/lib/nav.ts, which scripts/test-nav.ts checks against the route tree.
 */
export const Route = createFileRoute("/history")({
  beforeLoad: () => {
    throw redirect({ to: "/mlb/track-record", replace: true });
  },
});
