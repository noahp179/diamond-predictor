import type { ReactNode } from "react";

import { SoccerShell } from "@/components/SoccerShell";
import { Stat, StatBar } from "@/components/SportShell";
import { SOCCER_SIM } from "@/lib/sim/soccer";
import { UCL_MODEL } from "@/lib/ucl-model";

/**
 * The Champions League's Model & Backtest page. Static: everything comes from
 * the frozen files research/ucl wrote, so it always matches what the site
 * predicts with — including the comparisons it does not win and the change
 * that was made after the first backtest was seen.
 */

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const f4 = (x: number) => x.toFixed(4);

type Score = { n: number; rps: number; logloss: number; brier: number; acc: number };

const ROWS: { key: string; label: string; note: string }[] = [
  {
    key: "goals",
    label: "Cross-league Elo → scorelines (shipped)",
    note: "Poisson goal rates with Champions League terms, Dixon-Coles corrected",
  },
  {
    key: "mnl",
    label: "Cross-league Elo → 1X2 directly",
    note: "multinomial logistic on the same gap",
  },
  {
    key: "goals_v1_pooled",
    label: "First version — one mapping for all of Europe",
    note: "no Champions League terms; replaced after this backtest (see below)",
  },
  {
    key: "domestic_only",
    label: "Domestic Elo only",
    note: "each league an island, the way the five league models work",
  },
  { key: "base_rates", label: "Base rates", note: "prior seasons' home/draw/away frequencies" },
];

