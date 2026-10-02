import { useCallback, useEffect, useRef } from "react";

import { Accumulator, type AccState, type MassResult } from "@/lib/sim/aggregate";
import { newSeed } from "@/lib/sim/core";
import type { SimRequest, SimResponse } from "@/lib/sim/protocol";
import type { GameResult, SimMatchup, SimOverrides } from "@/lib/sim/types";

type Pending = {
  worker: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, n: number) => void;
};

export type BatchHandle = {
  id: number;
  promise: Promise<{ result: MassResult; partial: boolean }>;
};

/** Below this many games one worker finishes before splitting would pay. */
const SPLIT_FROM = 2000;

/**
 * The page's handle on the simulation workers: a small pool, created on first
 * use (never during server rendering) and torn down with the page. A big
 * batch is split across the pool, each worker playing its share with its own
 * fresh random seed, and the totals are added back together here.
 *
 * Nothing is replayable by design: every batch and every single game draws
 * new randomness, so running the same matchup twice gives two slightly
 * different answers — by about the Monte Carlo error the results report.
 *
 * Where Workers are unavailable the same engine runs on the main thread in
 * slices — slower to keep responsive, but the page still works.
 */
export function useSimWorker() {
  const pool = useRef<(Worker | null)[]>([]);
  const pending = useRef(new Map<number, Pending>());
  const nextId = useRef(1);
  const parts = useRef(new Map<number, { id: number; worker: number }[]>());
  const cancelled = useRef(new Set<number>());

  useEffect(() => {
    const map = pending.current;
    const workers = pool.current;
    return () => {
      for (const w of workers) w?.terminate();
      workers.length = 0;
      for (const p of map.values()) p.reject(new Error("cancelled"));
      map.clear();
    };
  }, []);

  const size = useCallback(() => {
    if (typeof Worker === "undefined") return 1;
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    return Math.max(1, Math.min(4, cores - 1));
  }, []);

  const get = useCallback((k: number): Worker | null => {
    const have = pool.current[k];
    if (have) return have;
    if (typeof Worker === "undefined") return null;
    try {
      const w = new Worker(new URL("../../lib/sim/sim.worker.ts", import.meta.url), {
        type: "module",
      });
      w.onmessage = (e: MessageEvent<SimResponse>) => {
        const msg = e.data;
        const p = pending.current.get(msg.id);
        if (!p) return;
        if (msg.type === "progress") return p.onProgress?.(msg.done, msg.n);
        pending.current.delete(msg.id);
        if (msg.type === "error") p.reject(new Error(msg.message));
        else if (msg.type === "single")
          p.resolve({ result: msg.result, seed: msg.seed, ms: msg.ms });
        else p.resolve({ state: msg.state, partial: msg.partial });
      };
      w.onerror = (e) => {
        for (const [id, p] of pending.current)
          if (p.worker === k) {
            p.reject(new Error(e.message || "Simulation worker failed"));
            pending.current.delete(id);
          }
        pool.current[k] = null;
      };
      pool.current[k] = w;
      return w;
    } catch {
      return null;
    }
  }, []);

  const send = useCallback(
    <T>(k: number, req: SimRequest, onProgress?: Pending["onProgress"]): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const w = get(k);
        if (!w) {
          void inline(req, onProgress, () => cancelled.current.has(req.id)).then(
            (v) => resolve(v as T),
            reject,
          );
          return;
        }
        pending.current.set(req.id, {
          worker: k,
          resolve: resolve as (v: unknown) => void,
          reject,
          onProgress,
        });
        w.postMessage(req);
      }),
    [get],
  );

  /** One game, recorded play by play, with fresh randomness. */
  const single = useCallback(
    (matchup: SimMatchup, overrides: SimOverrides) =>
      send<{ result: GameResult; seed: number; ms: number }>(0, {
        type: "single",
        id: nextId.current++,
        matchup,
        overrides,
        seed: newSeed(),
      }),
    [send],
  );

  const batch = useCallback(
    (
      matchup: SimMatchup,
      overrides: SimOverrides,
      n: number,
      onProgress?: (done: number, n: number) => void,
    ): BatchHandle => {
      const id = nextId.current++;
      const k = n >= SPLIT_FROM ? size() : 1;
      const shares = Array.from(
        { length: k },
        (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0),
      ).filter((x) => x > 0);
      const done = shares.map(() => 0);
      const subs = shares.map((_, i) => ({ id: nextId.current++, worker: i }));
      parts.current.set(id, subs);
      const t0 = performance.now();
      const promise = Promise.all(
        shares.map((share, i) =>
          send<{ state: AccState; partial: boolean }>(
            i,
            { type: "batch", id: subs[i].id, matchup, overrides, n: share, seed: newSeed() },
            (d) => {
              done[i] = d;
              onProgress?.(
                done.reduce((a, b) => a + b, 0),
                n,
              );
            },
          ),
        ),
      )
        .then((pieces) => {
          const acc = new Accumulator(matchup);
          for (const p of pieces) acc.merge(p.state);
          return {
            result: acc.summary(performance.now() - t0),
            partial: pieces.some((p) => p.partial),
          };
        })
        .finally(() => parts.current.delete(id));
      return { id, promise };
    },
    [send, size],
  );

  const cancel = useCallback((id: number) => {
    for (const sub of parts.current.get(id) ?? []) {
      cancelled.current.add(sub.id);
      pool.current[sub.worker]?.postMessage({ type: "cancel", id: sub.id } satisfies SimRequest);
    }
  }, []);

  return { single, batch, cancel };
}

/** Main-thread fallback, sliced so the page keeps painting. */
async function inline(
  req: SimRequest,
  onProgress: Pending["onProgress"],
  isCancelled: () => boolean,
): Promise<unknown> {
  const [{ runner }, { seedFor }] = await Promise.all([
    import("@/lib/sim/engine"),
    import("@/lib/sim/core"),
  ]);
  if (req.type === "cancel") return null;
  const t0 = performance.now();
  const play = runner(req.matchup, req.overrides);
  if (req.type === "single")
    return { result: play(req.seed, true), seed: req.seed, ms: performance.now() - t0 };
  const acc = new Accumulator(req.matchup);
  for (let i = 0; i < req.n; i++) {
    acc.add(play(seedFor(req.seed, i), false));
    if ((i + 1) % 100 === 0) {
      onProgress?.(i + 1, req.n);
      await new Promise((r) => setTimeout(r, 0));
      if (isCancelled()) return { state: acc.st, partial: true };
    }
  }
  return { state: acc.st, partial: false };
}
