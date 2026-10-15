import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { dayLabel } from "@/lib/date";
import { getMlbDay } from "@/lib/sports.functions";

type Day = NonNullable<Awaited<ReturnType<typeof getMlbDay>>>;

/** Why the day has nothing on the boards, from what MLB actually played. */
function reasonOf(day: Day): { title: string; body: string } | null {
  if (day.games > 0) return null;
  const when = dayLabel(day.date);
  if (day.other.length === 0) {
    return {
      title: `No MLB games on ${when}`,
      body: "Nothing is on the schedule that day. Pick another date above.",
    };
  }
  const title = `No regular-season or playoff games on ${when}`;
  if (day.other.some((g) => g.kind === "allstar")) {
    return {
      title,
      body: `${when} is the All-Star Game, which the boards skip. They pick up again when the regular season resumes.`,
    };
  }
  return {
    title,
    body:
      `${when} is spring training — ${day.other.length} game${day.other.length === 1 ? "" : "s"}. ` +
      "Spring lineups and innings are trial runs, so the boards wait for Opening Day.",
  };
}

/**
 * The empty state for every MLB prop board. "Nothing here" can mean no games,
 * or only spring-training / All-Star games the boards don't price — this says
 * which. When the day does have regular-season or playoff games, the board's
 * own message (lineups, early-season history) is the real reason and is shown
 * instead.
 */
export function MlbNoGames({
  date,
  title,
  reason,
}: {
  date: string;
  title: string;
  reason: string;
}) {
  const run = useServerFn(getMlbDay);
  const { data, isLoading } = useQuery({
    queryKey: ["mlb", "day", date],
    queryFn: () => run({ data: { date } }),
    staleTime: 10 * 60_000,
  });
  if (isLoading) return <div className="h-40 animate-pulse border border-border bg-card" />;
  const why = (data && reasonOf(data)) ?? { title, body: reason };
  return (
    <div className="border border-border bg-card p-10 text-center">
      <div className="font-display text-3xl">{why.title}</div>
      <p className="mx-auto mt-2 max-w-2xl font-mono text-sm text-muted-foreground">{why.body}</p>
    </div>
  );
}
