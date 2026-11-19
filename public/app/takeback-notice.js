import { api } from "./api.js";
import { isNodeAdmin } from "./node-admin.js";

const dialog = document.querySelector("#takebackDialog");
const title = document.querySelector("#takebackTitle");
const message = document.querySelector("#takebackMessage");
const errorMessage = document.querySelector("#takebackError");
const decline = document.querySelector("#takebackDecline");
const notices = new Map();
let shown;

function showNext() {
  if (shown) return;
  const notice = notices.values().next().value;
  if (!notice) { if (dialog.open) dialog.close(); return; }
  shown = notice.id;
  title.textContent = `Takeback requested for “${notice.title}”`;
  message.textContent = `${notice.requester} will take this conversation from ${notice.owner} at the end of the 30-second window unless you decline.`;
  errorMessage.textContent = "";
  decline.disabled = false;
  if (!dialog.open) dialog.showModal();
}

function closeNotice(id) {
  clearTimeout(notices.get(id)?.timer);
  notices.delete(id);
  if (shown !== id) return;
  shown = null;
  showNext();
}

function addNotice(notice) {
  if (notices.has(notice.id) || notice.waitMs <= 0) return;
  notices.set(notice.id, { ...notice, timer: setTimeout(() => closeNotice(notice.id), notice.waitMs) });
  showNext();
}

// Escape must not accidentally approve or decline a transfer.
dialog.addEventListener("cancel", event => event.preventDefault());
decline.addEventListener("click", async () => {
  const id = shown;
  decline.disabled = true;
  try {
    await api(`/api/conversation-takebacks/${encodeURIComponent(id)}/decline`, { method: "POST" });
    closeNotice(id);
  } catch (error) {
    if (shown !== id) return;
    errorMessage.textContent = error.message;
    decline.disabled = false;
  }
});

document.addEventListener("takeback-requested", event => addNotice(event.detail));
document.addEventListener("takeback-closed", event => closeNotice(event.detail));
document.addEventListener("takeback-watch-connected", () => {
  if (!isNodeAdmin()) return;
  api("/api/conversation-takebacks").then(({ notices }) => notices.forEach(addNotice)).catch(error => console.warn("Could not load takeback requests", error));
});
