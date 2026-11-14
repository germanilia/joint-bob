// On Bob's page the "Ask Bob" button can be dragged anywhere, and Bob's chat opens as a window of its own that floats over the
// page: drag its head to move it, its corner to resize it. Where the button and the window were left is kept in this browser.
// (The chat folds into the button and opens again as before; only how it is shown changed.) Styles: public/bob-page.css.

const FAB_KEY = "jointBobFabPos";
const BOX_KEY = "jointBobChatBox";
const MARGIN = 8;
const DEFAULT_BOX = { w: 440, h: 640 };
const MIN_BOX = { w: 340, h: 380 };
const DRAG_PX = 5;

const read = (key) => {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
};
const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/** `panel` is the control center's panel (the button lives in it), `chat` Bob's chat, `fab` the "Ask Bob" button. */
export function initFloatingChat({ panel, chat, fab, fold }) {
  const body = document.body;
  const floating = () => body.classList.contains("bob-desk") && body.classList.contains("view-control") && !body.classList.contains("bob-chat-folded");
  let lastFab = null;
  let placed = false;
  let dragged = false;

  /* ---------- the button ---------- */

  function placeFab() {
    const pos = read(FAB_KEY);
    if (!pos || !body.classList.contains("bob-desk")) return;
    const box = panel.getBoundingClientRect();
    fab.style.left = `${clamp(pos.x, MARGIN, box.width - (fab.offsetWidth || 150) - MARGIN)}px`;
    fab.style.top = `${clamp(pos.y, MARGIN, box.height - (fab.offsetHeight || 56) - MARGIN)}px`;
    fab.style.bottom = "auto";
  }
  fab.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const box = panel.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY, left: fab.offsetLeft, top: fab.offsetTop };
    dragged = false;
    fab.setPointerCapture(event.pointerId);
    const move = (moved) => {
      if (!dragged && Math.hypot(moved.clientX - start.x, moved.clientY - start.y) < DRAG_PX) return;
      dragged = true;
      fab.classList.add("dragging");
      fab.style.left = `${clamp(start.left + moved.clientX - start.x, MARGIN, box.width - fab.offsetWidth - MARGIN)}px`;
      fab.style.top = `${clamp(start.top + moved.clientY - start.y, MARGIN, box.height - fab.offsetHeight - MARGIN)}px`;
      fab.style.bottom = "auto";
    };
    const done = () => {
      fab.classList.remove("dragging");
      fab.removeEventListener("pointermove", move);
      fab.removeEventListener("pointerup", done);
      lastFab = fab.getBoundingClientRect();
      if (dragged) localStorage.setItem(FAB_KEY, JSON.stringify({ x: fab.offsetLeft, y: fab.offsetTop }));
    };
    fab.addEventListener("pointermove", move);
    fab.addEventListener("pointerup", done);
  });
  // A drag ends with a click on the button: it must not open the chat.
  fab.addEventListener("click", () => {
    if (dragged) { dragged = false; return; }
    lastFab = fab.getBoundingClientRect();
    fold("chat");
  });

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

  /** Opening: where it was left, else beside the button; closing or leaving Bob's page: the window's own sizes go. */
  function sync() {
    if (!floating()) {
      placed = false;
      for (const property of ["width", "height", "left", "top"]) chat.style.removeProperty(property);
      placeFab();
      return;
    }
    if (placed) return;
    placed = true;
    const saved = read(BOX_KEY);
    const anchor = lastFab ?? fab.getBoundingClientRect();
    const h = saved?.h ?? DEFAULT_BOX.h;
    setBox({ x: saved?.x ?? anchor.left, y: saved?.y ?? anchor.bottom - h, w: saved?.w ?? DEFAULT_BOX.w, h });
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

  window.addEventListener("resize", () => { placeFab(); if (floating() && placed) setBox(currentBox()); });
  placeFab();
  return { sync, placeFab };
}
