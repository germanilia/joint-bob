import assert from "node:assert/strict";
import test from "node:test";
import { fuzzyHits, fuzzyScore, rankChoices } from "../public/app/fuzzy.js";

test("fuzzyHits reports the matched letters in order", () => {
  assert.deepEqual(fuzzyHits("op55", "Opus 5.5")?.hits, [0, 1, 5, 7]);
  assert.deepEqual(fuzzyHits("sonnet", "Claude Sonnet 5")?.hits, [7, 8, 9, 10, 11, 12], "a run of the typed text marks that run");
  assert.equal(fuzzyHits("zz", "Opus 5.5"), null);
  assert.deepEqual(fuzzyHits("", "Opus 5.5"), { score: 0, hits: [] });
});

test("fuzzyScore keeps its meaning", () => {
  assert.equal(fuzzyScore("op55", "Opus 5.5"), fuzzyHits("op55", "Opus 5.5")?.score);
  assert.equal(fuzzyScore("x", "Opus"), null);
});

test("rankChoices keeps the list's order with no query, and orders by strength with one", () => {
  const choices = [
    { value: "a", label: "Haiku 4.5" },
    { value: "b", label: "Opus 5.5" },
    { value: "c", label: "Sonnet 5", detail: "Balanced" },
  ];
  assert.deepEqual(rankChoices("", choices).map((row) => row.choice.value), ["a", "b", "c"]);
  assert.deepEqual(rankChoices("op55", choices).map((row) => row.choice.value), ["b"]);
  assert.deepEqual(rankChoices("op55", choices)[0].hits, [0, 1, 5, 7]);
  assert.deepEqual(rankChoices("5", choices).map((row) => row.choice.value), ["b", "c", "a"], "an earlier hit ranks higher");
});

test("a choice found only by its detail line is listed, but its name is not marked", () => {
  const choices = [{ value: "c", label: "Sonnet 5", detail: "Balanced" }, { value: "o", label: "Opus" }];
  const rows = rankChoices("balanced", choices);
  assert.deepEqual(rows.map((row) => row.choice.value), ["c"]);
  assert.deepEqual(rows[0].hits, []);
});

test("value, detail and keywords match as text, ignoring dots, spaces and dashes", () => {
  const choices = [{ value: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6 (US)", keywords: "bedrock" }];
  assert.equal(rankChoices("opus46", choices).length, 1);
  assert.equal(rankChoices("bedrock", choices).length, 1);
  assert.deepEqual(rankChoices("bedrock", choices)[0].hits, []);
});

test("the detail line must contain the typed text, so loose letters there do not match", () => {
  assert.deepEqual(rankChoices("bd", [{ value: "c", label: "Sonnet", detail: "Balanced" }]), []);
});

test("several words may each be found in a different field", () => {
  const choices = [
    { value: "shortcuts", label: "Shortcuts", detail: "Settings tab" },
    { value: "recent", label: "Recent conversations", detail: "Recently opened conversations" },
  ];
  assert.deepEqual(rankChoices("settings shortcuts", choices).map((row) => row.choice.value), ["shortcuts"]);
  assert.deepEqual(rankChoices("tab recent", choices), [], "every word must be found");
});

test("opaque choice values do not make unrelated labels match part of a multiword query", () => {
  const choices = [
    { value: "profile:opaque-id-2", label: "Account 3", detail: "ChatGPT profile" },
    { value: "profile:opaque-id-4", label: "Account 4", detail: "ChatGPT profile" },
  ];
  assert.deepEqual(rankChoices("Account 2", choices), []);
});
