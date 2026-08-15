"""
The leagues this pipeline covers, and where ESPN keeps them.

Every script here takes `--league <slug>` and reads/writes under a per-league
directory, so the five competitions never share a model, a calibration or a
results file. That separation is not bureaucratic: home advantage, draw rate and
goal supply differ enough between them that a model fitted on one league is
mis-calibrated on another, which is exactly what the bake-off measures.

`seasons` is per league because the competitions are not the same size — the
Bundesliga plays 306 matches a season to the Premier League's 380, and Ligue 1
dropped from 380 to 306 when it cut to 18 teams in 2023-24. Sample size per
season is therefore a league property, and it is why the bake-off pools three
test seasons rather than ranking on one.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class League:
    slug: str        # our id, used for directories, model keys and URLs
    espn: str        # ESPN's competition code
    name: str        # display name
    country: str
    teams: int       # clubs in a normal season, for sanity-checking a fetch


LEAGUES = [
    League("epl", "eng.1", "Premier League", "England", 20),
    League("laliga", "esp.1", "La Liga", "Spain", 20),
    League("bundesliga", "ger.1", "Bundesliga", "Germany", 18),
    League("seriea", "ita.1", "Serie A", "Italy", 20),
    League("ligue1", "fra.1", "Ligue 1", "France", 18),
]

BY_SLUG = {lg.slug: lg for lg in LEAGUES}

# ESPN labels a season by its opening year: 2021 == the 2021-22 campaign.
SEASONS = [2021, 2022, 2023, 2024, 2025]

# Which seasons take their turn as the held-out test set. A single season is
# 306-380 matches, far too few to rank forty algorithms on, so three are pooled.
ROLLING_TEST = [2023, 2024, 2025]


def get(slug: str) -> League:
    if slug not in BY_SLUG:
        raise SystemExit(f"unknown league {slug!r}; try one of {', '.join(BY_SLUG)}")
    return BY_SLUG[slug]


def add_league_arg(parser):
    parser.add_argument(
        "--league",
        default="epl",
        choices=[lg.slug for lg in LEAGUES],
        help="which competition to run against (default: epl)",
    )
    return parser
