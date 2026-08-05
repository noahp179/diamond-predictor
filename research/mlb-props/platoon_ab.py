"""
A/B test: does adding handedness / platoon information help the prop models?

EDGE-HUNT.md found switch hitters undershooting their stated probability and
concluded the models had a handedness blind spot worth closing. This builds the
feature block properly — each batter's season-to-date rate against the hand
tonight's starter throws with, plus the matchup flags, and the opposing lineup's
left-handed share for pitchers — and tests it head to head.

Result: it does not help. Mean AUC -0.0004 across the twelve batter markets and
-0.0005 across the four pitcher markets on the 2026 hold-out, with log loss flat
to slightly worse, and the switch-hitter gap essentially unmoved. The platoon
columns are therefore built by features.py but excluded from the shipped model.

Usage: python3 platoon_ab.py
"""
import os, sys, warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from features import (BATTER_FEATURES, BATTER_MARKETS, PITCHER_FEATURES,
                      PITCHER_MARKETS, PLATOON_FEATURES, PITCHER_PLATOON_FEATURES)
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
DATA=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
NEW_B, NEW_P = PLATOON_FEATURES, PITCHER_PLATOON_FEATURES

def auc(y,p):
    y=np.asarray(y);p=np.asarray(p);o=p.argsort();r=np.empty(len(p));r[o]=np.arange(1,len(p)+1)
    r=pd.DataFrame({"p":p,"r":r}).groupby("p").r.transform("mean").values
    n1=y.sum();n0=len(y)-n1
    return float((r[y==1].sum()-n1*(n1+1)/2)/(n1*n0))
def ll(y,p): p=np.clip(p,1e-6,1-1e-6); return float(-np.mean(y*np.log(p)+(1-y)*np.log(1-p)))

def run(fname, generic, markets, new, kind):
    f=pd.read_csv(os.path.join(DATA,fname))
    tr=f.season.isin([2024,2025]).values; te=(f.season==2026).values
    print(f"\n{'market':>8} {'AUC base':>9} {'AUC +plat':>10} {'delta':>8} {'logloss d':>10}  n={te.sum():,}")
    tot=[]
    for mk in markets:
        y=f[f"y_{mk}"].values.astype(int)
        res={}
        for tag, cols in [("base", generic), ("plat", generic + new)]:
            C=cols+[f"own_{mk}",f"ownw_{mk}"]
            X=f[C].values.astype(float)
            sc=StandardScaler().fit(X[tr]); lr=LogisticRegression(max_iter=3000).fit(sc.transform(X[tr]),y[tr])
            p=lr.predict_proba(sc.transform(X[te]))[:,1]
            res[tag]=(auc(y[te],p), ll(y[te],p), p)
        d=res["plat"][0]-res["base"][0]; dl=res["base"][1]-res["plat"][1]
        tot.append((d,dl))
        print(f"{mk:>8} {res['base'][0]:>9.4f} {res['plat'][0]:>10.4f} {d:>+8.4f} {dl:>+10.5f}")
        if mk=="h1":
            globals()[f"{kind}_h1"]=(f[te].copy(), y[te], res["base"][2], res["plat"][2])
    print(f"{'MEAN':>8} {'':>9} {'':>10} {np.mean([t[0] for t in tot]):>+8.4f} {np.mean([t[1] for t in tot]):>+10.5f}")

run("batter_features.csv", BATTER_FEATURES, list(BATTER_MARKETS), NEW_B, "bat")
run("pitcher_features.csv", PITCHER_FEATURES, list(PITCHER_MARKETS), NEW_P, "pit")

# does it fix the switch-hitter bias that started all this?
f,y,pb,pp = bat_h1
d=pd.DataFrame({"y":y,"base":pb,"plat":pp,"sw":f.bats_switch.values,
                "edge":f.platoon_edge.values,"same":f.same_hand.values})
print("\nSWITCH-HITTER BIAS, 2026 hold-out (1+ hits, confident picks only)")
for tag,m in [("switch hitters", d.sw==1), ("everyone else", d.sw==0)]:
    for col in ("base","plat"):
        s=d[m & (d[col]>=0.70)]
        if len(s)<40: continue
        print(f"  {tag:>16} {col:>5}: n={len(s):>5,} stated {s[col].mean():.3f} actual {s.y.mean():.3f} gap {s.y.mean()-s[col].mean():+.3f}")
print("\nPLATOON SPLIT SANITY (all 2026 rows, 1+ hits actual rate)")
for tag,m in [("batter has edge", d.edge==1), ("same-handed", d.same==1)]:
    s=d[m]; print(f"  {tag:>16}: n={len(s):>6,} actual {s.y.mean():.3f}  base says {s.base.mean():.3f}  platoon says {s.plat.mean():.3f}")
