# Team Stacks — the night's biggest offences, and 2+ total bases, together

Two questions that are usually asked separately, asked as one. Which teams are
about to score the most runs tonight? And which hitters get two or more total
bases? Every model in this repo so far prices a single leg. This one asks what
happens when you put two of them on the same slip — a team total and a bat off
that same lineup — which is not the product of the two prices, because a
hitter's total bases *are* part of his team's runs.

Code lives in `research/mlb-stacks/`; the shipped model is
`src/lib/mlb-stacks-model.json`, served live by `src/lib/mlb-stacks.server.ts`
on the new **Team Stacks** tab.

---

## TL;DR

- **A new team run-scoring model.** Three team-total markets (over 3.5 / 4.5 /
  5.5) plus a runs regression that ranks the slate. Fitted on 2024–25, tested on
  **4,152 held-out 2026 team-games**. Logistic regression wins the bake-off
  again, over twelve rivals.
- **Ranking works better than the AUC suggests.** Team totals only reach
  **AUC 0.55**, but the night's **top-projected offence actually scored 5.46
  runs** against a slate average of 4.48, and the day's single best-rated
  over-3.5 hit **60.5%** against a 55.0% base.
- **The team model adds nothing to the hitter model.** Feeding the team's
  projected offence into the 2+ TB model moves AUC by **+0.0005**
  (95% CI −0.0004 to +0.0016 — a band straddling zero). The prop model already
  carries its team context. *Together does not mean stapling one model's output
  onto the other's features.*
- **It adds a great deal to the hitter model's *joint* with the team.** Across
  **37,303 held-out pairs**, a team clearing 4.5 runs *and* a hitter off that
  lineup getting 2+ total bases happened **20.40%** of the time. Independence
  says **15.28%** — it understates the pair by **25%**. The correlation model
  says **20.55%**, off by **0.7%**.
- **Two hitters in one lineup are almost independent.** The residual
  correlation between two same-lineup 2+ TB outcomes is **+0.043**, against
  **+0.224** between a hitter and his own team's run total. The classic "stack the
  whole lineup" instinct is priced on a correlation that is barely there.
- **Gating helps a little, on its own.** Hitters on the night's top-projected
  offence hit 2+ TB **41.5%** of the time against **35.0%** for every starter,
  and the day's best 2+ TB pick goes from 51.6% to **56.1%** when the board is
  restricted to the five biggest offences.
- Shipped: a **Team Stacks** page that ranks tonight's offences, prices each
  team total, pulls the 2+ TB bats off that lineup from the existing props
  model, and quotes the **correctly correlated** price for the combination
  alongside what independence would have said.

---

## Data

