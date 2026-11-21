const DAY_MS = 86_400_000;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** When a message was sent, the way a chat list shows it: a time today, then "Yesterday", a weekday, a date. */
export function listTime(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS);
  const date = new Date(time);
  if (days <= 0) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The day a message was sent, for the marker between days in a chat. */
export function dayLabel(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(time).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

/** When a job next runs: "Today 17:05", "Tomorrow 08:00", then a weekday, then a date. */
export function nextTime(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(time) - startOfDay(now)) / DAY_MS);
  const date = new Date(time);
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days <= 0) return `Today ${clock}`;
  if (days === 1) return `Tomorrow ${clock}`;
  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${clock}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock}`;
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}
