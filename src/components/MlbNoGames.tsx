import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";

import { dayLabel } from "@/lib/date";
import { getMlbDay } from "@/lib/sports.functions";

type Day = NonNullable<Awaited<ReturnType<typeof getMlbDay>>>;

const AND = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** Why the day has nothing on the boards, from what MLB actually played. */
function reasonOf(day: Day): { title: string; body: string } | null {
  if (day.regular > 0) return null;
  const when = dayLabel(day.date);
  if (day.other.length === 0) {
    return {
      title: `No MLB games on ${when}`,
      body: "Nothing is on the schedule that day. Pick another date above.",
    };
  }
  const games = AND(day.other.map((g) => (g.label ? `${g.label} (${g.matchup})` : g.matchup)));
  const kinds = new Set(day.other.map((g) => g.kind));
  const title = `No regular-season games on ${when}`;
  if (kinds.has("playoffs")) {
    return {
      title,
      body:
        `${when} is playoff baseball: ${games}. These boards are built on regular-season ` +
        "form and tracked over the regular season only, so they sit out the postseason " +
        "and pick up again next season.",
    };
  }
  if (kinds.has("allstar")) {
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
 * The empty state for every MLB prop board. The boards read the regular season
 * only, so "nothing here" can mean no games, or playoff / spring / All-Star
 * games the models don't cover — this says which. When the day does have
 * regular-season games, the board's own message (lineups, early-season
 * history) is the real reason and is shown instead.
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
