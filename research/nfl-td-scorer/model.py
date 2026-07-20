"""
NFL anytime-touchdown-scorer model.

Question it answers: entering a specific game, which one or two players are the
most likely to score a touchdown, how likely are they, and how much should we
trust the pick?

Design (usage x efficiency, allocated to a matchup-scaled team total):

  A player's touchdowns come from two channels - rushing and receiving - each
  modelled as a Poisson rate (expected TDs). We build each player's rate from
  *who gets the ball* (recent carries / targets) times *how often those touches
  become TDs* (a shrunk per-touch scoring rate that captures goal-line / red-zone
  role). Those raw rates set the SHAPE across a team (who is most likely).

  Separately we estimate how many rushing and receiving TDs the *team* should
  score in this game from a log5-style matchup of the offense's recent scoring
  vs the opponent defense's recent TDs allowed. That sets the SCALE (how many).

  We then allocate the team's expected rush / rec TDs across its players in
  proportion to their raw rates, so every player's expected TDs sum to a
  realistic team total. Finally:

        P(player scores >= 1 TD) = 1 - exp(-lambda_player)      (Poisson)

Everything here is a pure function of pre-game state, so the backtest can call
it with strictly historical inputs (no leakage).
"""
from __future__ import annotations
import math
from dataclasses import dataclass, field

# ----------------------------- hyperparameters -----------------------------
# Deliberately simple / round numbers - chosen for football-sensibility, not
# tuned to the test seasons. `backtest.py` can sweep them to show robustness.
HALF_LIFE_VOL = 3.0        # games; recency half-life for projecting touches
ALPHA_VOL = 1 - 0.5 ** (1 / HALF_LIFE_VOL)   # EWMA weight on the newest game
ALPHA_TEAM = 0.30          # EWMA weight for team offense / defense TD rates
K_RUSH = 25.0              # carries of league prior mixed into a rush-TD rate
K_REC = 30.0              # targets of league prior mixed into a rec-TD rate
K_TEAM = 4.0               # games of league prior mixed into team/def ratings
MIN_TOUCHES = 1.5          # players below this projected volume are not ranked
MATCHUP_POW = 0.70         # <1 damps the offense x defense matchup extremes
SHARE_POW = 0.85           # <1 flattens how concentrated the team allocation is


@dataclass
class LeaguePriors:
    rush_td_per_carry: float      # league baseline goal-line efficiency
    rec_td_per_target: float
    team_rush_td: float           # league avg team rushing TDs / game
    team_rec_td: float            # league avg team receiving TDs / game


@dataclass
class PlayerState:
    """Running, pre-game snapshot of one player's usage and scoring."""
    player_id: str
    player: str = ""
    team: str = ""
    games: int = 0
    ewma_carries: float = 0.0
    ewma_targets: float = 0.0
    # cumulative counts feed the shrunk per-touch scoring rates
    cum_carries: float = 0.0
    cum_targets: float = 0.0
    cum_rush_td: float = 0.0
    cum_rec_td: float = 0.0
    recent_touches: list = field(default_factory=list)  # for role-stability

    def update(self, carries, targets, rush_td, rec_td, team):
        self.team = team
        if self.games == 0:                      # seed EWMA with first observation
            self.ewma_carries = carries
            self.ewma_targets = targets
        else:
            self.ewma_carries += ALPHA_VOL * (carries - self.ewma_carries)
            self.ewma_targets += ALPHA_VOL * (targets - self.ewma_targets)
        self.cum_carries += carries
        self.cum_targets += targets
        self.cum_rush_td += rush_td
        self.cum_rec_td += rec_td
        self.recent_touches.append(carries + targets)
        if len(self.recent_touches) > 6:
            self.recent_touches.pop(0)
        self.games += 1

    # --- projections used at prediction time ---
    def proj_carries(self):
        return self.ewma_carries

    def proj_targets(self):
        return self.ewma_targets

    def rush_td_rate(self, pri: LeaguePriors):
        return (self.cum_rush_td + K_RUSH * pri.rush_td_per_carry) / (self.cum_carries + K_RUSH)

    def rec_td_rate(self, pri: LeaguePriors):
        return (self.cum_rec_td + K_REC * pri.rec_td_per_target) / (self.cum_targets + K_REC)


