// Automation editor, Trigger tab. A schedule automation shows how often it runs (once, every few
// minutes or hours, daily, weekly, monthly), on which days, quiet hours and timezone. A webhook
// automation shows its address card, attachments and allowed senders. Which one is shown follows
// ctx.state.trigger. This file also exports the small form pieces the Run tab shares (`atab-*`).
import { makeButton, makeNode, makeTwoStepButton } from "./relay-ui.js";

/** Later than any real time: the schedule has no run left. */
const NO_MORE_RUNS = 8_640_000_000_000_000;
const FREQUENCIES = [["once", "Once"], ["minutely", "Every few minutes"], ["hourly", "Every few hours"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]];
const WEEKDAYS = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [0, "Sunday"]];
const DAY_CHIPS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
const pad = (value) => String(value).padStart(2, "0");

// ---- form pieces shared with the Run tab ----

export function field(label, control, testid, hint = "") {
  const wrapper = makeNode("label", "atab-field");
  wrapper.append(makeNode("span", "", label), control);
  if (hint) wrapper.append(makeNode("small", "", hint));
  control.dataset.testid = testid;
  return wrapper;
}

export function input(type, attributes = {}) {
  const node = makeNode("input");
  node.type = type;
  Object.assign(node, attributes);
  return node;
}

/** `choices` are [value, label] pairs. */
export function select(choices = []) {
  const node = makeNode("select");
  node.append(...choices.map(([value, label]) => new Option(label, value)));
  return node;
}

export function textarea(rows) {
  const node = makeNode("textarea");
  node.rows = rows;
  return node;
}

export function card(title, hint, ...children) {
  const section = makeNode("section", "atab-card");
  const head = makeNode("header");
  head.append(makeNode("h3", "", title));
  if (hint) head.append(makeNode("p", "atab-hint", hint));
  section.append(head, ...children);
  return section;
}

/** A labelled on/off switch; `input` is a checkbox with role "switch". */
export function switchRow(title, hint, testid, plain = false) {
  const row = makeNode("label", plain ? "atab-toggle plain" : "atab-toggle");
  const box = input("checkbox", { className: "atab-switch" });
  box.setAttribute("role", "switch");
  box.dataset.testid = testid;
  const text = makeNode("span");
  text.append(makeNode("b", "", title));
  if (hint) text.append(makeNode("small", "", hint));
  row.append(box, text);
  return { row, input: box };
}

/** One choice out of a few, as pressed buttons. `onPick(value)` runs when the person picks one. */
export function segmented(testid, choices, onPick) {
  const element = makeNode("div", "atab-seg");
  element.setAttribute("role", "group");
  element.dataset.testid = testid;
  let current = choices[0][0];
  const buttons = new Map(choices.map(([value, label]) => [value, makeButton(label, `${testid}-${value}`, () => { control.set(value); onPick(value); }, "")]));
  const control = {
    element,
    value: () => current,
    set(value) {
      current = value;
      for (const [key, button] of buttons) button.setAttribute("aria-pressed", String(key === value));
    },
    hide(value, hidden) { buttons.get(value).hidden = hidden; },
    disable(disabled) { for (const button of buttons.values()) button.disabled = disabled; },
  };
  element.append(...buttons.values());
  control.set(current);
  return control;
}

// ---- schedule ----

/** Today on this device's calendar, as a date field takes it. */
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function nextRunText(item) {
  if (item.nextRun >= NO_MORE_RUNS) return item.schedule.frequency === "once" ? "none, it ran or its time has passed" : "none, it is past its last day";
  return new Date(item.nextRun).toLocaleString(undefined, { timeZone: item.schedule.timezone });
}

function parseAllowed(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [value, ...label] = line.split(/\s+/);
    return { value, label: label.join(" ") };
  });
}
const allowedText = (allowed) => allowed.map(({ value, label }) => (label ? `${value} ${label}` : value)).join("\n");

