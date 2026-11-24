import { useSyncExternalStore } from "react";

/** A pace: one timer that counts its beats and tells everything following it of each one. It runs while something follows it. */
function pace(ms: number) {
  const followers = new Set<() => void>();
  let beat = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    follow(step: () => void) {
      followers.add(step);
      timer ??= setInterval(() => {
        beat += 1;
        followers.forEach((each) => each());
      }, ms);
      return () => {
        followers.delete(step);
        if (followers.size > 0) return;
        clearInterval(timer);
        timer = undefined;
      };
    },
    beat: () => beat,
  };
}

const paces = new Map<number, ReturnType<typeof pace>>();
const REST = () => () => {};

function paceOf(ms: number) {
  let followed = paces.get(ms);
  if (!followed) paces.set(ms, (followed = pace(ms)));
  return followed;
}

/** Calls `step` every `ms`, on the one timer everything on that pace follows. Returns a function that stops it. */
export function follow(ms: number, step: () => void): () => void {
  return paceOf(ms).follow(step);
}

/**
 * A count that goes up by one every `ms`, for a drawing that steps through
 * its frames or a line that changes. Everything on one pace follows one
 * timer, so it all steps in the same render. With `running` false the caller
 * follows no timer, and draws again for none of its beats.
 */
export function useBeat(ms: number, running = true): number {
  const followed = paceOf(ms);
  return useSyncExternalStore(running ? followed.follow : REST, followed.beat);
}
