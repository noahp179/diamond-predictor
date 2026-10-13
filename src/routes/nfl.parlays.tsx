import { createFileRoute, redirect } from "@tanstack/react-router";

/** TD parlays are now a board on the NFL Props page; the address is kept for bookmarks. */
export const Route = createFileRoute("/nfl/parlays")({
  beforeLoad: () => {
    throw redirect({ to: "/nfl/props", search: { board: "parlays" }, replace: true });
  },
});
