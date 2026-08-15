"""
The two tours, and the surface problem.

ESPN's tennis feed carries no surface field. Anywhere. Surface is the single
largest structural factor in tennis — a clay-court specialist and a grass-court
specialist are close to different players — so a model without it is leaving the
biggest lever on the table.

There is no honest way to read surface out of the feed, so it is supplied here
as an explicit table, and treated as a hypothesis rather than a fact:

  * The table covers the events whose surface is unambiguous and stable year to
    year — the Slams, the Masters 1000 / WTA 1000 tier, and the clear clay and
    grass swings. Roughly 190 distinct tournament names appear across five
    seasons, many of them 125-level events that rotate venues; those are left
    UNKNOWN rather than guessed.
  * Every match keeps its surface label, including "unknown", and the share of
    each is reported by fetch_tennis.py so the coverage is visible.
  * Whether the labels are any good is settled empirically, not by assertion:
    the bake-off runs surface-specific Elo against global Elo. If the labels
    were noise, splitting ratings by them would cost accuracy rather than add
    it. That comparison is the validation, and it is reported either way.

Matching is by substring against the tournament name, longest pattern first, so
"Australian Open" cannot be captured by a shorter accidental match.
"""

from dataclasses import dataclass

HARD, CLAY, GRASS, UNKNOWN = "hard", "clay", "grass", "unknown"


@dataclass(frozen=True)
class Tour:
    slug: str      # our id: directories, model keys, URLs
    espn: str      # ESPN's league code
    name: str      # display name
    grouping: str  # which grouping in the feed holds this tour's singles draw


TOURS = [
    Tour("atp", "atp", "ATP", "mens-singles"),
    Tour("wta", "wta", "WTA", "womens-singles"),
]
BY_SLUG = {t.slug: t for t in TOURS}

SEASONS = [2021, 2022, 2023, 2024, 2025]
# Which seasons take a turn as the held-out test set. Pooled, because one season
# of one tour is a few thousand matches and forty algorithms need more than that.
ROLLING_TEST = [2023, 2024, 2025]

