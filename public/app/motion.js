// Motion: how much the interface moves, and the small animation helpers the list and the toasts share.
//   Playful : springy easing that overshoots a little, a stamp, confetti and "+1" counters.
//   Calm    : the same moves with ease-out only, no particles.
//   Off     : nothing moves. Chosen when the device asks for reduced motion and the person has not chosen otherwise.
// The choice is per browser (like the theme). It is written to <html data-motion>, which the dialog and toast styles read (styles.css).
// Dialogs need no code: their open and close motion is CSS (`@starting-style`), so every <dialog> in the app has it.

const MOTION_KEY = "jointBobMotion";
export const FEELS = [["playful", "Playful"], ["calm", "Calm"], ["off", "Off"]];

const system = matchMedia("(prefers-reduced-motion: reduce)");
let chosen = FEELS.some(([id]) => id === localStorage.getItem(MOTION_KEY)) ? localStorage.getItem(MOTION_KEY) : "";

/** The feel in use: the person's choice, else Off when the device asks for less motion, else Playful. */
export const feel = () => chosen || (system.matches ? "off" : "playful");
export const moving = () => feel() !== "off";
export const playful = () => feel() === "playful";

function apply() {
  document.documentElement.dataset.motion = feel();
}
apply();
system.addEventListener("change", () => { apply(); drawChoices(); });

const NONE = { finished: Promise.resolve() };
export const EASE_OUT = "cubic-bezier(.2,.7,.2,1)";
export const EASE_IN = "cubic-bezier(.4,0,1,1)";
export const spring = () => (playful() ? "cubic-bezier(.34,1.56,.64,1)" : EASE_OUT);

/** Plays a Web Animation; with motion off it plays nothing and its `finished` still resolves. */
export function animate(element, frames, ms, options = {}) {
  if (!moving() || !element?.isConnected) return NONE;
  return element.animate(frames, { duration: ms, easing: EASE_OUT, ...options });
}

/** A number or label that changed pops, so the eye finds it. */
export function bump(element) {
  animate(element, [{ transform: "scale(1)" }, { transform: `scale(${playful() ? 1.4 : 1.15})`, offset: 0.4 }, { transform: "scale(1)" }], 380, { easing: spring() });
}

/** A soft colour that fades out over a row or a card. */
export function flash(node, color = "var(--accent-soft)", ms = 1200) {
  if (!moving()) return;
  const layer = document.createElement("span");
  layer.className = "motion-flash";
  layer.style.background = color;
  node.prepend(layer);
  animate(layer, [{ opacity: 1 }, { opacity: 0 }], ms, { easing: "ease-in" }).finished.then(() => layer.remove(), () => layer.remove());
}

const centre = (element) => {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

/** A burst of small pieces around an element. Playful only. */
export function sparks(element, { count = 10, distance = 34, colors = ["var(--amber)"], gravity = 0, size = 7 } = {}) {
  if (!playful() || !element?.isConnected) return;
  const { x, y } = centre(element);
  for (let index = 0; index < count; index += 1) {
    const piece = document.createElement("span");
    piece.className = "motion-spark";
    piece.style.cssText = `left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px;background:${colors[index % colors.length]};border-radius:${index % 2 ? "50%" : "2px"}`;
    document.body.append(piece);
    const angle = (Math.PI * 2 * index) / count + Math.random() * 0.5;
    const reach = distance * (0.7 + Math.random() * 0.6);
    const dx = Math.cos(angle) * reach;
    const dy = Math.sin(angle) * reach;
    animate(piece, [
      { transform: "translate(0,0) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.8}px,${dy * 0.8}px) rotate(${180 * Math.random()}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px,${dy + gravity}px) rotate(${360 * Math.random()}deg) scale(.4)`, opacity: 0 },
    ], 650 + Math.random() * 300, { easing: "cubic-bezier(.1,.6,.3,1)" }).finished.then(() => piece.remove(), () => piece.remove());
  }
}

/** A "+1" that floats from one element to a counter and bumps it when it arrives. Calm bumps the counter at once. */
export function plusOne(from, to, text = "+1") {
  if (!playful()) { bump(to); return; }
  const start = centre(from);
  const end = centre(to);
  const label = document.createElement("span");
  label.className = "motion-plus";
  label.textContent = text;
  label.style.cssText = `left:${start.x - 8}px;top:${start.y - 10}px`;
  document.body.append(label);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  animate(label, [
    { transform: "translate(0,0) scale(.6)", opacity: 0 },
    { transform: `translate(${dx * 0.3}px,${dy * 0.3 - 40}px) scale(1.25)`, opacity: 1, offset: 0.35 },
    { transform: `translate(${dx}px,${dy}px) scale(.7)`, opacity: 0.2 },
  ], 760, { easing: "cubic-bezier(.4,0,.2,1)" }).finished.then(() => { label.remove(); bump(to); }, () => label.remove());
}

/* ---------- Settings › Account › Appearance › Motion ---------- */

function choose(id) {
  chosen = id;
  localStorage.setItem(MOTION_KEY, id);
  apply();
  drawChoices();
}

function drawChoices() {
  const group = document.querySelector("#settingsMotionChoices");
  if (!group) return;
  group.replaceChildren(...FEELS.map(([id, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-segment ghost";
    button.textContent = label;
    button.dataset.testid = `settings-motion-${id}`;
    button.setAttribute("aria-pressed", String(feel() === id));
    button.addEventListener("click", () => choose(id));
    return button;
  }));
}
drawChoices();