| | |
|---|---|
| Team-games | **13,914** regular-season finals, 2024 → 2026-09-02 |
| Modelled rows | **13,820** (a team's first game of a season has no prior state) |
| Train / test | 2024–25 (**9,668**) → 2026 (**4,152**) |
| Batter rows | **123,895** lineup starters, from the player-prop pipeline |
| Same-lineup hitter pairs, 2026 | **149,780** |
| Team-total × hitter pairs, 2026 | **37,303** |

Team runs come from the schedule endpoint's final score — exact, and three API
calls for three seasons (`fetch_teams.py`). Everything richer is aggregated from
the box scores `research/mlb-props/fetch_props.py` already downloads, so the two
research trees share one fetch.

Features are built by the same strictly chronological walk the prop models use:
a row for game *G* only ever sees games that had already finished. And every one
of them is something the live pipeline can pull from StatsAPI aggregates, so
training and serving compute the *same* numbers — a parity self-test ships in
the model file and agrees to **5.4e-9**.

### Features (30, all reproducible live)

| group | features |
|---|---|
| **own offence, season** | R/G, TB/PA, H/PA, HR/PA, BB/PA, K/PA, ISO (shrunk to league) |
| **own offence, 30 days** | R/G, TB/PA, games in window |
| **own offence, prior season** | R/G, TB/PA, "known" flag |
| **opponent run prevention** | runs allowed/G — season, last 30 days, prior season |
| **opposing starter** | K/BF, H/BF, HR/BF, BB/BF, ER/out, BF per start, known flag |
| **opponent bullpen** | ER/out, K/BF, known flag — *what the other twelve outs look like* |
| **context** | park factor, home/away, days rest, games in the last week |

The bullpen block is the one the player-prop models do not have. A starter is
maybe fifteen of the twenty-seven outs; who pitches the rest is a real part of
whether a team gets to five runs, and StatsAPI serves it directly
(`teams/stats?stats=statSplits&sitCodes=rp`).

---

## The team bake-off — 13 models × 3 markets

Mean AUC on the held-out 2026 season. Two benchmarks are in the race: the team's
own runs per game with nothing else (`base_r_pg`), and the napkin estimate a
sharp bettor would make — team R/G × opponent RA/G ÷ league R/G, park-adjusted,
read off a Poisson tail (`poisson_napkin`).

| # | Model | mean AUC | best market | worst |
|--:|---|--:|--:|--:|
| 1 | **logistic (shipped)** | **0.5547** | 0.5571 (over 5.5) | 0.5517 |
| 2 | logistic + Platt | 0.5547 | 0.5571 | 0.5517 |
| 3 | logistic L1 | 0.5546 | 0.5569 | 0.5517 |
| 4 | STACK (LR + hist-GBM + extra trees) | 0.5542 | 0.5575 | 0.5513 |
| 5 | gradient boosting | 0.5528 | 0.5649 | 0.5398 |
| 6 | MLP (neural net) | 0.5522 | 0.5546 | 0.5483 |
| 7 | extra trees | 0.5522 | 0.5546 | 0.5494 |
| 8 | random forest | 0.5493 | 0.5544 | 0.5452 |
| 9 | kNN (k=200) | 0.5468 | 0.5495 | 0.5438 |
| 10 | gaussian naïve Bayes | 0.5454 | 0.5495 | 0.5424 |
| 11 | hist-GBM | 0.5406 | 0.5557 | 0.5286 |
| 12 | poisson napkin | 0.5405 | 0.5408 | 0.5402 |
| 13 | runs-per-game baseline | 0.5069 | 0.5119 | 0.5031 |

The same shape as every other bake-off in this repo: the plain logistic wins,
the boosted trees do not, and the naïve baseline is not far behind. Two things
are worth reading carefully.

**The napkin is most of the model.** `poisson_napkin` uses three numbers and
lands at 0.5405 against the model's 0.5547. Nearly all of what a thirty-feature
model knows about tonight's run total is "good offence, bad pitching, thin air".

**Runs per game alone is nearly worthless (0.5069).** Knowing a team has scored
a lot is almost no help at all; knowing *who they face tonight* is where the
signal is. That gap — 0.507 to 0.555 — is the whole matchup.

### Per-market (2026 hold-out)

`Top-1 / Top-5` = hit rate of the day's single best / five best rated teams.

| Market | Base | AUC | Top-1 | Top-5 | Strong | Solid | Lean |
|---|--:|--:|--:|--:|--:|--:|--:|
| Team total over 3.5 | 55.0% | 0.555 | **60.5%** | 59.9% | 67.1% | 57.0% | 49.9% |
| Team total over 4.5 | 43.0% | 0.552 | 56.1% | 48.6% | 59.4% | 44.6% | 37.9% |
| Team total over 5.5 | 32.4% | 0.557 | 47.1% | 37.0% | 50.7% | 33.9% | 27.2% |

### Ranking the slate — "who scores tonight"

The runs regression is not a betting market; it is the sort order of the page.
On the held-out season:

| ranked by projected runs | actual runs scored |
|---|--:|
| the night's **top-1** offence | **5.46** |
| top-3 | 5.23 |
| top-5 | 4.98 |
| every team | 4.48 |

Spearman correlation with actual runs is 0.121, RMSE 3.21 — a single baseball
game is mostly noise. But **+0.98 runs on the night's top pick** is a real,
usable ordering, and it is what the Team Stacks board sorts by.

---

## Now the actual question: do the two work together?

### A. Does the team's offence improve the 2+ TB model? No.

The obvious first idea is to feed the team model's output into the hitter model
as a feature. It does nothing:

| 2+ TB model, 2026 hold-out (n = 37,303) | AUC | Brier |
|---|--:|--:|
| the shipped prop model | 0.5744 | 0.2242 |
| + the team's projected offence and total | 0.5749 | 0.2241 |
| **delta** | **+0.0005** (95% CI −0.0004, +0.0016) | — |

And the two-way grid says the same thing. Hit rate of 2+ TB by player-rating
quintile (rows) against team-offence quintile (columns):

| | worst offences | 2 | 3 | 4 | best offences |
|---|--:|--:|--:|--:|--:|
| **worst hitters** | 25.0% | 27.0% | 26.2% | 25.9% | 28.2% |
| 2 | 31.8% | 30.5% | 30.2% | 32.0% | 31.2% |
| 3 | 35.5% | 35.3% | 37.0% | 38.0% | 35.2% |
| 4 | 38.1% | 40.7% | 40.8% | 39.2% | 37.7% |
| **best hitters** | 40.4% | 41.5% | 42.3% | 40.9% | 44.1% |

Read down a column and the hitter rating separates cleanly, 25% to 44%. Read
across a row and almost nothing happens — a **+1.1 point** average gap between
the best and worst offence columns. The reason is not that team context is
irrelevant; it is that the prop model *already has it*: `team_r_pg` and
`opp_r_allowed_pg` are two of its thirty features. Adding a second, better
estimate of a thing it already knows is not new information.

**This is the first result, and it is a negative one.** "Use the team model to
pick better hitters" does not work.

### B. Do they work together as a *bet*? Emphatically yes.

The right question is not whether one model improves the other's ranking, but
whether the two events are independent. They are not:

| residual correlation of 2+ TB | r | pairs |
|---|--:|--:|
| two hitters in the **same lineup** | **+0.043** | 497,808 |
| two hitters in **different games** the same night | +0.003 | 124,081 |
| a hitter and **his own team's 5+ runs** | **+0.224** | 124,171 |

(The different-games row is the control: it should be zero, and it is. That the
method returns +0.003 there is what makes the other two numbers trustworthy.)

So a bat and his own team's total move together five times more than two bats
in the same lineup do. Which is mechanically obvious once stated — a double is
a total base *and* a step towards a run, whereas two teammates are largely
competing for the same nine innings — and it is the opposite of how stacks are
usually built.

---

## Pricing a stack

Marginals come from the two models. The joint comes from a **Gaussian copula**:
each leg *i* is a latent normal crossing the threshold Φ⁻¹(pᵢ), and the legs
share a correlation matrix

```
R[team, hitter]     = 0.361      fitted on 86,868 pairs from 2024-25
R[hitter, hitter']  = 0.074      fitted on 250,000 pairs from 2024-25
```

Marginals are unchanged for any correlation — only the joint moves — which is
precisely what makes it safe to bolt onto two models that were each fitted one
leg at a time.

One note on why it is a full matrix rather than the usual "shared team factor":
those two numbers cannot both come from one common factor, because
0.361 > √0.074. Any model where the legs are independent given the team's night
caps the hitter-to-team correlation at √(hitter-to-hitter) = 0.27. The
dependence here is not a shared cause — a hitter's total bases *are* part of his
team's runs — so the matrix is specified directly and the orthant probability is
evaluated with Genz's transform over a Halton sequence (`copula.py`, and the
same arithmetic in TypeScript so the page and the backtest price a card
identically).

