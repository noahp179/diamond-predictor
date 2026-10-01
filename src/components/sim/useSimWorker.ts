import { useCallback, useEffect, useRef } from "react";

import type { MassResult } from "@/lib/sim/aggregate";
import type { SimRequest, SimResponse } from "@/lib/sim/protocol";
import type { GameResult, SimMatchup, SimOverrides } from "@/lib/sim/types";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, n: number) => void;
};

export type BatchHandle = {
  id: number;
  promise: Promise<{ result: MassResult; partial: boolean }>;
};

/**
 * The page's handle on the simulation worker. One worker per page, created on
 * first use (never during server rendering) and torn down with the page.
 *
 * Where Workers are unavailable the same engine runs on the main thread in
 * slices — slower to keep responsive, but the page still works.
 */
export function useSimWorker() {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, Pending>());
  const nextId = useRef(1);
  const cancelled = useRef(new Set<number>());

  useEffect(() => {
    const map = pending.current;
    return () => {
      worker.current?.terminate();
      worker.current = null;
      for (const p of map.values()) p.reject(new Error("cancelled"));
      map.clear();
    };
  }, []);

  const get = useCallback((): Worker | null => {
    if (worker.current) return worker.current;
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
        else p.resolve({ result: msg.result, partial: msg.partial });
      };
      w.onerror = (e) => {
        for (const p of pending.current.values())
          p.reject(new Error(e.message || "Simulation worker failed"));
        pending.current.clear();
        worker.current = null;
      };
      worker.current = w;
      return w;
    } catch {
      return null;
    }
  }, []);

  const send = useCallback(
    <T>(req: SimRequest, onProgress?: Pending["onProgress"]): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const w = get();
        if (!w) {
          void inline(req, onProgress, () => cancelled.current.has(req.id)).then(
            (v) => resolve(v as T),
            reject,
          );
          return;
        }
        pending.current.set(req.id, {
          resolve: resolve as (v: unknown) => void,
          reject,
          onProgress,
        });
        w.postMessage(req);
      }),
    [get],
  );

  const single = useCallback(
    (matchup: SimMatchup, overrides: SimOverrides, seed: number) =>
      send<{ result: GameResult; seed: number; ms: number }>({
        type: "single",
        id: nextId.current++,
        matchup,
        overrides,
        seed,
      }),
    [send],
  );

  const batch = useCallback(
    (
      matchup: SimMatchup,
      overrides: SimOverrides,
      n: number,
      seed: number,
      onProgress?: (done: number, n: number) => void,
    ): BatchHandle => {
      const id = nextId.current++;
      return {
        id,
        promise: send({ type: "batch", id, matchup, overrides, n, seed }, onProgress),
      };
    },
    [send],
  );

  const cancel = useCallback((id: number) => {
    cancelled.current.add(id);
    worker.current?.postMessage({ type: "cancel", id } satisfies SimRequest);
  }, []);

  return { single, batch, cancel };
}

/** Main-thread fallback, sliced so the page keeps painting. */
async function inline(
  req: SimRequest,
  onProgress: Pending["onProgress"],
  isCancelled: () => boolean,
): Promise<unknown> {
  const [{ runner }, { Accumulator }, { seedFor }] = await Promise.all([
    import("@/lib/sim/engine"),
    import("@/lib/sim/aggregate"),
    import("@/lib/sim/core"),
  ]);
  if (req.type === "cancel") return null;
  const t0 = performance.now();
  const play = runner(req.matchup, req.overrides);
  if (req.type === "single")
    return { result: play(req.seed, true), seed: req.seed, ms: performance.now() - t0 };
  const acc = new Accumulator(req.matchup, req.seed);
  for (let i = 0; i < req.n; i++) {
    const seed = seedFor(req.seed, i);
    acc.add(play(seed, false), seed);
    if ((i + 1) % 100 === 0) {
      onProgress?.(i + 1, req.n);
      await new Promise((r) => setTimeout(r, 0));
      if (isCancelled()) return { result: acc.summary(performance.now() - t0), partial: true };
    }
  }
  return { result: acc.summary(performance.now() - t0), partial: false };
}
