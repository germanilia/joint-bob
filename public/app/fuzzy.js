/**
 * Forgiving text search: every character of the query must appear in order, so "hmsv"
 * finds "Homeserver" and "rsch" finds "Research". Consecutive characters and matches at the
 * start of a word score higher. Returns null when there is no match, or the score (higher is
 * better) and the positions in `text` of the matched characters, so a list can mark them.
 */
export function fuzzyHits(query, text) {
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, "");
  if (!needle) return { score: 0, hits: [] };
  const haystack = String(text ?? "").toLocaleLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return { score: 1000 - direct, hits: [...needle].map((_, offset) => direct + offset) };
  let score = 0, position = -1, run = 0;
  const hits = [];
  for (const character of needle) {
    const next = haystack.indexOf(character, position + 1);
    if (next < 0) return null;
    run = next === position + 1 ? run + 1 : 0;
    const wordStart = next === 0 || /[\s._\-/]/.test(haystack[next - 1]);
    score += 10 + run * 5 + (wordStart ? 8 : 0) - Math.min(next - position - 1, 10);
    hits.push(next);
    position = next;
  }
  return { score, hits };
}

/** The score of `fuzzyHits`, or null when there is no match. */
export function fuzzyScore(query, text) {
  return fuzzyHits(query, text)?.score ?? null;
}

/** The best score across several fields, or null when none of them match. */
export function fuzzyMatch(query, ...fields) {
  let best = null;
  for (const field of fields) {
    const score = fuzzyScore(query, field);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

const compact = (text) => String(text ?? "").toLocaleLowerCase().replace(/[.\s-]/g, "");

/**
 * Orders the choices of a dropdown for what was typed: `{ choice, hits }` per match, where
 * `hits` are the marked letters of the label. The label matches loosely, letter by letter;
 * the full query can match the value, detail and keywords as text (dots, spaces and dashes
 * aside). Split words may come from different readable fields, so an opaque ID cannot complete
 * a partial label match. With nothing typed, every choice is kept in its order.
 */
export function rankChoices(query, choices) {
  const typed = compact(query);
  if (!typed) return choices.map((choice) => ({ choice, hits: [] }));
  const words = query.trim().split(/\s+/).map(compact).filter(Boolean);
  const rows = [];
  for (const [index, choice] of choices.entries()) {
    const label = fuzzyHits(query, choice.label);
    const fields = [choice.value, choice.detail, choice.keywords];
    const inText = fields.some((text) => compact(text).includes(typed));
    // "settings shortcuts" finds Shortcuts, a Settings tab: each word may sit in a different field.
    const everyWord = words.length > 1 && words.every((word) => [choice.label, choice.detail, choice.keywords].some((text) => compact(text).includes(word)));
    if (label) rows.push({ choice, hits: label.hits, score: label.score + 100, index });
    else if (inText || everyWord) rows.push({ choice, hits: [], score: 0, index });
  }
  return rows.sort((left, right) => right.score - left.score || left.index - right.index).map(({ choice, hits }) => ({ choice, hits }));
}
