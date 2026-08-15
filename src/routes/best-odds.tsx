import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy path from when MLB was the whole site. Redirects to /mlb/best-odds so the
 * links people saved and shared keep working; see LEGACY_REDIRECTS in
 * src/lib/nav.ts, which scripts/test-nav.ts checks against the route tree.
 */
export const Route = createFileRoute("/best-odds")({
  beforeLoad: () => {
    throw redirect({ to: "/mlb/best-odds", replace: true });
  },
});
