# What multiple touchdowns change

A player who scores three times counts exactly the same as one who falls in
from a yard out. The label is binary — `scored`, meaning one or more — so the
board is blind to the difference. This is what happens when you stop being
blind to it.

**Answer up front: the board should stay as it is.** Every way of feeding the
counts into the model made it worse, two of them provably so, and the one place
the counts genuinely do bite turns out to be already priced. But the reasons are
more interesting than the verdict, and one of the tests I ran was measuring an
artifact until I checked it against a control.

---

## 1. How much is being discarded

| touchdowns in a game | rows | share |
|---|---|---|
| 0 | 20,231 | 78.57% |
| 1 | 4,619 | 17.94% |
| 2 | 791 | 3.07% |
| 3 | 95 | 0.37% |
| 4 | 11 | 0.04% |
| 5 | 2 | 0.01% |

Multi-touchdown games are **16.3% of the rows that scored at all**, and they
carry **29.4% of every touchdown in the sample**. So the binary label is
throwing away almost a third of the scoring signal.

That is not automatically a mistake. The board sells *anytime* touchdown: a leg
on a slip pays the same for one as for three, so P(≥1) is exactly the quantity
the product needs and the binary label is the honest target for it. The question
is whether the counts help *estimate* that quantity — not whether they should
replace it.

**First, a check that nothing was already broken.** The features split the two
ideas correctly and have all along: `rush_td_rate` and `rec_td_rate` accumulate
raw touchdown counts over carries and targets, so a two-touchdown game
contributes two — while `anytime_rate` counts *games scored in*, capped at one
per game, which is what an anytime rate means. The live TypeScript does the same
thing (`a.scg += p.rtd + p.ctd > 0 ? 1 : 0`), so training and serving agree. The
ledger settles on `tds > 0`, so a three-touchdown afternoon is one hit, which is
right. No bug to fix.

## 2. Teaching the model the counts makes the board worse

Five count-aware variants of the shipped pairwise ranker, each over 20
pair-sampling seeds, plus a pooled control:

| variant | top-1 | sd | vs shipped | 95% CI |
|---|---|---|---|---|
| **shipped** (count-blind) | **48.87%** | 0.51 | — | — |
| weight pairs by TD difference | 48.52% | 0.48 | −0.7 | [−1.7, +0.0] |
| add scorer-vs-scorer pairs | 48.27% | 0.53 | −1.0 | [−2.5, +0.3] |
| both of the above | 47.74% | 0.53 | −1.3 | [−3.0, +0.3] |
| oversample by count | 45.51% | 0.43 | **−4.0** | **[−7.1, −0.9]** |
| pooled logistic, count-weighted | 44.85% | — | **−4.4** | **[−7.2, −1.6]** |

Not one variant helped. The three mild ones are a wash — their intervals touch
zero, so the losses are not proven, but neither is any gain. The two aggressive
ones are **significantly worse** under a slate-clustered bootstrap.

## 3. Why — and it is not a shrug

The failure is perfectly ordered. Every increment of count information moves
three numbers, always the same way:

| variant | AUC (≥1 TD) | AUC (≥2 TD) | top-1 |
|---|---|---|---|
| shipped | 0.6751 | 0.7753 | 49.2% |
| weighted | 0.6767 | 0.7782 | 48.5% |
| within-pos | 0.6770 | 0.7781 | 48.2% |
| both | 0.6781 | 0.7801 | 47.8% |
| oversample | 0.6851 | 0.7855 | 45.2% |
| pooled-weight | 0.6876 | 0.7903 | 44.9% |

Monotone in all three columns across six models. Counts make the model **better
at ranking the whole field**, **better still at spotting multi-touchdown games**,
and **worse at the one pick the card makes**.

Because they are answers to a different question. Weighting by count teaches
"who piles up touchdowns" — high-volume goal-line backs in games that turn into
routs. "Who scores in *this* game" is a narrower thing, and the two come apart
exactly where the board lives. It is the same AUC-versus-top-1 tension the
original bake-off turned on, now with a knob on it: you can dial count
information up and watch one metric rise while the other falls.

## 4. The counts do bite — on teammates

