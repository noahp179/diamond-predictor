"""
run_cfb_variants.py — replay a college season once per factor variant.

    python3 research/player-props/run_cfb_variants.py 2025 variants.json [sims]

Like run_nba_variants.py, for scripts/props-backtest-football.ts cfb with
FB_KNOBS; writes data/sim_{tag}_cfb_{season}.{0-3}.jsonl.
"""

from __future__ import annotations

import glob
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(HERE, "data")
RAW = os.path.join(ROOT, "research", "football-td", "data", "raw", "cfb")
SHARDS = 4


def main() -> None:
    season = sys.argv[1]
    variants = json.load(open(sys.argv[2]))
    sims = sys.argv[3] if len(sys.argv) > 3 else "300"
    for tag, v in variants.items():
        if len(glob.glob(os.path.join(DATA, f"sim_{tag}_cfb_{season}.*.jsonl"))) == SHARDS:
            continue
        env = dict(os.environ, OUT_TAG=f"_{tag}", FB_KNOBS=json.dumps(v.get("knobs", {})))
        env.update({k: str(x) for k, x in v.get("env", {}).items()})
        t0 = time.time()
        procs = [
            subprocess.Popen(
                ["npx", "tsx", "scripts/props-backtest-football.ts", "cfb", season, RAW, str(i), str(SHARDS), sims],
                cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
            for i in range(SHARDS)
        ]
        bad = [p.communicate()[1].decode()[-400:] for p in procs if p.wait() != 0]
        print(f"{tag}: {'FAILED ' + bad[0] if bad else 'done'} in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
