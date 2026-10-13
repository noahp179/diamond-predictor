import { createFileRoute, redirect } from "@tanstack/react-router";

/** The base parlays are now a board on the MLB Props page; the address is kept for bookmarks. */
export const Route = createFileRoute("/mlb/parlays")({
  beforeLoad: () => {
    throw redirect({ to: "/mlb/props", search: { board: "parlays" }, replace: true });
  },
});