Conditioning only on the *first* player's count, then asking about the second
(so the conditioning never touches the outcome being measured):

| A scored | pairs | B scored | B's stated probability | ratio |
|---|---|---|---|---|
| 0 | 34,931 | 21.8% | 22.2% | **0.982** |
| exactly 1 | 7,861 | 20.1% | 22.3% | **0.900** |
| 2 or more | 1,616 | 17.1% | 22.0% | **0.778** |

The goal line is a finite resource, and this is it being measured. A teammate
who scores once costs you 10% of your stated chance; one who scores twice costs
you 22%. The concentration is real too — when a team scores three touchdowns the
top man takes 1.52 of them, and at five he takes 2.27.

The first row is the quiet vindication: when a teammate does *not* score, B
comes in at 0.982 of his stated number. Essentially 1.0. The same-team penalty
lives entirely in the games where somebody actually took the touchdowns.

So the board's flat 0.826 same-team factor is an average over these cases,
applied to all of them. It should over-penalise a pair whose other leg is a
low-rate receiver and under-penalise one whose other leg is a back who will take
two. Keying it on the partner's *expected* count looks like a free improvement.

## 5. It is not a free improvement, and the reason is a trap

Fitted on 2021-24, the same-team ratio rises steeply with the pair's combined
expected touchdowns — 0.548 in the bottom quintile to 0.937 in the top, a fitted
slope of `0.396 + 0.671 × (λa + λb)`. A strong, clean-looking trend.

It loses on 2025-26, on every measure, including the within-bucket one it was
built to win:

| correction | stated | actual | ratio | log loss | bucket error |
|---|---|---|---|---|---|
| none (1.000) | 5.03% | 4.17% | 0.830 | 0.16513 | 0.857% |
| **flat 0.826 (shipped)** | 4.16% | 4.17% | **1.005** | **0.16432** | **0.336%** |
| keyed to expected TDs | 4.00% | 4.17% | 1.045 | 0.16440 | 0.448% |

A trend that does not transfer usually is not the thing you named it. So I ran
the identical slice over **different-game pairs**, where there is no correlation
to find by construction:

| λa + λb | same team | control | same / control |
|---|---|---|---|
| bottom | 0.548 | 0.647 | 0.848 |
| (0.31, 0.39] | 0.567 | 0.698 | 0.812 |
| (0.39, 0.49] | 0.709 | 0.843 | 0.841 |
| (0.49, 0.65] | 0.897 | 1.018 | 0.881 |
| top | 0.937 | 1.064 | 0.881 |

The control swings **0.647 → 1.064** — over pairs that cannot influence each
other. Combined expected touchdowns is nearly a restatement of the two legs'
probabilities, so slicing on it is mostly slicing on `p`, and the model's
calibration is imperfect at the low end. The "correlation trend" was mostly the
calibration curve.

Against the control, the real same-team penalty is **0.812 to 0.881** — spread
0.070, against the 0.389 raw swing that fooled me. Nearly flat. The shipped
0.826 sits inside that band.

That is why the different-games control exists, and why every correlation number
in this project is quoted against it rather than raw.

## 6. Two or more touchdowns, as its own market

| | |
|---|---|
| base rate (test) | 3.69% |
| AUC | **0.7908** |
| highest probability the model will state | 48.1% |
| best pick per game | stated 17.7%, actual 14.3% (43 of 301 games) |

Worth noting that AUC is *higher* than the anytime board's 0.675 — multi-touchdown
games concentrate in identifiable high-volume backs, so they are genuinely easier
to rank. But a board whose most confident pick is a 14% shot is not a board, and
a five-leg version of it would be a 1-in-17,000 ticket. Rankable is not the same
as offerable. Not shipped; recorded here so the decision is on the record rather
than unexamined.

## 7. Reproducing it

```
research/nfl-td-scorer/
  multi_td.py          five count-aware ranker variants, 20 seeds each
  multi_td_sig.py      slate bootstrap, the AUC/top-1 mechanism, the 2+ market
  multi_td_corr.py     crowding-out, conditioned only on the partner
  pair_count.py        the keyed correction, and the control that sinks it
```
