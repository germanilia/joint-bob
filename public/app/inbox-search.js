// Search for the control center's list: every word of the query must be somewhere in the conversation; a typo, a
// partial word or letters in order still match. No server and no index: the list is a few hundred rows.
// A match says where it hit, so the list can mark the words and show a snippet of what was said.

const WORD = /[\p{L}\p{N}]+/gu;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** Edit distance where swapping two neighbouring letters counts as one edit ("makr" is one edit from "mark"). */
export function distance(a, b) {
  const table = Array.from({ length: a.length + 1 }, (_, row) => [row, ...Array(b.length).fill(0)]);
  for (let column = 1; column <= b.length; column++) table[0][column] = column;
  for (let row = 1; row <= a.length; row++) {
    for (let column = 1; column <= b.length; column++) {
      table[row][column] = Math.min(table[row - 1][column] + 1, table[row][column - 1] + 1, table[row - 1][column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1));
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) table[row][column] = Math.min(table[row][column], table[row - 2][column - 2] + 1);
    }
  }
  return table[a.length][b.length];
}

/** {score, ranges} when the word is in the text: exact first, then a word with a typo, then letters in order close together; else null. */
export function matchWord(token, text) {
  const lower = text.toLowerCase();
  const at = lower.indexOf(token);
  if (at >= 0) return { score: at === 0 || !WORD_CHARACTER.test(lower[at - 1]) ? 100 : 70, ranges: [[at, at + token.length]] };
  const allowed = token.length >= 7 ? 2 : token.length >= 4 ? 1 : 0;
  if (allowed) {
    for (const found of lower.matchAll(WORD)) {
      const word = found[0];
      // A word the person has only started typing counts as its beginning.
      const edits = Math.min(distance(token, word), distance(token, word.slice(0, token.length)) + 1);
      if (edits <= allowed) return { score: 60 - edits * 5, ranges: [[found.index, found.index + word.length]] };
    }
  }
  if (token.length < 3) return null;
  const ranges = [];
  let next = 0, first = -1, last = -2;
  for (let index = 0; index < lower.length && next < token.length; index++) {
    if (lower[index] !== token[next]) continue;
    if (index === last + 1) ranges[ranges.length - 1][1] = index + 1; else ranges.push([index, index + 1]);
    if (first < 0) first = index;
    last = index;
    next++;
  }
  const span = last - first + 1;
  return next === token.length && span <= token.length * 2.5 ? { score: 40 - (span - token.length), ranges } : null;
}

/**
 * `fields` is [[name, weight, text], …]. Null when a word of the query is in none of them; else the total score and, per
 * field name, the ranges that matched.
 */
export function searchFields(fields, query) {
  let score = 0;
  const hits = {};
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    let best = 0;
    for (const [name, weight, text] of fields) {
      const found = matchWord(token, text);
      if (!found) continue;
      best = Math.max(best, found.score * weight);
      (hits[name] ??= []).push(...found.ranges);
    }
    if (!best) return null;
    score += best;
  }
  return { score, hits };
}

/** The text cut into parts in order, each saying whether it is a match: [{text, match}]. */
export function segments(text, ranges = []) {
  const parts = [];
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (end <= at) continue;
    const from = Math.max(start, at);
    if (from > at) parts.push({ text: text.slice(at, from), match: false });
    parts.push({ text: text.slice(from, end), match: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

/** A line of the text around its first match, like a mail client's snippet: its parts, and whether the start was cut. */
export function snippet(text, ranges, width = 120) {
  const [start] = [...ranges].sort((a, b) => a[0] - b[0])[0];
  const from = Math.max(0, start - 28);
  const inside = ranges.filter(([a, b]) => a >= from && b <= from + width).map(([a, b]) => [a - from, b - from]);
  return { parts: segments(text.slice(from, from + width), inside), cut: from > 0 };
}
