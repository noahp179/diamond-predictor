# Accuracy backtest — model vs. market (win rates, not returns)

_Run `npx tsx scripts/backtest-accuracy.ts`. The question here is deliberately
simple: **how often is each pick right?** No money, no ROI — just the
percentage of picks that won._

The "model" is the exact margin-of-victory Elo the live NFL/NBA pages use
(`src/lib/espn.server.ts` — same K, home edge, season carry), replayed
**walk-forward** so every pick used only games played before it. The "market"
is the closing moneyline favorite (the shorter price). Both are scored on the
**same games** — every completed game that had a moneyline — so it's a fair
head-to-head.

## Headline — straight-up pick accuracy

| Sport                       | Games  | **Model (Elo)** | **Market (favorite)** | Blend (model×market) |
| --------------------------- | ------ | --------------- | --------------------- | -------------------- |
| **NBA** (2007-08 → 2025-26) | 23,403 | **66.1%**       | **68.5%**             | 68.5%                |
| **NFL** (2006 → 2025)       | 5,254  | **64.1%**       | **66.4%**             | 66.3%                |

**The market is more accurate than the model — by about 2.3–2.4 percentage
points in both sports.** That gap is small but consistent. The blend
(model mixed with the line) essentially matches the market; it doesn't beat it.

## Accuracy by confidence — the "how often do 70% picks actually win?" view

Picks aren't all equal — a coin-flip game and a heavy favorite both count as
one pick. Bucketed by how confident the model is, the win rate climbs exactly
as it should, and the model's confident picks are **well-calibrated** (a "74%"
pick wins ~74%):

**NBA**

| Model confidence | Model picks | Model win % | Market win % (same games) |
| ---------------- | ----------- | ----------- | ------------------------- |
| 50–60%           | 7,392       | 54.0%       | 60.1%                     |
| 60–70%           | 7,084       | 63.9%       | 65.1%                     |
| 70–80%           | 5,423       | **73.7%**   | 74.0%                     |
| 80–100%          | 3,504       | **84.6%**   | 84.8%                     |

**NFL**

| Model confidence | Model picks | Model win % | Market win % (same games) |
| ---------------- | ----------- | ----------- | ------------------------- |
| 50–60%           | 2,129       | 55.0%       | 59.3%                     |
| 60–70%           | 1,681       | 63.8%       | 65.1%                     |
| 70–80%           | 1,045       | **74.7%**   | 75.2%                     |
| 80–100%          | 399         | **86.0%**   | 86.7%                     |

Two things stand out:

1. **When the model is confident, it's right at that rate.** Its 70–80% picks
   win ~74%, its 80%+ picks win ~85% — in both sports. So "the top of the
   Recommended page hits ~74%+" is a fair claim, and the very top (80%+
   favorites) wins ~85%.
2. **The whole model-vs-market gap lives in the coin-flip games.** In the
   70%+ buckets the model and the market are neck-and-neck (73.7 vs 74.0,
   84.6 vs 84.8). The market only pulls clearly ahead in the 50–60% bucket
   (54% vs 60%) — the near-even games, where the line sees something (usually
   late injury/lineup news) the public-data model can't.

For reference, the market's _own_ confidence buckets land in the same place —
its 70–80% favorites win ~75%, its 80%+ favorites win ~86% — i.e. both are
honestly calibrated; the market is just confident more often and right slightly
more often.

## Head-to-head — when they pick different sides

| Sport | Agree on the side | Disagree    | On disagreements: **model right** | **market right** |
| ----- | ----------------- | ----------- | --------------------------------- | ---------------- |
| NBA   | 86.1%             | 3,248 games | 41.4%                             | **58.6%**        |
| NFL   | 85.7%             | 751 games   | 41.8%                             | **58.2%**        |

They agree ~86% of the time. On the ~14% where they split, the **market wins
the argument ~58–59%** of the time. This is the cleanest statement of the gap:
the model is a strong public-data pick, but when it deviates from the line it's
more often the one that's wrong.

## By season (model win % / market win %)

The ordering is remarkably stable — the market leads in **all 19 NBA seasons**
and **17 of 20 NFL seasons** (NFL 2014, 2015, 2019 are the model's only wins,
all by <3 pts):

**NBA** — the market is ahead every year; closest seasons are 2015-16
(69.6 vs 70.0) and 2008-09 (69.5 vs 70.5). Both sit in the high-60s most years,
dipping together in the COVID seasons (2020-21: 61.1 vs 65.9).

**NFL** — model 58.9–69.0% by year, market 59.4–71.2%; the two move together
season to season, and the model's three winning years (2014, 2015, 2019) are
all near-ties.

Full per-season tables print from the script.

### Recent 3 seasons (the live Track Record window)

| Sport                   | Model | Market | Games |
| ----------------------- | ----- | ------ | ----- |
| NBA (2023-24 → 2025-26) | 64.3% | 68.5%  | 3,121 |
| NFL (2023 → 2025)       | 64.2% | 68.1%  | 850   |

(The NBA Track Record page shows ~67% for 2025-26 alone — a single, model-
friendly season scored over ESPN's _full_ season; this backtest pools three
seasons of the odds dataset, so the number is a touch lower and, crucially,
sits next to the market's for comparison.)

## Bottom line

- **NBA model 66.1% vs market 68.5%; NFL model 64.1% vs market 66.4%.**
- The model is genuinely good and honestly calibrated — its 70%+ picks win
  ~74%, its 80%+ picks win ~85%, and on those confident games it's level with
  the market.
- The market is still ~2.3 pts more accurate overall, and wins ~58% of the
  games where the two disagree. That residual is the private information (injury
  and lineup news) the line prices and a public-data model can't see — the same
  conclusion the full study reached (`NBA-NFL-ANALYSIS.md`), now stated purely
  in win-rate terms.
