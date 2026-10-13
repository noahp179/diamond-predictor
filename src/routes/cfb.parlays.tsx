import { createFileRoute, redirect } from "@tanstack/react-router";

/** TD parlays are now a board on the CFB Props page; the address is kept for bookmarks. */
export const Route = createFileRoute("/cfb/parlays")({
  beforeLoad: () => {
    throw redirect({ to: "/cfb/props", search: { board: "parlays" }, replace: true });
  },
});
