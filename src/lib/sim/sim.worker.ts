/// <reference lib="webworker" />
/**
 * sim.worker.ts — runs the engines off the main thread.
 *
 * A batch of ten thousand games is a second or two of solid computation; on
 * the main thread that is a frozen page. Here it runs in slices, posting
 * progress between them, and a newer request (or an explicit cancel) stops an
 * older batch at the next slice boundary.
 */

import { Accumulator } from "./aggregate";
import { seedFor } from "./core";
import { runner } from "./engine";
import type { SimRequest, SimResponse } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();

const post = (msg: SimResponse) => ctx.postMessage(msg);

ctx.onmessage = async (e: MessageEvent<SimRequest>) => {
  const req = e.data;
  if (req.type === "cancel") {
    cancelled.add(req.id);
    return;
  }
  try {
    if (req.type === "single") {
      const t0 = performance.now();
      const play = runner(req.matchup, req.overrides);
      const result = play(req.seed, true);
      post({ type: "single", id: req.id, result, seed: req.seed, ms: performance.now() - t0 });
      return;
    }
    const t0 = performance.now();
    const play = runner(req.matchup, req.overrides);
    const acc = new Accumulator(req.matchup, req.seed);
    const slice = 200;
    for (let i = 0; i < req.n; i++) {
      const seed = seedFor(req.seed, i);
      acc.add(play(seed, false), seed);
      if ((i + 1) % slice === 0 && i + 1 < req.n) {
        post({ type: "progress", id: req.id, done: i + 1, n: req.n });
        // Yield so a cancel message can land.
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled.has(req.id)) {
          cancelled.delete(req.id);
          post({
            type: "batch",
            id: req.id,
            result: acc.summary(performance.now() - t0),
            partial: true,
          });
          return;
        }
      }
    }
    post({
      type: "batch",
      id: req.id,
      result: acc.summary(performance.now() - t0),
      partial: false,
    });
  } catch (err) {
    post({ type: "error", id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
