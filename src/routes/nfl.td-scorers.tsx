import { createFileRoute, redirect } from "@tanstack/react-router";

/** TD scorers are now a board on the NFL Props page; the address is kept for bookmarks. */
export const Route = createFileRoute("/nfl/td-scorers")({
  beforeLoad: () => {
    throw redirect({ to: "/nfl/props", search: { board: "td-scorers" }, replace: true });
  },
});
