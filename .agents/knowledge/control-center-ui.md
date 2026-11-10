# control-center-ui

How the control center screen behaves in the web app.

## r-Esc2Out

Only the person leaves the control center: Esc twice, its Exit button, or the toggle shortcut. Code that runs on its own (page-load restore, socket reconnects, list refreshes, automatic ownership takeover and its "Switched to this node" notice) must never call `setMobileView` away from `"control"`; open conversations behind the view instead (`openListedSession(session, { keepView: true })`).

Evidence: a reload restored the open conversation and its late takeover pulled the page into the chat; the user said only a double Esc should take them out (fixed in 2.254.6) · Added 2026-11-10
