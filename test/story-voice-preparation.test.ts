import assert from "node:assert/strict";
import test from "node:test";

// @ts-ignore Browser module.
import { prepareMovieVoice, requestMovie } from "../public/app/story-voice-preparation.js";

test("prepares script lines before playback and reuses their clips", async () => {
  const calls: string[] = [];
  const voice = prepareMovieVoice(async (text: string, who: string) => {
    calls.push(`${who}:${text}`);
    return new Blob([text]);
  });
  const script = { chapters: [{ lines: [{ text: "Hello", who: "host" }, { text: "Hello", who: "cohost" }] }] };
  const stages: string[] = [];
  await voice.prepare(script, (stage: string) => stages.push(stage));
  assert.equal(await (await voice.narrate("Hello", "host")).text(), "Hello");
  assert.deepEqual(calls, ["host:Hello", "cohost:Hello"]);
  assert.match(stages.at(-1)!, /2 of 2/);
});

test("overlapping preparation and playback share in-flight requests", async () => {
  let finish!: (blob: Blob) => void;
  let calls = 0;
  const voice = prepareMovieVoice(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const script = { chapters: [{ lines: [{ text: "Hello", who: "host" }] }] };
  const preparing = voice.prepare(script, () => {});
  const playing = voice.narrate("Hello", "host");
  finish(new Blob(["audio"]));
  await preparing;
  await playing;
  assert.equal(calls, 1);
});

test("script events start narration before movie publishing finishes", async () => {
  const events: string[] = [];
  const script = { chapters: [{ lines: [{ text: "Ready", who: "host" }] }] };
  const voice = prepareMovieVoice(async () => { events.push("narrate"); return new Blob(["audio"]); });
  let prepared: Promise<void>;
  const stream = async (_url: string, _options: unknown, receive: (line: unknown) => void) => {
    receive({ type: "script", script });
    assert.deepEqual(events, ["narrate"]);
    events.push("published");
    receive({ type: "done", script });
  };
  await requestMovie(stream, "/overview", {}, () => {}, (written: unknown) => {
    prepared = voice.prepare(written, () => {});
  });
  await prepared!;
  await voice.narrate("Ready", "host");
  assert.deepEqual(events, ["narrate", "published"]);
});

test("saved movies and older peers prepare from the final result", async () => {
  let prepared = 0;
  const script = { chapters: [] };
  const stream = async (_url: string, _options: unknown, receive: (line: unknown) => void) => {
    receive({ type: "done", script });
  };
  const result = await requestMovie(stream, "/overview", {}, () => {}, (written: unknown) => {
    assert.equal(written, script);
    prepared++;
  });
  assert.equal(result.script, script);
  assert.equal(prepared, 1);
});

test("voice failures reach the caller without retrying paid synthesis", async () => {
  let calls = 0;
  const voice = prepareMovieVoice(async () => { calls++; throw new Error("Voice unavailable"); });
  const script = { chapters: [{ lines: [{ text: "Hello", who: "host" }] }] };
  await assert.rejects(voice.prepare(script, () => {}), /Voice unavailable/);
  await assert.rejects(voice.narrate("Hello", "host"), /Voice unavailable/);
  assert.equal(calls, 1);
});
