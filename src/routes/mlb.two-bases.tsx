import { createFileRoute, redirect } from "@tanstack/react-router";

/** The 2+ bases board is now a board on the MLB Props page; the address is kept for bookmarks. */
export const Route = createFileRoute("/mlb/two-bases")({
  beforeLoad: () => {
    throw redirect({ to: "/mlb/props", search: { board: "two-bases" }, replace: true });
  },
});