### Verification, on the 2026 season neither model saw

| stack | observed | independence | copula |
|---|--:|--:|--:|
| team total over 4.5 **+** a hitter 2+ TB *(n = 37,303)* | **20.40%** | 15.28% (**−25.1%**) | 20.55% (**+0.7%**) |
| two hitters, same lineup *(n = 149,780)* | 13.35% | 12.65% (−5.2%) | 13.65% (+2.3%) |
| team total **+** the lineup's two best bats *(n = 4,150)* | 12.70% | 8.01% (−36.9%) | 13.44% (+5.8%) |

The headline is the first row. **Priced as independent legs, a team total and a
bat off that lineup is a quarter cheaper than it should be.** The copula gets it
to within a percent, out of sample, on 37,303 pairs.

The two-hitter row is the honest counterweight: the correction is small there,
because the correlation is small. Anyone selling you a five-man lineup stack is
selling something the data does not support.

### The stack table that looks like a correlation and isn't

Taking the top *k* bats of each lineup and asking how often all *k* clear 2+ TB
produces a table that seems to show correlation rising with *k*:

| k | same lineup: observed ÷ independence | **matched control** (k different games, same prices) |
|--:|--:|--:|
| 2 | 0.973× | 0.950× |
| 3 | 1.062× | 0.960× |
| 4 | 1.126× | 1.115× |
| 5 | 1.601× | 1.171× |

