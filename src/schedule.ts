// Schedules: the calendar rules shared by every automation that runs on a schedule, and the function that says
// when one runs next. Pure: no storage and no clock besides the one passed in.
import { z } from "zod";

export const timezoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Unknown timezone");
export const reasoningSchema = z.enum(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
/** A calendar day, YYYY-MM-DD, as a date picker gives it. */
export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine(value => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, "Not a calendar date");
// Like a meeting in a calendar: once on a day, or repeating (every few minutes or hours, daily, weekly, monthly), from a first
// day until a last one. A monthly task repeats on its first day's day of the month.
export const scheduleSchema = z.object({ frequency: z.enum(["once", "minutely", "hourly", "daily", "weekly", "monthly"]), intervalMinutes: z.number().int().min(1).max(1440).optional(), intervalHours: z.number().int().min(1).max(168).optional(), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), weekday: z.number().int().min(0).max(6), timezone: timezoneSchema, startHour: z.number().int().min(0).max(23).optional(),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(), quietStart: clockSchema.optional(), quietEnd: clockSchema.optional(),
  startDate: calendarDateSchema.optional(), endDate: calendarDateSchema.optional(),
}).strict().superRefine((schedule, context) => {
  if ((schedule.frequency === "once" || schedule.frequency === "monthly") && !schedule.startDate) context.addIssue({ code: "custom", path: ["startDate"], message: "Choose the date" });
  if (schedule.frequency === "once" && schedule.endDate) context.addIssue({ code: "custom", path: ["endDate"], message: "A one-time task has no end date" });
  if (schedule.startDate && schedule.endDate && schedule.endDate < schedule.startDate) context.addIssue({ code: "custom", path: ["endDate"], message: "The end date is before the start date" });
  if (schedule.frequency === "minutely" && schedule.intervalMinutes === undefined) context.addIssue({ code: "custom", path: ["intervalMinutes"], message: "Minute interval is required" });
  if (schedule.days && new Set(schedule.days).size !== schedule.days.length) context.addIssue({ code: "custom", path: ["days"], message: "Days must be unique" });
  if (schedule.frequency === "weekly" && schedule.days && !schedule.days.includes(schedule.weekday)) context.addIssue({ code: "custom", path: ["days"], message: "Include the weekly run day" });
  if (Boolean(schedule.quietStart) !== Boolean(schedule.quietEnd) || schedule.quietStart && schedule.quietStart === schedule.quietEnd) context.addIssue({ code: "custom", path: ["quietEnd"], message: "Quiet hours need two different times" });
});

export type Schedule = z.infer<typeof scheduleSchema>;

/** No run is left: a one-time task that ran, or a schedule past its last day. Later than any real time, so it is never due. */
export const NO_MORE_RUNS = 8_640_000_000_000_000;

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** The instant a wall-clock time on a calendar day has in a timezone. */
function wallTime(date: string, hour: number, minute: number, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const offset = (instant: number) => {
    const p = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - instant;
  };
  return asUtc - offset(asUtc - offset(asUtc));
}

function dayAfter(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** The next run on the first day's day of the month; a month without that day is skipped, as a calendar does. */
function nextMonthly(schedule: Schedule, after: number): number {
  const [year, month, day] = schedule.startDate!.split("-").map(Number);
  const now = new Date(after);
  const passed = Math.max(0, (now.getUTCFullYear() - year) * 12 + now.getUTCMonth() - (month - 1) - 1);
  for (let index = passed; index < passed + 25; index += 1) {
    const first = new Date(Date.UTC(year, month - 1 + index, 1));
    if (day > new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()) continue;
    const at = wallTime(`${first.getUTCFullYear()}-${pad2(first.getUTCMonth() + 1)}-${pad2(day)}`, schedule.hour, schedule.minute, schedule.timezone);
    if (at > after) return at;
  }
  return NO_MORE_RUNS;
}

/** When the schedule runs next after the given time, or NO_MORE_RUNS when it never runs again. */
export function nextCronRun(schedule: Schedule, after: number): number {
  let next: number;
  if (schedule.frequency === "once") next = wallTime(schedule.startDate!, schedule.hour, schedule.minute, schedule.timezone);
  else {
    // Nothing runs before its first day.
    const from = schedule.startDate ? Math.max(after, wallTime(schedule.startDate, 0, 0, schedule.timezone) - 60_000) : after;
    next = schedule.frequency === "monthly" ? nextMonthly(schedule, from) : nextRepeat(schedule, from);
  }
  if (next <= after) return NO_MORE_RUNS;
  if (schedule.endDate && next >= wallTime(dayAfter(schedule.endDate), 0, 0, schedule.timezone)) return NO_MORE_RUNS;
  return next;
}

/** The next run of a schedule that repeats every few minutes or hours, daily or weekly. */
function nextRepeat(schedule: Schedule, after: number): number {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const parts = (time: number) => Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
  const start = parts(after);
  const date = (p: Record<string, string>) => `${p.year}-${p.month}-${p.day}`;
  const todayPassed = Number(start.hour) * 60 + Number(start.minute) >= schedule.hour * 60 + schedule.minute;
  for (let time = Math.floor(after / 60000) * 60000 + 60000; time <= after + 16 * 86400000; time += 60000) {
    const p = parts(time);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    if (schedule.days && !schedule.days.includes(weekday)) continue;
    const wallMinute = Number(p.hour) * 60 + Number(p.minute);
    if (schedule.quietStart && schedule.quietEnd) {
      const startMinute = Number(schedule.quietStart.slice(0, 2)) * 60 + Number(schedule.quietStart.slice(3));
      const endMinute = Number(schedule.quietEnd.slice(0, 2)) * 60 + Number(schedule.quietEnd.slice(3));
      if (startMinute < endMinute ? wallMinute >= startMinute && wallMinute < endMinute : wallMinute >= startMinute || wallMinute < endMinute) continue;
    }
    if (schedule.frequency === "minutely") {
      const day = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000;
      if ((day * 1440 + wallMinute - schedule.hour * 60 - schedule.minute) % schedule.intervalMinutes! === 0) return time;
      continue;
    }
    if (Number(p.minute) !== schedule.minute) continue;
    if (schedule.frequency === "hourly") {
      if (schedule.startHour === undefined) {
        if (Math.floor(time / 3600000) % (schedule.intervalHours ?? 1) === 0) return time;
      } else {
        // Local calendar hours anchor the interval; 08:00 + two hours stays at 08:00 after DST.
        const day = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000;
        if ((day * 24 + Number(p.hour) - schedule.startHour) % (schedule.intervalHours ?? 1) === 0) {
          const previousHour = parts(time - 3600000);
          if (!(date(previousHour) === date(p) && previousHour.hour === p.hour)) return time;
        }
      }
      continue;
    }
    // A daily/weekly wall-clock occurrence runs once, even when DST repeats it.
    if (Number(p.hour) !== schedule.hour || todayPassed && date(p) === date(start)) continue;
    if (schedule.frequency === "daily" || weekday === schedule.weekday) return time;
  }
  throw new Error("No schedule occurrence within sixteen days");
}
