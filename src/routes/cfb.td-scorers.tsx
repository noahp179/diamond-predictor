import { createFileRoute, redirect } from "@tanstack/react-router";

/** TD scorers are now a board on the CFB Props page; the address is kept for bookmarks. */
export const Route = createFileRoute("/cfb/td-scorers")({
  beforeLoad: () => {
    throw redirect({ to: "/cfb/props", search: { board: "td-scorers" }, replace: true });
  },
});
