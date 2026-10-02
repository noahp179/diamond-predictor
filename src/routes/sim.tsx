import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for /sim and its league pages. Each child renders its own frame. */
export const Route = createFileRoute("/sim")({
  component: () => <Outlet />,
});