The control is *k* legs at matched prices drawn from *k* different games — legs
that cannot be correlated. It moves almost identically at k = 2, 3 and 4. So
most of that "lift" is not correlation at all; it is the prop model being
slightly over-confident about its own best picks (its top decile predicts 46.6%
and delivers 44.1%), which compounds when you multiply several of them. Only at
k = 5 does the same-lineup column pull away from the control, on 4,150 stacks,
and that is thin evidence to bet on.

This is why the shipped page prices hitter-only stacks with ρ = 0.074 and says
what that means, rather than quoting a multiplier that is mostly calibration
drift wearing a correlation's clothes.

---

## The card — what actually ships

Confidence tiers for the two-leg card (team total over 4.5 **+** one hitter 2+
TB), cut on the held-out season where the hit rate separates. "Breakeven" is the
American price at which that tier is exactly a push.

| Tier | n | hit rate | breakeven | independence would have said |
|---|--:|--:|--:|--:|
| **Strong** | 1,865 | **31.4%** | +219 | 26.8% |
| Solid | 22,381 | 22.0% | +354 | — |
| Lean | 13,057 | 16.0% | +523 | — |

The day's best-rated card landed **31.2%** of the time; the top three, 32.5%.

And the one place gating *does* pay, on its own: restricting 2+ TB picks to
hitters on the night's biggest offences.

| 2+ TB hit rate | |
|---|--:|
| every lineup starter | 35.0% |
| on a **top-8** projected offence | 36.7% |
| on a **top-5** projected offence | 37.5% |
| on a **top-3** projected offence | 39.0% |
| on the night's **top-1** projected offence | **41.5%** |

Monotone, and free — it costs nothing to sort the board by projected runs, which
is exactly what the page does. Applied to the picks you would actually bet, the
day's single best 2+ TB pick goes from **51.6% to 56.1%** when the board is
restricted to the five biggest offences, and the day's best three from 47.8% to
52.4%.

---

## What the page shows

`/mlb/stacks`, one card per lineup, sorted by projected runs:

- **projected runs** and the team's slate rank,
- the three **team totals** with their backtested tier,
- the lineup's best **2+ total-base bats**, priced by the existing prop model —
  one price per hitter across the whole site,
- and the **combinations**: team total + each bat, team total + the two best
  bats, and the two best bats on their own. Each one shows the correlated price,
  what independence would have said, and the ratio between them.

Showing both numbers is deliberate. The gap *is* the product: if a book prices
the two legs as independent, that gap is the edge, and if it prices them with
its own correlation model, the comparison tells you whose is closer to what
happened.

---

## Reproducing

```bash
cd research/mlb-props && python3 fetch_props.py && python3 fetch_context.py && python3 features.py
cd ../mlb-stacks
python3 fetch_teams.py        # team-games from the schedule endpoint
python3 features_team.py      # the chronological feature walk
python3 bakeoff_team.py       # 13 models x 3 markets
python3 joint.py              # sections A-G above
python3 copula.py             # the copula against a dense integral
python3 final_stacks.py       # freeze -> src/lib/mlb-stacks-model.json
npx tsx scripts/test-stacks.ts  # the TypeScript agrees with the Python
```

---

## What would move this next

- **The team model is barely better than a napkin.** The gap between
  `poisson_napkin` (0.5405) and the shipped logistic (0.5547) is thirty features
  wide and 0.014 AUC tall. Lineup-level projection — summing the nine posted
  bats' expected bases rather than using team season aggregates — is the obvious
  next thing to try, and it is the one feature group this model does not have.
- **Correlation is fitted as one constant.** It almost certainly is not: the
  leadoff hitter's outcome ought to correlate with the team total more than the
  ninth hitter's does, and a hitter facing a bullpen game differently again.
  Fitting ρ per lineup slot is cheap and testable.
- **The prop model's top decile is over-confident** (46.6% predicted, 44.1%
  actual). That is a finding *about the props model*, surfaced here because
  stacking multiplies it. It belongs in `research/mlb-props`.