export function createTriggerTab(ctx) {
  const element = makeNode("div", "atab");
  element.addEventListener("input", () => ctx.markDirty());
  element.addEventListener("change", () => ctx.markDirty());

  // Schedule
  const freq = segmented("automation-frequency", FREQUENCIES, () => { syncFrequency(); ctx.markDirty(); });
  const minutes = input("number", { min: 1, step: 1 });
  const hours = input("number", { min: 1, step: 1 });
  const weekday = select(WEEKDAYS);
  const startDate = input("date");
  const endDate = input("date");
  const time = input("time");
  const minutesField = field("Repeat every (minutes)", minutes, "automation-interval-minutes");
  const hoursField = field("Repeat every (hours)", hours, "automation-interval-hours");
  const weekdayField = field("On", weekday, "automation-weekday");
  const startDateField = field("From (optional)", startDate, "automation-start-date");
  const timeField = field("At", time, "automation-time");
  const endDateField = field("Until (optional)", endDate, "automation-end-date");
  const nextRun = makeNode("p", "atab-hint");
  const timing = makeNode("div", "atab-grid");
  timing.append(minutesField, hoursField, weekdayField, startDateField, timeField, endDateField);
  const when = card("How often", "Like a meeting in a calendar: once, or repeating from a first day until an optional last one.", freq.element, timing, nextRun);

  const dayButtons = new Map(DAY_CHIPS.map(([value, label]) => [value, makeButton(label, `automation-days-${value}`, (event) => {
    event.currentTarget.setAttribute("aria-pressed", String(event.currentTarget.getAttribute("aria-pressed") !== "true"));
    ctx.markDirty();
  }, "")]));
  const days = makeNode("div", "atab-days");
  days.dataset.testid = "automation-days";
  days.setAttribute("role", "group");
  days.append(...dayButtons.values());
  const daysCard = card("Run on days", "Unchecked days stay quiet.", days);

  const quiet = switchRow("Quiet hours", "No runs inside this window. It can cross midnight; runs resume at the end time.", "automation-quiet-switch", true);
  const quietStart = input("time");
  const quietEnd = input("time");
  const quietTimes = makeNode("div", "atab-grid");
  quietTimes.append(field("From", quietStart, "automation-quiet-start"), field("Until", quietEnd, "automation-quiet-end"));
  const timezone = select([...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])].map((zone) => [zone, zone]));
  const timezoneField = field("Timezone", timezone, "automation-timezone", "Missed offline runs are skipped; runs never overlap.");
  const quietCard = card("Quiet hours and timezone", "", quiet.row, quietTimes, timezoneField);
  quiet.input.addEventListener("change", syncFrequency);

  const scheduleSection = makeNode("div", "atab");
  scheduleSection.append(when, daysCard, quietCard);

  // Webhook
  const newAddress = makeTwoStepButton({ label: "New address…", armedLabel: "Replace address?", testid: "automation-new-address", onConfirm: () => ctx.run(async () => {
    const body = await ctx.api(ctx.url("/regenerate"), { method: "POST", body: "{}" });
    ctx.showAddress(`New address for “${ctx.state.item.name}”. The old one no longer works.`, body.secret, body.bases);
  }) });
  const addressCard = card("Address", "The secret part is shown only once, when it is made. Make a new address if it was lost or leaked; the old one stops working.", newAddress);
  addressCard.classList.add("atab-address");
  const attachments = switchRow("Accept attachments", "Files sent with a call are saved and passed to the agent.", "automation-attachments-switch");
  const senders = switchRow("Only listed senders", "Reject calls whose sender field does not match.", "automation-senders-switch");
  const senderFields = input("text", { placeholder: "message.from.id" });
  const allowedSenders = textarea(4);
  allowedSenders.placeholder = "123456789 Ilia";
  const telegram = makeButton("Use Telegram bot fields", "automation-senders-telegram", () => { senderFields.value = ctx.state.telegramSenderFields.join(", "); ctx.markDirty(); });
  const sendersBody = makeNode("div", "atab-stack");
  sendersBody.append(
    field("Sender field", senderFields, "automation-sender-fields", "Dot paths into the call, separated by commas. The first one that holds a value names the sender."),
    telegram,
    field("Allowed senders", allowedSenders, "automation-allowed-senders", "One per line: the sender, then an optional name."));
  senders.input.addEventListener("change", () => { sendersBody.hidden = !senders.input.checked; });
  const callCard = card("Each call", "", attachments.row, senders.row, sendersBody);
  const webhookSection = makeNode("div", "atab");
  webhookSection.append(addressCard, callCard);

  element.append(scheduleSection, webhookSection);

  /** Shows the fields that apply to the chosen frequency. */
  function syncFrequency() {
    const frequency = freq.value();
    const once = frequency === "once";
    const monthly = frequency === "monthly";
    const dated = once || monthly;
    minutesField.hidden = frequency !== "minutely";
    hoursField.hidden = frequency !== "hourly";
    weekdayField.hidden = frequency !== "weekly";
    startDateField.firstChild.textContent = once ? "On" : monthly ? "From (repeats on this date each month)" : "From (optional)";
    if (dated && !startDate.value) startDate.value = localToday();
    timeField.firstChild.textContent = frequency === "minutely" || frequency === "hourly" ? "Start time" : "At";
    endDateField.hidden = once;
    daysCard.hidden = frequency === "weekly" || dated;
    // Quiet hours shape a repeating rhythm; a dated run is at the time it names.
    quiet.row.hidden = dated;
    quietTimes.hidden = dated || !quiet.input.checked;
  }

  function showTrigger(kind) {
    scheduleSection.hidden = kind !== "schedule";
    webhookSection.hidden = kind !== "webhook";
    addressCard.hidden = ctx.state.item?.trigger !== "webhook";
  }

  function positive(node, label) {
    if (!(Number(node.value) >= 1)) throw new Error(`${label} needs a number of 1 or more`);
    return Number(node.value);
  }

  /** The `schedule` object the server expects. */
  function readSchedule() {
    const frequency = freq.value();
    const dated = frequency === "once" || frequency === "monthly";
    if (!time.value) throw new Error("Choose the time of day");
    if (dated && !startDate.value) throw new Error(frequency === "once" ? "Choose the day it runs" : "Choose the first date it runs on");
    const [hour, minute] = time.value.split(":").map(Number);
    const picked = DAY_CHIPS.filter(([value]) => dayButtons.get(value).getAttribute("aria-pressed") === "true").map(([value]) => value).sort((a, b) => a - b);
    if (frequency !== "weekly" && !dated && !picked.length) throw new Error("Select at least one run day");
    const quietOn = quiet.input.checked && !dated;
    if (quietOn && (!quietStart.value || !quietEnd.value)) throw new Error("Choose when quiet hours start and end");
    if (quietOn && quietStart.value === quietEnd.value) throw new Error("Quiet hours need different start and end times");
    return {
      frequency,
      intervalMinutes: frequency === "minutely" ? positive(minutes, "Repeat every") : undefined,
      intervalHours: frequency === "hourly" ? positive(hours, "Repeat every") : undefined,
      hour, minute, startHour: frequency === "hourly" ? hour : undefined,
      weekday: Number(weekday.value), timezone: timezone.value,
      days: frequency === "weekly" || dated ? undefined : picked,
      startDate: startDate.value || undefined, endDate: frequency === "once" ? undefined : endDate.value || undefined,
      quietStart: quietOn ? quietStart.value : undefined, quietEnd: quietOn ? quietEnd.value : undefined,
    };
  }

  return {
    element,
    fill(item) {
      const schedule = item?.schedule;
      freq.set(schedule?.frequency ?? "daily");
      minutes.value = schedule?.intervalMinutes ?? 15;
      hours.value = schedule?.intervalHours ?? 1;
      weekday.value = schedule?.weekday ?? 1;
      time.value = schedule ? `${pad(schedule.startHour ?? schedule.hour)}:${pad(schedule.minute)}` : "09:00";
      startDate.value = schedule?.startDate ?? "";
      endDate.value = schedule?.endDate ?? "";
      quiet.input.checked = Boolean(schedule?.quietStart);
      quietStart.value = schedule?.quietStart ?? "22:00";
      quietEnd.value = schedule?.quietEnd ?? "08:00";
      for (const [value, button] of dayButtons) button.setAttribute("aria-pressed", String(!schedule?.days || schedule.days.includes(value)));
      const zone = schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (![...timezone.options].some((option) => option.value === zone)) timezone.add(new Option(zone, zone));
      timezone.value = zone;
      nextRun.textContent = schedule ? (item.enabled ? `Next run: ${nextRunText(item)}` : "Turned off, so it does not run.") : "";
      syncFrequency();

      attachments.input.checked = item?.attachments ?? false;
      senders.input.checked = Boolean(item?.senders);
      senderFields.value = item?.senders?.fields.join(", ") ?? "";
      allowedSenders.value = allowedText(item?.senders?.allowed ?? []);
      sendersBody.hidden = !senders.input.checked;
      showTrigger(ctx.state.trigger);
    },
    read(shared) {
      if (shared.trigger === "schedule") return { schedule: readSchedule() };
      if (senders.input.checked && !senderFields.value.trim()) throw new Error("Enter the field that names the sender, or use the Telegram bot fields");
      return {
        attachments: attachments.input.checked,
        senders: senders.input.checked ? { fields: senderFields.value.split(/[\s,]+/).filter(Boolean), allowed: parseAllowed(allowedSenders.value) } : null,
      };
    },
    onTrigger: showTrigger,
  };
}
