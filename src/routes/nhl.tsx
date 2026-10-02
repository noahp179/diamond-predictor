import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /nhl. Hockey has no picks model yet, so its one view is the
 *  game simulator; each child renders its own full page frame. */
export const Route = createFileRoute("/nhl")({
  component: () => <Outlet />,
});