@dataclass
class TeamState:
    """Running team offense (TDs scored) and defense (TDs allowed) rates."""
    team: str
    off_games: int = 0
    def_games: int = 0
    ewma_off_rush_td: float = 0.0
    ewma_off_rec_td: float = 0.0
    ewma_def_rush_td: float = 0.0   # rushing TDs this team ALLOWS
    ewma_def_rec_td: float = 0.0

    def update_off(self, rush_td, rec_td):
        if self.off_games == 0:
            self.ewma_off_rush_td, self.ewma_off_rec_td = rush_td, rec_td
        else:
            self.ewma_off_rush_td += ALPHA_TEAM * (rush_td - self.ewma_off_rush_td)
            self.ewma_off_rec_td += ALPHA_TEAM * (rec_td - self.ewma_off_rec_td)
        self.off_games += 1

    def update_def(self, rush_td_allowed, rec_td_allowed):
        if self.def_games == 0:
            self.ewma_def_rush_td, self.ewma_def_rec_td = rush_td_allowed, rec_td_allowed
        else:
            self.ewma_def_rush_td += ALPHA_TEAM * (rush_td_allowed - self.ewma_def_rush_td)
            self.ewma_def_rec_td += ALPHA_TEAM * (rec_td_allowed - self.ewma_def_rec_td)
        self.def_games += 1

    def off_rating(self, pri, kind):     # shrunk toward league average
        lg = pri.team_rush_td if kind == "rush" else pri.team_rec_td
        ew = self.ewma_off_rush_td if kind == "rush" else self.ewma_off_rec_td
        return (ew * self.off_games + lg * K_TEAM) / (self.off_games + K_TEAM)

    def def_rating(self, pri, kind):
        lg = pri.team_rush_td if kind == "rush" else pri.team_rec_td
        ew = self.ewma_def_rush_td if kind == "rush" else self.ewma_def_rec_td
        return (ew * self.def_games + lg * K_TEAM) / (self.def_games + K_TEAM)


def team_expected_tds(off: TeamState, deff: TeamState, pri: LeaguePriors):
    """log5-style matchup: expected = league * (off/lg)^p * (def/lg)^p, per channel.
    MATCHUP_POW<1 keeps elite offense-vs-weak-defense spots from exploding."""
    def channel(kind, lg):
        o = off.off_rating(pri, kind) / lg
        d = deff.def_rating(pri, kind) / lg
        return lg * (o ** MATCHUP_POW) * (d ** MATCHUP_POW)
    return channel("rush", max(pri.team_rush_td, 1e-6)), channel("rec", max(pri.team_rec_td, 1e-6))


@dataclass
class Prediction:
    player_id: str
    player: str
    team: str
    opp: str
    p_td: float          # likelihood: P(scores an anytime TD)
    lam: float           # expected TDs (Poisson mean)
    lam_rush: float
    lam_rec: float
    proj_carries: float
    proj_targets: float
    games: int


def predict_team(off_state: TeamState, def_state: TeamState,
                 players: list[PlayerState], opp: str, pri: LeaguePriors) -> list[Prediction]:
    """Predict anytime-TD probability for every rankable player on one team."""
    team_rush_td, team_rec_td = team_expected_tds(off_state, def_state, pri)

    raw = []
    for p in players:
        pc, pt = p.proj_carries(), p.proj_targets()
        if pc + pt < MIN_TOUCHES:
            continue
        raw_rush = (pc * p.rush_td_rate(pri)) ** SHARE_POW
        raw_rec = (pt * p.rec_td_rate(pri)) ** SHARE_POW
        raw.append((p, pc, pt, raw_rush, raw_rec))

    sum_rush = sum(r[3] for r in raw) or 1e-9
    sum_rec = sum(r[4] for r in raw) or 1e-9

    preds = []
    for p, pc, pt, raw_rush, raw_rec in raw:
        lam_rush = team_rush_td * raw_rush / sum_rush
        lam_rec = team_rec_td * raw_rec / sum_rec
        lam = lam_rush + lam_rec
        preds.append(Prediction(
            player_id=p.player_id, player=p.player, team=p.team, opp=opp,
            p_td=1 - math.exp(-lam), lam=lam, lam_rush=lam_rush, lam_rec=lam_rec,
            proj_carries=pc, proj_targets=pt, games=p.games))
    return preds


def confidence(pred: Prediction, ranked_game: list[Prediction]) -> float:
    """
    A 0-100 score for how much to trust that `pred` is THE top scorer - kept
    separate from the likelihood. Three transparent ingredients:

      separation : how far this player's expected TDs sit above the next player
                   (a clear favorite is more trustworthy than a coin-flip stack)
      maturity   : how many prior games inform the projection
      volume     : how many touches the player is projected to see

    The backtest validates this: higher-confidence picks should hit more often.
    """
    lam_sorted = sorted((q.lam for q in ranked_game), reverse=True)
    second = lam_sorted[1] if len(lam_sorted) > 1 else 0.0
    separation = (pred.lam - second) / (pred.lam + 1e-9)        # 0..1
    sep_score = _clip(separation / 0.5)                         # ~half-again ahead -> 1
    maturity = _clip(pred.games / 6.0)
    volume = _clip((pred.proj_carries + pred.proj_targets) / 18.0)
    return round(100 * (0.45 * sep_score + 0.30 * maturity + 0.25 * volume), 1)


def _clip(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))
