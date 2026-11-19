// Contextual Ask Bob actions open a floating chat: drag its head to move it, its corner to resize it.
// The window's position is kept in this browser. Styles: public/bob-page.css.
const BOX_KEY = "jointBobChatBox";
const MARGIN = 8;
const DEFAULT_BOX = { w: 440, h: 640 };
const MIN_BOX = { w: 340, h: 380 };

const parse = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/** `panel` anchors a new window; `chat` is Bob's chat. */
export function initFloatingChat({ panel, chat }) {
  const body = document.body;
  const floating = () => body.classList.contains("bob-desk") && body.classList.contains("view-control") && !body.classList.contains("bob-chat-folded");
  let placed = false;

  /* ---------- the window ---------- */

  function setBox({ x, y, w, h }) {
    const width = clamp(w, MIN_BOX.w, innerWidth - 2 * MARGIN);
    const height = clamp(h, MIN_BOX.h, innerHeight - 2 * MARGIN);
    chat.style.width = `${width}px`;
    chat.style.height = `${height}px`;
    chat.style.left = `${clamp(x, MARGIN, innerWidth - width - MARGIN)}px`;
    chat.style.top = `${clamp(y, MARGIN, innerHeight - height - MARGIN)}px`;
  }
  const currentBox = () => {
    const rect = chat.getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  };
  const saveBox = () => localStorage.setItem(BOX_KEY, JSON.stringify(currentBox()));

  /** Opening: where it was left, else at the panel's bottom left; closing clears the window's own sizes. */
  function sync() {
    if (!floating()) {
      placed = false;
      for (const property of ["width", "height", "left", "top"]) chat.style.removeProperty(property);
      return;
    }
    if (placed) return;
    placed = true;
    const saved = parse(localStorage.getItem(BOX_KEY));
    const anchor = panel.getBoundingClientRect();
    const h = saved?.h ?? DEFAULT_BOX.h;
    setBox({ x: saved?.x ?? anchor.left + 24, y: saved?.y ?? anchor.bottom - h - 24, w: saved?.w ?? DEFAULT_BOX.w, h });
  }

  chat.querySelector(".control-chat-head").addEventListener("pointerdown", (event) => {
    if (!floating() || event.button !== 0 || event.target.closest("button, a, input, select, textarea")) return;
    const head = event.currentTarget;
    const start = { x: event.clientX, y: event.clientY, box: currentBox() };
    head.setPointerCapture(event.pointerId);
    head.classList.add("dragging");
    const move = (moved) => setBox({ ...start.box, x: start.box.x + moved.clientX - start.x, y: start.box.y + moved.clientY - start.y });
    const done = () => {
      head.classList.remove("dragging");
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", done);
      saveBox();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", done);
  });
  // The corner's own resize (CSS `resize`) writes width and height; the size is kept when it stops changing.
  let resizing = null;
  new ResizeObserver(() => {
    if (!floating() || !placed) return;
    clearTimeout(resizing);
    resizing = setTimeout(saveBox, 300);
  }).observe(chat);

  window.addEventListener("resize", () => { if (floating() && placed) setBox(currentBox()); });
  return { sync };
}
