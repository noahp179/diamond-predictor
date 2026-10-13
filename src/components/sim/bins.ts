import type { Bin } from "./SimCharts";

/** Histogram → bins over a contiguous integer range, trimming the far tails
 *  (the 0.25% at each end) so one freak result doesn't squash the shape. */
export function toBins(
  hist: Record<number, number>,
  n: number,
  color: (x: number) => string,
  trim = 0.0025,
): Bin[] {
  const keys = Object.keys(hist)
    .map(Number)
    .sort((a, b) => a - b);
  if (!keys.length) return [];
  let lo = keys[0];
  let hi = keys[keys.length - 1];
  let acc = 0;
  for (const k of keys) {
    acc += hist[k];
    if (acc / n >= trim) {
      lo = k;
      break;
    }
  }
  acc = 0;
  for (let i = keys.length - 1; i >= 0; i--) {
    acc += hist[keys[i]];
    if (acc / n >= trim) {
      hi = keys[i];
      break;
    }
  }
  const out: Bin[] = [];
  for (let x = lo; x <= hi; x++) out.push({ x, p: (hist[x] ?? 0) / n, color: color(x) });
  return out;
}

/**
 * Group one-point bins into wider bars when the range is too wide to read
 * one point at a time — a basketball total runs across a hundred values, and
 * at a thousand games each one-point bar is mostly noise. Bars start on a
 * multiple of the width (225–229, 230–234), so the axis reads in round
 * numbers. Ranges of 80 or less are left alone: a football margin's 3 and 7
 * are real and worth seeing.
 */
export function widen(bins: Bin[], maxSpan = 80, width = 5): Bin[] {
  if (bins.length <= maxSpan) return bins;
  const out = new Map<number, Bin>();
  for (const b of bins) {
    const x = Math.floor(b.x / width) * width;
    const cur = out.get(x);
    if (cur) cur.p += b.p;
    else out.set(x, { x, p: b.p, color: b.color, w: width });
  }
  return [...out.values()].sort((a, b) => a.x - b.x);
}

/** "230" for a one-point bar, "230–234" for a wider one. */
export const binRange = (b: Bin) => (b.w && b.w > 1 ? `${b.x}–${b.x + b.w - 1}` : String(b.x));
