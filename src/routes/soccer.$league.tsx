import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for one competition's pages (matches, props, model). */
export const Route = createFileRoute("/soccer/$league")({
  component: () => <Outlet />,
});
