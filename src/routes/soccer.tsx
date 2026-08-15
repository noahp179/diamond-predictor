import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /soccer and its league pages. Each league renders its own shell,
 *  so this is only a mount point for the nested routes. */
export const Route = createFileRoute("/soccer")({
  component: () => <Outlet />,
});
