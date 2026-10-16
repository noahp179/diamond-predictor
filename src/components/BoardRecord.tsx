import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { RecordHeadline } from "@/components/RecordHeadline";
import { getBoardRecord, type BoardRecordData } from "@/lib/tracking.functions";

/**
 * "How have these picks actually done?" — for any prop board, in words first.
 *
 * Every board's record reduces to two numbers anyone can compare: how often
 * its picks hit, and how often it SAID they would (the average probability it
 * printed on them). A board that says 60% and hits 60% is doing its job,
 * whatever the number is; one that says 60% and hits 45% is not. So that is
 * the headline, then the same comparison per bet type as a bar (what hit) with
 * a tick (what we said), then the latest results.
 *
 * Nothing here is a backtest: every row was written down before its game and
 * scored after it (see the ledgers in src/lib/*-ledger.server.ts).
 */

const pct = (x: number | null | undefined, d = 0) =>
  x == null || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(d)}%`;

export function BoardRecord({ sport, board }: { sport: string; board: string }) {
  const run = useServerFn(getBoardRecord);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["board-record", sport, board],
    queryFn: () => run({ data: { sport, board } }),
    staleTime: 5 * 60_000,
  });

  return (
    <section className="mt-12 border border-border bg-card" aria-labelledby="board-record">
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <h2 id="board-record" className="font-display text-2xl">
          How these picks have actually done
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every pick is written down before its game starts and checked against the box score after.
          Nothing is re-run or back-filled.
        </p>
      </div>
      {isLoading && <div className="h-40 animate-pulse" />}
      {(isError || data?.status === "unreadable") && (
        <p className="px-6 py-6 text-sm text-muted-foreground">
          The record could not be read just now. Try refreshing.
        </p>
      )}
      {data?.status === "not-provisioned" && (
        <p className="px-6 py-6 text-sm text-muted-foreground">
          This board&apos;s record table has not been created in the database yet, so nothing is
          being saved. See SETUP-TRACKING.md.
        </p>
      )}
      {data?.status === "ok" && <Body d={data} />}
    </section>
  );
}

function Body({ d }: { d: BoardRecordData }) {
  if (d.n === 0)
    return (
      <div className="px-5 py-6 text-sm text-muted-foreground sm:px-6">
        <p>
          <strong className="text-foreground">No finished {d.unit} yet.</strong>{" "}
          {d.pending > 0
            ? `${d.pending} ${d.unit} are written down and waiting for their games to finish.`
            : "The first ones are written down the morning of the next game."}
        </p>
        {d.note && <p className="mt-2">{d.note}</p>}
      </div>
    );

  return (
    <div>
      <RecordHeadline
        hits={d.hits}
        n={d.n}
        unit={d.unit}
        verb="hit"
        expected={d.expected}
        footnote={
          <>
            {d.firstDate && d.lastDate ? `${d.firstDate} to ${d.lastDate}` : ""}
            {d.pending ? ` · ${d.pending} waiting on results` : ""}
            {d.voided ? ` · ${d.voided} void (player did not play)` : ""}
          </>
        }
      />

      {d.byType.length > 0 && (
        <div className="border-t border-border px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="font-display text-xl">By bet type</h3>
            <Legend />
          </div>
          <ul className="mt-4 space-y-3">
            {d.byType.map((t) => (
              <TypeRow key={t.label} t={t} />
            ))}
          </ul>
        </div>
      )}

      {d.recent.length > 0 && (
        <details className="group border-t border-border">
          <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 sm:px-6">
            <span className="font-display text-xl">Latest results</span>
            <span className="font-mono text-xs text-muted-foreground group-open:rotate-180">▼</span>
          </summary>
          <ol className="border-t border-border">
            {d.recent.map((r, i) => (
              <li
                key={i}
                className="grid grid-cols-[5.5rem_1fr_auto_4.5rem] items-baseline gap-3 border-t border-border/40 px-5 py-2 text-sm first:border-t-0 sm:px-6"
              >
                <span className="font-mono text-[11px] text-muted-foreground">{r.date}</span>
                <span className="min-w-0 truncate">
                  <span className="text-foreground">{r.who}</span>{" "}
                  <span className="text-muted-foreground">{r.what}</span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  said {pct(r.prob)}
                </span>
                <Result r={r.result} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** A bullet bar: the fill is how often it hit, the tick is what we said. */
function TypeRow({ t }: { t: BoardRecordData["byType"][number] }) {
  const hit = t.n ? t.hits / t.n : 0;
  const said = t.expected ?? 0;
  return (
    <li>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <span className="text-foreground">{t.label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          hit <span className="text-foreground">{pct(hit)}</span> · said {pct(said)} · {t.hits} of{" "}
          {t.n}
        </span>
      </div>
      <div
        className="relative mt-1.5 h-2.5 w-full rounded-full bg-secondary"
        role="img"
        aria-label={`${t.label}: hit ${pct(hit)}, the board said ${pct(said)}, ${t.hits} of ${t.n}`}
        title={`${t.label}: hit ${pct(hit)} (${t.hits} of ${t.n}) · the board said ${pct(said)}`}
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.max(0, Math.min(1, hit)) * 100}%` }}
        />
        <div
          className="absolute -top-1 h-[18px] w-0.5 bg-foreground"
          style={{ left: `calc(${Math.max(0, Math.min(1, said)) * 100}% - 1px)` }}
          aria-hidden
        />
      </div>
    </li>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 font-mono text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-5 rounded-full bg-primary" aria-hidden /> how often it
        hit
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3.5 w-0.5 bg-foreground" aria-hidden /> what the board said
      </span>
    </div>
  );
}

export function Result({ r }: { r: BoardRecordData["recent"][number]["result"] }) {
  const map = {
    hit: { t: "✓ Hit", c: "text-emerald-500" },
    miss: { t: "✗ Miss", c: "text-red-500" },
    void: { t: "Void", c: "text-muted-foreground" },
    pending: { t: "Pending", c: "text-muted-foreground" },
  } as const;
  return <span className={`text-right font-mono text-[11px] ${map[r].c}`}>{map[r].t}</span>;
}
