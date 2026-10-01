import { createFileRoute, redirect } from "@tanstack/react-router";

/** /nhl has no slate page of its own yet; the simulator is the section. */
export const Route = createFileRoute("/nhl/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/nhl/simulate", search, replace: true });
  },
});
