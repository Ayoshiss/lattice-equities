// New York wall-clock helpers for the hourly schedule (9pm to 4am ET, Sun to Thu nights).
export const SCHEDULE = [21, 22, 23, 0, 1, 2, 3, 4];

export function nyParts(ms: number) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekday: p.weekday as string, h: Number(p.hour) % 24, m: Number(p.minute), s: Number(p.second) };
}

export function sessionLabel(ms: number, marketOpen: boolean | undefined) {
  const { weekday, h, m } = nyParts(ms);
  const mins = h * 60 + m;
  const weekend = weekday === "Sat" || (weekday === "Sun" && h < 20) || (weekday === "Fri" && h >= 20);
  if (marketOpen) return { label: "Market hours", night: false };
  if (weekend) return { label: "Weekend", night: true };
  if (mins >= 20 * 60 || mins < 4 * 60) return { label: "Overnight session", night: true };
  if (mins < 9 * 60 + 30) return { label: "Pre-market", night: true };
  return { label: "After hours", night: true };
}

// The next top-of-hour slot in tonight's schedule, and how far through the current hour we are.
export function nextAuction(ms: number) {
  const { h, m, s } = nyParts(ms);
  const secsToHour = 3600 - (m * 60 + s);
  const nextH = (h + 1) % 24;
  const inWindow = SCHEDULE.includes(nextH);
  return { hour: inWindow ? nextH : 21, secs: inWindow ? secsToHour : null, progress: (m * 60 + s) / 3600 };
}

export const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
export const mmss = (secs: number) => `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;

// Wall clock in ms, ticking. `?at=HH:MM` (New York time) starts a demo clock at that
// time of day, so the overnight schedule can be shown in daytime; it keeps ticking.
import { useEffect, useState } from "react";
export function useClock(stepMs = 1000) {
  const [state, setState] = useState<{ ms: number; demo: boolean } | null>(null);
  useEffect(() => {
    const at = new URLSearchParams(location.search).get("at")?.match(/^(\d{1,2}):(\d{2})$/);
    let offset = 0;
    if (at) {
      const now = Date.now(), p = nyParts(now);
      const want = (Number(at[1]) % 24) * 3600 + Number(at[2]) * 60;
      offset = (want - (p.h * 3600 + p.m * 60 + p.s)) * 1000;
    }
    const tick = () => setState({ ms: Date.now() + offset, demo: !!at });
    tick();
    const t = setInterval(tick, stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return state;
}
