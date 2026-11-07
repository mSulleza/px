/**
 * Peak clock.
 *
 * DeepSeek charges double Monday to Friday, 01:00-04:00 and 06:00-10:00 UTC.
 * In UTC+8 that lands on 09:00-12:00 and 14:00-18:00 — squarely on a
 * working day. 35 of 168 hours a week are peak, so deferrable work (repo
 * indexing, doc sweeps, nightly review) is exactly half price if it waits.
 */

export function isPeak(d: Date): boolean {
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** Next instant at which pricing drops back to off-peak. */
export function nextOffPeak(from: Date): Date {
  const d = new Date(from.getTime());
  if (!isPeak(d)) return d;
  const h = d.getUTCHours();
  const boundary = h < 4 ? 4 : 10;
  d.setUTCHours(boundary, 0, 0, 0);
  return d;
}

export function priceMultiplier(d: Date): 1 | 2 {
  return isPeak(d) ? 2 : 1;
}

/** For the status line: the time on this machine's own clock. */
export function localTime(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}