# ---------------------------------------------------------------- surfaces
#
# Substring -> surface. Only events whose surface does not move between years.
SURFACE_PATTERNS: list[tuple[str, str]] = [
    # --- Grand Slams
    ("australian open", HARD),
    ("roland garros", CLAY),
    ("wimbledon", GRASS),
    ("us open", HARD),
    # --- clay: the European and South American swings
    ("monte-carlo", CLAY),
    ("madrid open", CLAY),
    ("internazionali bnl", CLAY),          # Rome
    ("barcelona open", CLAY),
    ("estoril", CLAY),
    ("munich", CLAY),
    ("bmw open", CLAY),                    # Munich
    ("hamburg", CLAY),
    ("gstaad", CLAY),
    ("umag", CLAY),
    ("kitzbuhel", CLAY),
    ("generali open", CLAY),               # Kitzbühel
    ("bastad", CLAY),
    ("nordea open", CLAY),                 # Båstad
    ("geneva open", CLAY),
    ("lyon", CLAY),
    ("strasbourg", CLAY),
    ("rabat", CLAY),
    ("lalla meryem", CLAY),
    ("grand prix hassan", CLAY),           # Marrakech
    ("argentina open", CLAY),
    ("rio open", CLAY),
    ("chile open", CLAY),
    ("cordoba open", CLAY),
    ("bolivia open", CLAY),
    ("quito open", CLAY),
    ("srpska open", CLAY),
    ("belgrade open", CLAY),
    ("charleston", CLAY),
    ("colsanitas", CLAY),
    ("palermo", CLAY),
    ("iasi open", CLAY),
    ("prague open", CLAY),
    ("warsaw", CLAY),
    ("parma", CLAY),
    ("firenze", CLAY),
    ("makarska", CLAY),
    ("ljubljana", CLAY),
    ("veneto open", CLAY),
    ("tiriac", CLAY),                      # Bucharest
    ("hungarian grand prix", CLAY),
    ("catalonia open", CLAY),
    ("open solgironès", CLAY),
    ("san sebastian", CLAY),
    ("porto open", CLAY),
    ("caldas da rainha", CLAY),
    ("montevideo open", CLAY),
    ("tucumán open", CLAY),
    ("sp open", CLAY),
    ("cali open", CLAY),
    ("copa oster", CLAY),
    # --- grass: the short June/July swing
    ("hsbc championships", GRASS),         # Queen's
    ("terra wortmann", GRASS),             # Halle
    ("libéma open", GRASS),                # 's-Hertogenbosch
    ("boss open", GRASS),                  # Stuttgart
    ("mallorca championships", GRASS),
    ("eastbourne", GRASS),
    ("birmingham", GRASS),
    ("nottingham", GRASS),
    ("ilkley", GRASS),
    ("bad homburg", GRASS),
    ("berlin tennis open", GRASS),
    ("hall of fame open", GRASS),          # Newport
    ("l'open 35", GRASS),
    # --- hard: everything else that is unambiguous
    ("bnp paribas open", HARD),            # Indian Wells
    ("miami open", HARD),
    ("cincinnati open", HARD),
    ("national bank open", HARD),
    ("championnats banque nationale", HARD),
    ("shanghai masters", HARD),
    ("paris masters", HARD),
    ("nitto atp finals", HARD),
    ("next gen atp finals", HARD),
    ("wta finals", HARD),
    ("wta elite trophy", HARD),
    ("china open", HARD),
    ("wuhan open", HARD),
    ("ningbo open", HARD),
    ("zhuhai championships", HARD),
    ("hangzhou open", HARD),
    ("chengdu open", HARD),
    ("guangzhou open", HARD),
    ("zhengzhou open", HARD),
    ("jiangxi open", HARD),
    ("suzhou open", HARD),
    ("hong kong", HARD),
    ("japan open", HARD),
    ("toray pan pacific", HARD),
    ("korea open", HARD),
    ("thailand open", HARD),
    ("dubai duty free", HARD),
    ("qatar", HARD),
    ("abu dhabi open", HARD),
    ("brisbane international", HARD),
    ("asb classic", HARD),
    ("adelaide international", HARD),
    ("hobart international", HARD),
    ("canberra international", HARD),
    ("tata open maharashtra", HARD),
    ("abierto mexicano", HARD),            # Acapulco
    ("guadalajara open", HARD),
    ("mérida open", HARD),
    ("monterrey", HARD),
    ("delray beach", HARD),
    ("dallas open", HARD),
    ("atx open", HARD),
    ("winston-salem", HARD),
    ("atlanta open", HARD),
    ("mubadala citi dc", HARD),
    ("mubadala dc open", HARD),
    ("silicon valley classic", HARD),
    ("san diego open", HARD),
    ("cleveland", HARD),
    ("tennis in the land", HARD),
    ("abn amro", HARD),                    # Rotterdam
    ("open 13 provence", HARD),            # Marseille
    ("open occitanie", HARD),              # Montpellier
    ("moselle open", HARD),                # Metz
    ("sofia open", HARD),
    ("erste bank open", HARD),             # Vienna
    ("swiss indoors", HARD),               # Basel
    ("stockholm open", HARD),
    ("european open", HARD),               # Antwerp
    ("almaty open", HARD),
    ("transylvania open", HARD),
    ("upper austria ladies linz", HARD),
    ("porsche tennis grand prix", CLAY),   # Stuttgart indoor clay
    ("jasmin open", HARD),
    ("singapore tennis open", HARD),
    ("chennai open", HARD),
    ("mumbai open", HARD),
    ("olympics", CLAY),                    # Paris 2024 was played at Roland Garros
    # --- alternate and historical names that appear in the feed
    ("french open", CLAY),                 # Roland Garros, older feed naming
    ("western & southern", HARD),          # Cincinnati, pre-rename
    ("serbia open", CLAY),
    ("u.s. men's clay court", CLAY),       # Houston
    ("clay court championship", CLAY),
    ("mifel tennis open", HARD),           # Los Cabos
    ("auvergne-rhône-alpes", HARD),        # Lyon, indoor hard
    ("great ocean road open", HARD),       # Melbourne 2021 bubble events
    ("murray river open", HARD),
    ("singapore tennis open", HARD),
    ("emilia-romagna", CLAY),
    ("sardegna open", CLAY),
    ("andalucia open", CLAY),
    ("mallorca", GRASS),
    ("cinch championships", GRASS),        # Queen's, sponsor era
    ("noventi open", GRASS),               # Halle, sponsor era
    ("viking", GRASS),                     # Viking International/Classic, UK grass
    ("rothesay", GRASS),                   # UK grass swing sponsor
    ("bett1open", GRASS),                  # Berlin
    ("astana open", HARD),
    ("tel aviv", HARD),
    ("gijon open", HARD),
    ("napoli", HARD),
    ("firenze open", HARD),
    ("cologne", HARD),
    ("st. petersburg open", HARD),
    ("kremlin cup", HARD),
    ("open sud de france", HARD),
    ("montpellier", HARD),
    ("marseille", HARD),
    ("rio de janeiro", CLAY),
    ("sao paulo", CLAY),
    ("santiago", CLAY),
    ("buenos aires", CLAY),
    ("marbella", CLAY),
    ("cagliari", CLAY),
    ("parma ladies", CLAY),
    ("lausanne", CLAY),
    ("budapest", CLAY),
    ("bucharest", CLAY),
    ("hamburg european open", CLAY),
    ("swedish open", CLAY),
]
# Longest first so a short pattern cannot shadow a longer, more specific one.
SURFACE_PATTERNS.sort(key=lambda kv: -len(kv[0]))


def surface_of(name: str) -> str:
    low = (name or "").lower()
    for pat, surf in SURFACE_PATTERNS:
        if pat in low:
            return surf
    return UNKNOWN


def get(slug: str) -> Tour:
    if slug not in BY_SLUG:
        raise SystemExit(f"unknown tour {slug!r}; try one of {', '.join(BY_SLUG)}")
    return BY_SLUG[slug]


def add_tour_arg(parser):
    parser.add_argument(
        "--tour", default="atp", choices=[t.slug for t in TOURS],
        help="which tour to run against (default: atp)",
    )
    return parser
