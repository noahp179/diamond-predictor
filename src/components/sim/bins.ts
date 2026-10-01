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
