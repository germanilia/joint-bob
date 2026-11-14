import assert from "node:assert/strict";
import test from "node:test";
import { distance, matchWord, searchFields, segments, snippet } from "../public/app/inbox-search.js";

test("a swapped pair of letters is one edit", () => {
  assert.equal(distance("makr", "mark"), 1);
  assert.equal(distance("deploy", "deploy"), 0);
  assert.equal(distance("lock", "block"), 1);
});

test("a word matches exactly, with a typo, as a start, or as letters in order", () => {
  assert.deepEqual(matchWord("done", "makr as done shuold revmoe"), { score: 100, ranges: [[8, 12]] });
  assert.ok(matchWord("mark", "makr as done")!.score >= 55, "a typo still matches");
  assert.ok(matchWord("depl", "deployment started")!.score >= 100, "the beginning of a word matches");
  assert.ok(matchWord("dpl", "deploy to prod"), "letters in order, close together, match");
  assert.equal(matchWord("xyz", "deploy to prod"), null);
  assert.equal(matchWord("ab", "a lot of b"), null, "two letters are too few to match loosely");
});

test("every word of the query must match somewhere", () => {
  const fields = [["title", 3, "makr as done shuold revmoe"], ["project", 2, "Joint Bob"], ["agent", 1.5, "Pi gpt-5.2"]];
  assert.ok(searchFields(fields, "mark done"));
  assert.ok(searchFields(fields, "joint pi"), "words may hit different fields");
  assert.equal(searchFields(fields, "joint kokoro"), null, "one missing word is no match");
  const strong = searchFields(fields, "done")!;
  const weak = searchFields([["body", 0.6, "makr as done"]], "done")!;
  assert.ok(strong.score > weak.score, "a hit in the title counts more than one in the text");
});

test("matched words are cut out of the text in order, and a snippet keeps the match in view", () => {
  assert.deepEqual(segments("a <b> & done", [[8, 12]]), [{ text: "a <b> & ", match: false }, { text: "done", match: true }]);
  assert.deepEqual(segments("done", [[0, 4], [2, 4]]), [{ text: "done", match: true }], "overlapping ranges are one match");
  const text = `${"x ".repeat(60)}the lock is stale`;
  const at = text.indexOf("lock");
  const found = snippet(text, [[at, at + 4]]);
  assert.equal(found.cut, true);
  assert.ok(found.parts.some((part) => part.match && part.text === "lock"));
});
