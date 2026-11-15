// Keep the same promises through generation and playback, including requests still in flight.
export function prepareMovieVoice(speak) {
  const clips = new Map();
  function narrate(text, who) {
    const key = JSON.stringify([who, text]);
    if (!clips.has(key)) clips.set(key, speak(text, who));
    return clips.get(key);
  }
  async function prepare(script, onStage) {
    const lines = script.chapters.flatMap((chapter) => chapter.lines);
    const pending = [...lines];
    let done = 0;
    const report = () => onStage(`Preparing the voice: ${done} of ${lines.length} lines.`);
    report();
    let failed = false;
    async function worker() {
      for (let line = pending.shift(); line && !failed; line = pending.shift()) {
        try { await narrate(line.text, line.who); }
        catch (error) { failed = true; throw error; }
        done++;
        report();
      }
    }
    // Match the player's bounded concurrency; Kokoro serializes synthesis itself.
    await Promise.all(Array.from({ length: 3 }, worker));
  }
  return { narrate, prepare };
}

export async function requestMovie(stream, url, body, onStage, onScript = () => {}) {
  let done = null;
  let receivedScript = false;
  await stream(url, { method: "POST", body: JSON.stringify(body) }, (line) => {
    if (line.type === "error") throw Object.assign(new Error(line.error), { details: line.details });
    if (line.type === "progress") onStage(line.stage);
    if (line.type === "script") { receivedScript = true; onScript(line.script); }
    if (line.type === "done") {
      done = line;
      // Saved movies and older peers may return only the final result.
      if (!receivedScript) onScript(line.script);
    }
  });
  if (!done) throw new Error("The connection closed before the Activity overview finished. If the writer completed it, it is saved; try again.");
  return done;
}
