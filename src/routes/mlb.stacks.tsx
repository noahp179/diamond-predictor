import { createFileRoute, redirect } from "@tanstack/react-router";

/** Team stacks are now a board on the MLB Props page; the address is kept for bookmarks. */
export const Route = createFileRoute("/mlb/stacks")({
  beforeLoad: () => {
    throw redirect({ to: "/mlb/props", search: { board: "stacks" }, replace: true });
  },
});