export function UclModelPage() {
  const bt = UCL_MODEL.backtest;
  const shipped = bt.pooled.goals;
  const base = bt.pooled.base_rates;
  const sim = SOCCER_SIM.backtest as
    | {
        n: number;
        simulator: Score;
        scoreline_model: Score;
        goals_sim: number;
        goals_actual: number;
        draw_sim: number;
        draw_actual: number;
        over25_sim: number;
        over25_actual: number;
        btts_sim: number;
        btts_actual: number;
      }
    | undefined;
  const sl = bt.scorelines;
  const e = UCL_MODEL.elo;

  return (
    <SoccerShell
      league="ucl"
      current="model"
      eyebrow="Diamond Edge · Champions League"
      title="Model & Backtest"
      blurb="How the Champions League numbers are made and how they scored on nine seasons the model was never fitted on: 1,253 matches, 2017-18 to 2025-26, each priced with only what was known the morning it was played. Including what it does not beat, and the one change made after the first backtest."
      statBar={
        <StatBar>
          <Stat label="Held-out RPS" value={f4(shipped.rps)} />
          <Stat label="Called right" value={pct(shipped.acc)} />
          <Stat label="Base rates RPS" value={f4(base.rps)} />
          <Stat label="Test matches" value={shipped.n.toLocaleString()} />
        </StatBar>
      }
      footerNote="Research · research/ucl · fetch_ucl.py → tune_ucl.py → backtest_ucl.py → ship_ucl.py → sim_ucl.py"
    >
      <Section title="What ships">
        <p>
          <strong className="text-foreground">One Elo for every club in Europe.</strong> Champions
          League clubs come from twenty leagues and meet each other six to fifteen times a season,
          so a league table cannot rank them. The model replays about 91,000 matches since 2013 —
          twenty-two domestic leagues plus all three UEFA competitions and their qualifiers —
          through one rating. Domestic results rank clubs within their league; European results move
          whole leagues against each other (they count {e.eu_mult}× as much, because that is where
          the information about league strength is). Between seasons each club moves{" "}
          {pct(1 - e.carry, 0)} of the way back to its league&apos;s mean, not to a global one.
        </p>
        <p>
          <strong className="text-foreground">The rating gap becomes goals.</strong> A Poisson model
          gives each side a 90-minute goal rate from the gap, home advantage and two Champions
          League terms; a Dixon-Coles correction fixes the low scores. That one scoreline matrix
          gives home, draw and away, over/under, both-teams-to-score and the likeliest scores — and
          it is what the simulator plays.
        </p>
        <KV
          rows={[
            ["K (domestic / European)", `${e.k} / ${e.k * e.eu_mult}`],
            ["Home advantage", `${e.hfa} Elo points`],
            ["Goal-difference exponent", String(e.gd_exp)],
            ["Season carry-over", String(e.carry)],
            ["New club, European competition only", `${e.euro_prior}`],
            ["Dixon-Coles ρ", UCL_MODEL.goals.rho.toFixed(4)],
            [
              "Goal mapping fitted on",
              `${UCL_MODEL.goals.nTrain.toLocaleString()} European matches, 2014-15 to ${UCL_MODEL.goals.trainedThrough}-${(UCL_MODEL.goals.trainedThrough + 1) % 100}`,
            ],
          ]}
        />
        <p>
          The Elo constants were tuned on 2014-15 to 2016-17 only (every European match, about
          2,100), before the first test season. Nothing from 2017-18 on chose a constant.
        </p>
      </Section>

      <Section title="Against the alternatives — 1,253 matches, 2017-18 to 2025-26">
        <table className="w-full font-mono text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1.5 font-normal">Model</th>
              <th className="py-1.5 text-right font-normal">RPS</th>
              <th className="py-1.5 text-right font-normal">Log loss</th>
              <th className="py-1.5 text-right font-normal">Brier</th>
              <th className="py-1.5 text-right font-normal">Right</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => {
              const s = bt.pooled[r.key];
              if (!s) return null;
              return (
                <tr
                  key={r.key}
                  className={`border-t border-border/50 ${r.key === "goals" ? "text-foreground" : ""}`}
                >
                  <td className="py-1.5">
                    {r.label}
                    <div className="text-[10px] text-muted-foreground">{r.note}</div>
                  </td>
                  <td className="py-1.5 text-right">{f4(s.rps)}</td>
                  <td className="py-1.5 text-right">{f4(s.logloss)}</td>
                  <td className="py-1.5 text-right">{f4(s.brier)}</td>
                  <td className="py-1.5 text-right">{pct(s.acc)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p>
          RPS is the ranked probability score, summed over the two cumulative splits — the same
          scale as the five league models (halve it for the literature&apos;s convention). Lower is
          better. The European links are worth{" "}
          <strong className="text-foreground">
            {f4(bt.pooled.domestic_only.rps - shipped.rps)} RPS and{" "}
            {((shipped.acc - bt.pooled.domestic_only.acc) * 100).toFixed(1)} points of accuracy
          </strong>{" "}
          over rating each league on its own — the gap between a model of the Champions League and
          five domestic models stitched together.
        </p>
        <p>
          <strong className="text-foreground">One change was made after looking.</strong> The first
          version fitted one goal mapping to every European match, qualifiers included. Its backtest
          showed the Champions League proper is different — 3.12 goals a match against 2.71
          predicted, 19% draws against 24%, favourites winning more than priced — so the mapping
          gained two Champions League terms, the same way each domestic league gets its own
          calibration. Both versions are in the table; the change is worth{" "}
          {f4(bt.pooled.goals_v1_pooled.rps - shipped.rps)} RPS. It was chosen after seeing the test
          seasons, so treat that particular gain with the suspicion a post-hoc change deserves.
        </p>
      </Section>

      <Section title="Season by season">
        <table className="w-full font-mono text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1.5 font-normal">Season</th>
              <th className="py-1.5 text-right font-normal">Matches</th>
              <th className="py-1.5 text-right font-normal">RPS</th>
              <th className="py-1.5 text-right font-normal">Right</th>
              <th className="py-1.5 text-right font-normal">Domestic-only RPS</th>
              <th className="py-1.5 text-right font-normal">Base-rate RPS</th>
            </tr>
          </thead>
          <tbody>
            {bt.perSeason.map((r) => {
              const g = r.goals as Score;
              const d = r.domestic_only as Score;
              const b = r.base_rates as Score;
              const live = r.season > UCL_MODEL.goals.trainedThrough;
              return (
                <tr key={r.season} className="border-t border-border/50">
                  <td className="py-1.5">
                    {r.season}-{String((r.season + 1) % 100).padStart(2, "0")}
                    {live && <span className="text-muted-foreground"> · to date</span>}
                  </td>
                  <td className="py-1.5 text-right">{r.n}</td>
                  <td className="py-1.5 text-right text-foreground">{f4(g.rps)}</td>
                  <td className="py-1.5 text-right">{pct(g.acc)}</td>
                  <td className="py-1.5 text-right">{f4(d.rps)}</td>
                  <td className="py-1.5 text-right">{f4(b.rps)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p>
          Each season is priced by a mapping fitted on the seasons before it. 2026-27 has only begun
          {bt.live
            ? ` — ${bt.live.n} matches before the cut-off, far too few to read anything into: ${pct(bt.live.acc, 0)} on ${bt.live.n} matches is luck as much as skill.`
            : "."}
        </p>
      </Section>

      <Section title="Calibration — when the favourite is priced at X, does it win X of the time?">
        <table className="w-full font-mono text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1.5 font-normal">Favourite priced at</th>
              <th className="py-1.5 text-right font-normal">Matches</th>
              <th className="py-1.5 text-right font-normal">Predicted</th>
              <th className="py-1.5 text-right font-normal">Happened</th>
            </tr>
          </thead>
          <tbody>
            {bt.calibration.map((c) => (
              <tr key={c.lo} className="border-t border-border/50">
                <td className="py-1.5">
                  {pct(c.lo, 0)} – {pct(c.hi, 0)}
                </td>
                <td className="py-1.5 text-right">{c.n}</td>
                <td className="py-1.5 text-right">{pct(c.predicted)}</td>
                <td className="py-1.5 text-right text-foreground">{pct(c.actual)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Close through the middle; favourites priced 65-85% won somewhat more often than priced.
          The model is, if anything, a little timid about big favourites.
        </p>
      </Section>

      <Section title="Scorelines — what the simulator inherits">
        <KV
          rows={[
            [
              "Goals a match: model / actual",
              `${sl.goals_pred.toFixed(2)} / ${sl.goals_actual.toFixed(2)}`,
            ],
            ["Draws: model / actual", `${pct(sl.draw_pred)} / ${pct(sl.draw_actual)}`],
            ["Over 2.5: model / actual", `${pct(sl.over25_pred)} / ${pct(sl.over25_actual)}`],
            ["Both score: model / actual", `${pct(sl.btts_pred)} / ${pct(sl.btts_actual)}`],
            [
              "Over 2.5 Brier: model / base rate",
              `${f4(sl.over25_brier)} / ${f4(sl.over25_brier_base)}`,
            ],
            ["Likeliest score was the score", pct(sl.likely_score_hit)],
          ]}
        />
        <p>
          The closed-form model is light on goals — it was fitted on seasons that scored less than
          the Champions League does now — and its over/under is no better than the base rate. It
          knows who is stronger, not who plays open football. Treat its totals with that in mind.
        </p>
      </Section>

      {sim && (
        <Section title="The simulator, backtested">
          <p>
            Every one of the {sim.n.toLocaleString()} test matches was played 4,000 times from its
            walk-forward goal rates, with the simulator&apos;s minute, game-state and red-card
            effects refitted on 2014-15 to 2016-17 only — so neither the rates nor the effects had
            seen the matches.
          </p>
          <KV
            rows={[
              [
                "RPS: simulator / closed form",
                `${f4(sim.simulator.rps)} / ${f4(sim.scoreline_model.rps)}`,
              ],
              [
                "Log loss: simulator / closed form",
                `${f4(sim.simulator.logloss)} / ${f4(sim.scoreline_model.logloss)}`,
              ],
              ["Called right: simulator", pct(sim.simulator.acc)],
              ["Draws: simulated / actual", `${pct(sim.draw_sim)} / ${pct(sim.draw_actual)}`],
              [
                "Goals a match: simulated / actual",
                `${sim.goals_sim.toFixed(2)} / ${sim.goals_actual.toFixed(2)}`,
              ],
              [
                "Over 2.5: simulated / actual",
                `${pct(sim.over25_sim)} / ${pct(sim.over25_actual)}`,
              ],
              ["Both score: simulated / actual", `${pct(sim.btts_sim)} / ${pct(sim.btts_actual)}`],
            ]}
          />
          <p>
            Same RPS as the closed form, better log loss, and it gets the draw rate right where the
            closed form does not: level matches are the open ones (a side that leads or trails
            scores about 16% less than at level), so fewer of them end level. The effects it plays
            with:
          </p>
          <KV
            rows={[
              [
                "Minute effect (1-15, 16-30, 31-44, 45+, 46-60, 61-75, 76-89, 90+)",
                SOCCER_SIM.bucket.map((b) => Math.exp(b).toFixed(2)).join(" · "),
              ],
              [
                "Scoring when −2 / −1 / level / +1 / +2",
                ["-2", "-1", "0", "1", "2"]
                  .map((k) => Math.exp(SOCCER_SIM.state[k] ?? 0).toFixed(2))
                  .join(" · "),
              ],
              [
                "Scoring a man down / up",
                `${Math.exp(SOCCER_SIM.man["-1"]).toFixed(2)} · ${Math.exp(SOCCER_SIM.man["1"]).toFixed(2)}`,
              ],
              ["Extra time scores at", `${SOCCER_SIM.etFactor.toFixed(2)}× the 90-minute rate`],
              [
                "Shoot-outs",
                `coin toss (hosts won ${pct(SOCCER_SIM.shootoutSample.homeWon)} of ${SOCCER_SIM.shootoutSample.n})`,
              ],
            ]}
          />
        </Section>
      )}

      <Section title="Honest limits">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>
            <strong className="text-foreground">No market benchmark in the backtest.</strong> ESPN
            posts 1X2 prices before a match and drops them afterwards, so there are no historical
            closing lines to score against. The market sits next to every live fixture, and the
            forward ledger on the Track Record page is where model-versus-market will be settled.
          </li>
          <li>
            <strong className="text-foreground">Some leagues are invisible.</strong> ESPN carries no
            domestic feed for Czechia, Ukraine, Croatia, Serbia, Poland, Azerbaijan or Kazakhstan,
            and stopped carrying Switzerland (September 2025) and Israel (May 2025). Those clubs are
            rated from European matches alone — six to sixteen a season — so their ratings are
            noisier and lag their domestic form. Today&apos;s Sabah and Slavia Prague are both in
            this group.
          </li>
          <li>
            <strong className="text-foreground">Ratings know results, not squads.</strong> Injuries,
            rotation before a derby and a new coach reach the model only through later results. The
            simulator&apos;s goalscorers do read ESPN&apos;s injury list.
          </li>
          <li>
            <strong className="text-foreground">Goalscorer shares are per team goal</strong> over
            the last 400 days in all competitions, shrunk toward a position average — a rotation
            player&apos;s share already reflects the matches he sits out, and a summer signing
            starts near the average for his position.
          </li>
        </ul>
      </Section>
    </SoccerShell>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6 border border-border bg-card">
      <h2 className="border-b border-border px-5 py-4 font-display text-2xl">{title}</h2>
      <div className="space-y-3 px-5 py-4 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

function KV({ rows }: { rows: [string, string][] }) {
  return (
    <div className="grid gap-x-8 gap-y-1 font-mono text-[12px] sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 border-b border-border/40 py-1">
          <span>{k}</span>
          <span className="text-right text-foreground tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  );
}
