"""
Write the recommendation (and the constants needed to run it live) into
results/backtest.json under "recommendation". Run last:

    python3 fetch.py && python3 build.py && python3 features.py && python3 validate_model.py
    python3 evaluate.py && python3 first_goal.py
    npx tsx research/soccer-scorers/engine_check.ts --variant on   --n 100000   (from the repo root; also
    npx tsx research/soccer-scorers/engine_check.ts --variant site --n 100000    --n 1000 for both)
    python3 engine_compare.py && python3 research_hybrid.py && python3 finalize.py
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")


def main():
    path = os.path.join(RES, "backtest.json")
    bt = json.load(open(path))
    t = bt["test"]["2025"]["pooled"]
    rh = bt["appendix"]["research_style_hybrid"]
    fg = bt["first_goal"]
    bt["recommendation"] = dict(
        anytime_domestic=dict(
            ship="hybrid (pooled over the five leagues; per-league intercepts added nothing in 2024-25 CV)",
            steps=[
                "1. Fix the live feature port of the shipped goal1 model so it matches what the coefficients were "
                "fitted on: player totals accumulated over all seasons since 2021-22 (not this season only), the "
                "prior season as before, and position/formation place from the player's lineup slot (this match "
                "once lineups post; else his last STARTING slot, never 'SUB'). Same coefficients, no refit: "
                "2025-26 log loss %.5f -> %.5f, AUC %.4f -> %.4f." % (
                    rh["pooled"]["model"]["logloss"], rh["pooled"]["model_research"]["logloss"],
                    rh["pooled"]["model"]["auc"], rh["pooled"]["model_research"]["auc"]),
                "2. Stack it with the simulator's closed form (on-pitch share x m_start) in the hybrid logistic "
                "below (hybrid_research coefficients if step 1 is done, hybrid_live otherwise).",
                "3. Optional upgrade: the gradient-boosted model (gbm) was best in every league on 2025-26 but "
                "needs a tree exporter (cf. src/lib/cfb-td-forest.*); its edge over the step-2 hybrid is ~0.001 "
                "log loss (CI just excludes 0; Brier CI includes 0).",
            ],
            hybrid_research=rh["hybrid_research_coef"],
            hybrid_live=bt["ship"]["hybrid"],
            sim_inputs=bt["ship"]["sim"],
            test_2025_pooled={m: dict(logloss=t[m]["logloss"], brier=t[m]["brier"], auc=t[m]["auc"], ece=t[m]["ece"])
                              for m in ("model", "sim", "hybrid", "gbm")},
        ),
        anytime_ucl=dict(
            ship=("replace the site's scorer shares in the simulator's scorer markets with the on-pitch share x "
                  "m_start for announced starters (sim_on); gbm_lite is better still if a tree model is shipped"),
            why=("the site's shares are per team goal over the whole squad, so the XI's shares sum to ~0.53 while "
                 "starters score ~0.82 of a team's goals: every starter is under-priced by ~35%"),
            ucl_sim_stack=bt["ship"]["ucl_sim_stack"],
        ),
        first_goal=dict(
            ship_domestic="hybrid_first (logistic on the anytime model, the closed-form sim, team/opp xG, m_start)",
            ship_ucl="sim_first closed form with on-pitch shares (sim_stack_first is a statistical tie)",
            closed_form=("P(first) = lam_t/(lam_t+lam_o) * (1 - exp(-(lam_t+lam_o))) * s, s = on-pitch share x "
                         "m_start; matches the engine at 100k sims (mean |diff| ~0.001)"),
            constants=fg["fitted"],
        ),
        engine=("closed forms are preferred: the engine at 100k gives the same first-goal probabilities and the same "
                "top pick in ~99% of matches; for anytime it plays ~7.6% more goals than the expected goals it is "
                "given on domestic fixtures, which lifts anytime probabilities ~7%; 1k sims change the top pick "
                "in 8-15% of matches"),
    )
    json.dump(bt, open(path, "w"), indent=1)
    print(json.dumps(bt["recommendation"], indent=1)[:3000])


if __name__ == "__main__":
    main()
