/**
 * Turns the SQLite statements this codebase writes into PostgreSQL ones.
 *
 * Every store speaks SQLite: `?` parameters, `INSERT OR IGNORE`, `rowid`, `PRAGMA`, savepoints that
 * open transactions, case-insensitive `LIKE` and identifiers that keep their case. A node that keeps
 * its database in PostgreSQL runs those same statements through this module, so the stores do not
 * change. What a statement needs from the live schema (a table's columns and unique keys) is asked
 * of the caller, which answers from the connection.
 */

export type TokenKind = "space" | "string" | "quoted" | "word" | "number" | "param" | "punct";
export interface Token { kind: TokenKind; text: string; /** For params: the SQLite argument index. */ index?: number; /** Written by the translator, never re-translated. */ generated?: boolean }

export interface TableShape {
  /** Columns in table order, without the hidden `rowid`. */
  columns: string[];
  /** The primary key first, then every other full unique index. */
  uniqueKeys: string[][];
}
export interface SchemaLookup { table(name: string): TableShape | undefined }

export type SchemaChange =
  | { op: "create"; type: "table" | "index" | "trigger"; name: string; table: string; sql: string; ifNotExists: boolean }
  | { op: "drop"; type: "table" | "index" | "trigger"; name: string }
  | { op: "renameTable"; from: string; to: string }
  | { op: "addColumn"; table: string; definition: string }
  | { op: "renameColumn"; table: string; from: string; to: string }
  | { op: "dropColumn"; table: string; column: string };

export interface Query {
  text: string;
  /** SQLite argument index for each `$n`, in order. */
  args: number[];
}

export type TransactionOp = "begin" | "beginImmediate" | "commit" | "rollback" | "savepoint" | "release" | "rollbackTo";

export type Plan =
  | { kind: "query"; query: Query; write: boolean; keepsRowid: boolean; change?: SchemaChange; tables: string[] }
  | { kind: "updateOrIgnore"; select: Query; update: Query; tables: string[] }
  | { kind: "transaction"; op: TransactionOp; name?: string }
  | { kind: "rows"; rows: Record<string, unknown>[] }
  | { kind: "pragmaWrite"; name: string; value: number };

const TWO_CHAR = new Set(["||", "<=", ">=", "<>", "!=", "==", "<<", ">>", "->"]);

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let nextParam = 0;
  while (i < sql.length) {
    const c = sql[i];
    const start = i;
    if (/\s/.test(c)) {
      while (i < sql.length && /\s/.test(sql[i])) i++;
      tokens.push({ kind: "space", text: sql.slice(start, i) });
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      tokens.push({ kind: "space", text: " " });
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      tokens.push({ kind: "space", text: " " });
    } else if (c === "'") {
      i = closing(sql, i, "'");
      tokens.push({ kind: "string", text: sql.slice(start, i) });
    } else if (c === '"' || c === "`" || c === "[") {
      const end = c === "[" ? "]" : c;
      i = closing(sql, i, end);
      const name = sql.slice(start + 1, i - 1).replaceAll(end + end, end);
      tokens.push({ kind: "quoted", text: `"${name.replaceAll('"', '""')}"` });
    } else if (c === "?") {
      i++;
      while (i < sql.length && /[0-9]/.test(sql[i])) i++;
      const numbered = sql.slice(start + 1, i);
      const index = numbered ? Number(numbered) - 1 : nextParam;
      nextParam = Math.max(nextParam, index + 1);
      tokens.push({ kind: "param", text: "?", index });
    } else if ((c === ":" || c === "@" || c === "$") && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      throw new Error(`Named SQL parameters are not supported with PostgreSQL: ${sql.slice(i, i + 20)}`);
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      while (i < sql.length && /[0-9A-Za-z_.]/.test(sql[i])) {
        if ((sql[i] === "e" || sql[i] === "E") && (sql[i + 1] === "+" || sql[i + 1] === "-")) i++;
        i++;
      }
      tokens.push({ kind: "number", text: sql.slice(start, i) });
    } else if (/[A-Za-z_]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ kind: "word", text: sql.slice(start, i) });
    } else {
      const pair = sql.slice(i, i + 2);
      const triple = sql.slice(i, i + 3);
      const text = triple === "->>" ? triple : TWO_CHAR.has(pair) ? pair : c;
      i += text.length;
      tokens.push({ kind: "punct", text });
    }
  }
  return tokens;
}

function closing(sql: string, from: number, quote: string): number {
  let i = from + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  throw new Error(`Unterminated quote in SQL: ${sql.slice(from, from + 40)}`);
}

const upper = (token: Token | undefined): string => (token?.kind === "word" ? token.text.toUpperCase() : "");
const isWord = (token: Token | undefined, ...words: string[]): boolean => words.includes(upper(token));
const significant = (tokens: Token[]): Token[] => tokens.filter((token) => token.kind !== "space");

/** Splits a script into statements; a trigger's body keeps its own semicolons. */
export function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  let blocks = 0;
  for (const token of tokens) {
    if (token.kind === "punct" && token.text === ";" && depth === 0 && blocks === 0) {
      if (significant(current).length) statements.push(current);
      current = [];
      continue;
    }
    if (token.kind === "punct" && token.text === "(") depth++;
    if (token.kind === "punct" && token.text === ")") depth--;
    if (isTrigger(current) && isWord(token, "BEGIN", "CASE")) blocks++;
    if (isTrigger(current) && isWord(token, "END")) blocks--;
    current.push(token);
  }
  if (significant(current).length) statements.push(current);
  return statements;
}

function isTrigger(tokens: Token[]): boolean {
  const words = significant(tokens).slice(0, 3).map(upper);
  return words[0] === "CREATE" && (words[1] === "TRIGGER" || words[2] === "TRIGGER");
}

/* PostgreSQL reserves these words, SQLite does not: in this codebase's SQL they are always names. */
const POSTGRES_ONLY_RESERVED = new Set([
  "ANALYSE", "ANY", "ARRAY", "ASYMMETRIC", "AUTHORIZATION", "BINARY", "BOTH", "CONCURRENTLY", "CURRENT_CATALOG",
  "COLLATION", "CURRENT_ROLE", "CURRENT_SCHEMA", "CURRENT_USER", "FETCH", "FREEZE", "GRANT", "ILIKE", "LATERAL", "LEADING", "LOCALTIME",
  "LOCALTIMESTAMP", "ONLY", "OVERLAPS", "PLACING", "SESSION_USER", "SIMILAR", "SOME", "SYMMETRIC", "TABLESAMPLE",
  "SYSTEM_USER", "TRAILING", "USER", "VARIADIC", "VERBOSE",
]);

const RENAMED_FUNCTIONS: Record<string, string> = {
  IFNULL: "coalesce", INSTR: "strpos", JSON_OBJECT: "json_build_object",
};

/** Maps a SQLite column type to the PostgreSQL type with the same affinity. */
export function columnType(declared: string): string {
  const type = declared.toUpperCase();
  if (type.includes("INT") || type.startsWith("BOOL")) return "BIGINT";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) return "TEXT";
  if (type.includes("BLOB")) return "BYTEA";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) return "DOUBLE PRECISION";
  if (type.startsWith("NUMERIC") || type.startsWith("DECIMAL")) return "NUMERIC";
  return "TEXT";
}

const generated = (text: string): Token => ({ kind: "word", text, generated: true });
const raw = (text: string): Token[] => tokenize(text).map((token) => ({ ...token, generated: true }));
const space: Token = { kind: "space", text: " ", generated: true };

function identifier(token: Token): string {
  return token.kind === "quoted" ? token.text.slice(1, -1).replaceAll('""', '"') : token.text;
}
export function quoteIdentifier(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

/** How a SQLite name is written in PostgreSQL: as `translateTokens` writes it, so every statement agrees. */
export function sqlName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? render(translateTokens([{ kind: "word", text: name }])).text : quoteIdentifier(name);
}

/**
 * Rewrites the expression-level SQLite in `tokens`: parameters, `IS`, `LIKE`, names whose case
 * matters, two-argument `max`/`min` and the functions PostgreSQL calls differently.
 */
export function translateTokens(tokens: Token[]): Token[] {
  const out: Token[] = [];
  const jsonReads = typedJsonReads(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.generated) { out.push(token); continue; }
    const jsonRead = jsonReads.get(token);
    if (jsonRead) { out.push(generated(jsonRead)); continue; }
    const next = nextSignificant(tokens, i);
    const nextToken = next === undefined ? undefined : tokens[next];
    if (token.kind === "punct" && token.text === "==") { out.push({ ...token, text: "=" }); continue; }
    if (token.kind === "punct" && token.text === "(" && nextToken?.kind === "punct" && nextToken.text === ")" && isWord(previousSignificant(out), "IN")) {
      out.push(...raw("(SELECT NULL WHERE FALSE)"));
      i = next!;
      continue;
    }
    // SQLite's 0 and 1 stand for false and true where a condition is expected (`WHERE 1=1 AND 0`).
    if (token.kind === "number" && (token.text === "0" || token.text === "1") && isWord(previousSignificant(out), "WHERE", "AND", "OR", "NOT", "HAVING")
      && (nextToken === undefined || isWord(nextToken, "AND", "OR", "GROUP", "ORDER", "LIMIT", "HAVING", "UNION") || nextToken.text === ")")) {
      out.push(generated(token.text === "1" ? "TRUE" : "FALSE"));
      continue;
    }
    if (token.kind !== "word") { out.push(token); continue; }
    const word = token.text.toUpperCase();
    if (word === "IS") {
      const afterNot = isWord(nextToken, "NOT") ? nextSignificant(tokens, next!) : next;
      const operand = afterNot === undefined ? undefined : tokens[afterNot];
      if (!isWord(operand, "NULL", "TRUE", "FALSE", "DISTINCT", "UNKNOWN")) {
        out.push(generated(isWord(nextToken, "NOT") ? "IS DISTINCT FROM" : "IS NOT DISTINCT FROM"));
        if (isWord(nextToken, "NOT")) i = next!;
        continue;
      }
    }
    if (word === "LIKE") { out.push(generated("ILIKE")); continue; }
    // SQLite's index hints; PostgreSQL's planner takes none.
    if (word === "INDEXED" && isWord(nextToken, "BY")) { i = nextSignificant(tokens, next!)!; continue; }
    if (word === "NOT" && isWord(nextToken, "INDEXED")) { i = next!; continue; }
    if (word === "COLLATE") {
      const collation = upper(nextToken);
      out.push(token, space, generated(collation === "NOCASE" ? '"nocase"' : '"C"'));
      i = next!;
      continue;
    }
    if (word === "AS" && isWord(nextToken, "INTEGER", "INT", "REAL", "BLOB")) {
      out.push(token, space, generated(columnType(nextToken!.text)));
      i = next!;
      continue;
    }
    const callsFunction = nextToken?.kind === "punct" && nextToken.text === "(";
    if (callsFunction && RENAMED_FUNCTIONS[word]) { out.push(generated(RENAMED_FUNCTIONS[word])); continue; }
    // json_group_array gives SQLite's text, which json_each and json_extract read back; json_agg alone gives JSON.
    if (callsFunction && word === "JSON_GROUP_ARRAY") {
      const close = matching(tokens, next!);
      out.push(generated("(json_agg"), ...translateTokens(tokens.slice(next!, close + 1)), generated(")::TEXT"));
      i = close;
      continue;
    }
    if (callsFunction && (word === "MAX" || word === "MIN") && hasTopLevelComma(tokens, next!)) {
      out.push(generated(word === "MAX" ? "sqlite_max" : "sqlite_min"));
      continue;
    }
    const mixedCase = /[a-z]/.test(token.text) && /[A-Z]/.test(token.text);
    if ((mixedCase && !callsFunction) || POSTGRES_ONLY_RESERVED.has(word)) { out.push({ ...token, kind: "quoted", text: quoteIdentifier(token.text) }); continue; }
    out.push(token);
  }
  return out;
}

/*
 * SQLite's json_extract returns a number for a JSON number and text for a string; PostgreSQL's
 * function has one return type, text, which comparisons need. Where the type reaches the caller,
 * another reads the value: a result column that is only `json_extract(…)` comes back as JSON and
 * is decoded to its JavaScript type, and `coalesce(json_extract(…), 0)` reads a number.
 */
function typedJsonReads(tokens: Token[]): Map<Token, string> {
  const reads = new Map<Token, string>();
  const at = (index: number | undefined) => (index === undefined ? undefined : tokens[index]);
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], "COALESCE", "IFNULL") || at(nextSignificant(tokens, i))?.text !== "(") continue;
    const open = nextSignificant(tokens, i)!;
    const args = splitTopLevel(tokens.slice(open + 1, matching(tokens, open)));
    if (!args.some((arg) => significant(arg).length === 1 && significant(arg)[0].kind === "number")) continue;
    for (const arg of args) {
      const words = significant(arg);
      if (isWord(words[0], "JSON_EXTRACT") && words.at(-1)?.text === ")" && splitTopLevel(words.slice(2, -1)).length === 2) reads.set(words[0], "sqlite_json_number");
    }
  }
  // Only a query's own result columns: an INSERT … SELECT would store the JSON text of a string.
  if (!isWord(significant(tokens)[0], "SELECT")) return reads;
  const select = tokens.indexOf(significant(tokens)[0]);
  let end = topLevelWord(tokens, select, "FROM");
  if (end < 0) end = tokens.length;
  for (const column of splitTopLevel(tokens.slice(select + 1, end))) {
    const words = significant(column);
    if (!isWord(words[0], "JSON_EXTRACT") || words[1]?.text !== "(") continue;
    const close = matching(words, 1);
    // Several paths return an array, which is already text in PostgreSQL.
    if (splitTopLevel(words.slice(2, close)).length !== 2) continue;
    const rest = words.slice(close + 1);
    const aliasOnly = rest.length === 0 || (rest.length === 1 && rest[0].kind !== "punct") || (rest.length === 2 && isWord(rest[0], "AS"));
    if (aliasOnly) reads.set(words[0], "sqlite_json_typed");
  }
  return reads;
}

function nextSignificant(tokens: Token[], from: number): number | undefined {
  for (let i = from + 1; i < tokens.length; i++) if (tokens[i].kind !== "space") return i;
  return undefined;
}
function previousSignificant(tokens: Token[]): Token | undefined {
  for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].kind !== "space") return tokens[i];
  return undefined;
}
function matching(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].kind === "punct" && tokens[i].text === "(") depth++;
    if (tokens[i].kind === "punct" && tokens[i].text === ")" && --depth === 0) return i;
  }
  throw new Error("Unbalanced parentheses in SQL");
}
function hasTopLevelComma(tokens: Token[], open: number): boolean {
  const close = matching(tokens, open);
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i];
    if (token.kind === "punct" && token.text === "(") depth++;
    if (token.kind === "punct" && token.text === ")") depth--;
    if (token.kind === "punct" && token.text === "," && depth === 0) return true;
  }
  return false;
}

/** Writes tokens as PostgreSQL text, numbering parameters `$1…` in order of appearance. */
export function render(tokens: Token[]): Query {
  const args: number[] = [];
  const numbers = new Map<number, number>();
  let text = "";
  for (const token of tokens) {
    if (token.kind === "space") { if (text && !text.endsWith(" ")) text += " "; continue; }
    if (token.kind !== "param") { text += token.text; continue; }
    let number = numbers.get(token.index!);
    if (number === undefined) { args.push(token.index!); numbers.set(token.index!, number = args.length); }
    text += `$${number}`;
  }
  return { text: text.trim(), args };
}

const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER"]);

/** Plans one SQLite statement. */
export function planStatement(tokens: Token[], schema: SchemaLookup): Plan {
  const words = significant(tokens);
  const first = upper(words[0]);
  if (first === "PRAGMA") return planPragma(words);
  const transaction = planTransaction(words);
  if (transaction) return transaction;
  if (first === "CREATE") return planCreate(tokens, words);
  if (first === "DROP") return planDrop(tokens, words);
  if (first === "ALTER") return planAlter(tokens, words);
  if (first === "INSERT" || first === "REPLACE") return planInsert(tokens, schema);
  if (first === "UPDATE" && isWord(words[1], "OR")) return planUpdateOr(tokens, words);
  const write = WRITES.has(first) || (first === "WITH" && words.some((token) => isWord(token, "INSERT", "UPDATE", "DELETE", "REPLACE")));
  const reads = first === "SELECT" ? selectList(distinctAsGroups(tokens)) : first === "WITH" && !write ? selectList(tokens) : tokens;
  return query(translateTokens(reads), write, tokens);
}

function query(translated: Token[], write: boolean, source: Token[], extra: Partial<Extract<Plan, { kind: "query" }>> = {}): Plan {
  return { kind: "query", query: render(translated), write, keepsRowid: source.some((token) => isWord(token, "ROWID")), tables: [], ...extra };
}

/* SQLite lets SELECT DISTINCT order by any expression of its columns; PostgreSQL only by the
   columns themselves. Grouping by the selected columns returns the same rows and may be ordered so. */
function distinctAsGroups(tokens: Token[]): Token[] {
  const words = significant(tokens);
  if (!isWord(words[1], "DISTINCT")) return tokens;
  const distinctAt = tokens.indexOf(words[1]);
  const from = topLevelWord(tokens, distinctAt, "FROM");
  const order = topLevelWord(tokens, distinctAt, "ORDER");
  if (from < 0 || order < 0 || topLevelWord(tokens, from, "GROUP") >= 0 || topLevelWord(tokens, from, "UNION") >= 0) return tokens;
  const columns = splitTopLevel(tokens.slice(distinctAt + 1, from)).map(significant);
  const plain = columns.every((column) => column.every((token, index) => (index % 2 === 0 ? token.kind === "word" || token.kind === "quoted" : token.text === ".")));
  if (!plain) return tokens;
  const groups = columns.map((column) => column.map((token) => token.text).join("")).join(", ");
  return [...tokens.slice(0, distinctAt), ...tokens.slice(distinctAt + 1, order), ...raw(`GROUP BY ${groups} `), ...tokens.slice(order)];
}

const AGGREGATES = new Set(["COUNT", "SUM", "MIN", "MAX", "AVG", "TOTAL", "GROUP_CONCAT", "JSON_GROUP_ARRAY", "JSON_GROUP_OBJECT", "STRING_AGG"]);
const NOT_AN_ALIAS_AFTER = new Set(["AS", "NOT", "IS", "AND", "OR", "ELSE", "THEN", "WHEN", "IN", "LIKE", "BETWEEN", "COLLATE", "DISTINCT", "ESCAPE", "CASE"]);

/* A result column's expression and its alias, if it has one. */
function selectColumn(column: Token[]): { expression: Token[]; alias?: Token } {
  const parts = significant(column);
  const last = parts.at(-1)!;
  const before = parts.at(-2);
  if (parts.length > 2 && isWord(before, "AS")) return { expression: parts.slice(0, -2), alias: last };
  const alias = parts.length > 1 && (last.kind === "word" || last.kind === "quoted") && !isWord(last, "END", "NULL", "TRUE", "FALSE")
    && before!.text !== "." && !NOT_AN_ALIAS_AFTER.has(upper(before));
  return alias ? { expression: parts.slice(0, -1), alias: last } : { expression: parts };
}

/*
 * A top-level SELECT's result columns, rewritten where PostgreSQL reads them otherwise:
 * - an alias written without AS gets one, since PostgreSQL takes words such as `minute` for keywords;
 * - SQLite lets a grouped query select a column it neither groups nor aggregates, taking it from one
 *   of the group's rows; PostgreSQL refuses, so such a column is read through min(), one of those values.
 */
function selectList(tokens: Token[]): Token[] {
  // The statement's own SELECT: after a WITH clause's parenthesised queries.
  const selectAt = topLevelWord(tokens, 0, "SELECT");
  if (selectAt < 0) return tokens;
  const words = significant(tokens.slice(selectAt));
  const from = topLevelWord(tokens, selectAt, "FROM");
  if (from < 0 || topLevelWord(tokens, from, "UNION") >= 0) return tokens;
  const group = topLevelWord(tokens, from, "GROUP");
  const key = (part: Token[]) => significant(part).map((token) => token.text.toLowerCase()).join("");
  let grouped: Set<string> | undefined;
  if (group >= 0) {
    const byAt = nextSignificant(tokens, group)!;
    const ends = ["HAVING", "ORDER", "LIMIT", "WINDOW"].map((word) => topLevelWord(tokens, byAt, word)).filter((index) => index >= 0);
    grouped = new Set(splitTopLevel(tokens.slice(byAt + 1, ends.length ? Math.min(...ends) : tokens.length)).map(key));
  }
  const listStart = isWord(words[1], "DISTINCT", "ALL") ? tokens.indexOf(words[1]) + 1 : selectAt + 1;
  const out: Token[] = [...tokens.slice(0, listStart)];
  let rewritten = false;
  splitTopLevel(tokens.slice(listStart, from)).forEach((column, index) => {
    if (index) out.push({ kind: "punct", text: ",", generated: true });
    const { expression, alias } = selectColumn(column);
    const aggregated = expression.some((token, at) => AGGREGATES.has(upper(token)) && expression[at + 1]?.text === "(");
    const bare = grouped !== undefined && !aggregated && !grouped.has(key(expression)) && !grouped.has(String(index + 1)) && !(alias && grouped.has(alias.text.toLowerCase()))
      && !expression.some((token) => token.text === "*") && expression.some((token) => token.kind === "word" || token.kind === "quoted");
    const bareAlias = alias !== undefined && !isWord(significant(column).at(-2), "AS");
    if (!bare && !bareAlias) { out.push(space, ...column); return; }
    rewritten = true;
    const written = column.slice(0, column.indexOf(expression.at(-1)!) + 1);
    const body = bare ? [...raw("min("), ...written, ...raw(")")] : written;
    out.push(space, ...body, ...(alias ? [space, generated("AS"), space, alias] : []));
  });
  return rewritten ? [...out, space, ...tokens.slice(from)] : tokens;
}

function planTransaction(words: Token[]): Plan | undefined {
  const [a, b] = words.map(upper);
  const name = (index: number) => identifier(words[index]);
  if (a === "BEGIN") return { kind: "transaction", op: b === "IMMEDIATE" || b === "EXCLUSIVE" ? "beginImmediate" : "begin" };
  if (a === "COMMIT" || a === "END") return { kind: "transaction", op: "commit" };
  if (a === "SAVEPOINT") return { kind: "transaction", op: "savepoint", name: name(1) };
  if (a === "RELEASE") return { kind: "transaction", op: "release", name: name(b === "SAVEPOINT" ? 2 : 1) };
  if (a === "ROLLBACK") {
    const to = words.findIndex((token) => isWord(token, "TO"));
    if (to < 0) return { kind: "transaction", op: "rollback" };
    return { kind: "transaction", op: "rollbackTo", name: name(isWord(words[to + 1], "SAVEPOINT") ? to + 2 : to + 1) };
  }
  return undefined;
}

/* The pragmas the stores run. Connection tuning means nothing to PostgreSQL; `table_info` and
   `user_version` read what SQLite would. */
function planPragma(words: Token[]): Plan {
  const name = upper(words[1]);
  const assigned = words[2]?.kind === "punct" && words[2].text === "=" ? words[3] : undefined;
  if (name === "TABLE_INFO") {
    const table = identifier(words[3]).replace(/^'|'$/g, "");
    return { kind: "query", query: { text: `SELECT * FROM pragma_table_info('${table.replaceAll("'", "''")}')`, args: [] }, write: false, keepsRowid: false, tables: [] };
  }
  if (name === "USER_VERSION") {
    if (assigned) return { kind: "pragmaWrite", name: "user_version", value: Number(assigned.text) };
    return { kind: "query", query: { text: "SELECT COALESCE((SELECT value FROM sqlite_pragma WHERE name = 'user_version'), 0) AS user_version", args: [] }, write: false, keepsRowid: false, tables: [] };
  }
  if (name === "SCHEMA_VERSION") return { kind: "query", query: { text: "SELECT schema_version FROM pragma_schema_version", args: [] }, write: false, keepsRowid: false, tables: [] };
  if (assigned) return { kind: "rows", rows: [] };
  const answers: Record<string, Record<string, unknown>> = {
    JOURNAL_MODE: { journal_mode: "wal" }, BUSY_TIMEOUT: { timeout: 5000 }, FOREIGN_KEYS: { foreign_keys: 1 }, SYNCHRONOUS: { synchronous: 1 },
  };
  const answer = answers[name];
  if (!answer) throw new Error(`PRAGMA ${words[1].text} is not supported with PostgreSQL`);
  return { kind: "rows", rows: [answer] };
}

const CONSTRAINT_START = new Set(["CONSTRAINT", "PRIMARY", "NOT", "NULL", "UNIQUE", "CHECK", "DEFAULT", "COLLATE", "REFERENCES", "GENERATED", "AS"]);
const TABLE_CONSTRAINT = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]);

/** The SQLite text SQLite itself keeps in sqlite_master: without `IF NOT EXISTS`. */
function storedSql(tokens: Token[]): string {
  return tokens.map((token) => token.text).join("").trim().replace(/\s+IF\s+NOT\s+EXISTS\b/i, "");
}

function planCreate(tokens: Token[], words: Token[]): Plan {
  const kinds = words.slice(1, 4).map(upper);
  if (kinds[0] === "TABLE" || kinds[1] === "TABLE") return planCreateTable(tokens, words);
  if (kinds[0] === "INDEX" || kinds[1] === "INDEX") return planCreateIndex(tokens, words);
  if (kinds[0] === "TRIGGER" || kinds[1] === "TRIGGER") return planCreateTrigger(tokens, words);
  return query(translateTokens(tokens), true, tokens);
}

function objectName(words: Token[], keyword: string): { name: string; at: number; ifNotExists: boolean } {
  let at = words.findIndex((token) => isWord(token, keyword)) + 1;
  const ifNotExists = isWord(words[at], "IF");
  if (ifNotExists) at += 3;
  return { name: identifier(words[at]), at, ifNotExists };
}

function planCreateTable(tokens: Token[], words: Token[]): Plan {
  const { name, ifNotExists } = objectName(words, "TABLE");
  const temporary = isWord(words[1], "TEMP", "TEMPORARY");
  const open = tokens.findIndex((token) => token.kind === "punct" && token.text === "(");
  const asSelect = words.findIndex((token) => isWord(token, "AS"));
  if (open < 0 || (asSelect >= 0 && tokens.indexOf(words[asSelect]) < open)) return query(translateTokens(tokens), true, tokens);
  const close = matching(tokens, open);
  const definitions = splitTopLevel(tokens.slice(open + 1, close));
  const options = significant(tokens.slice(close + 1)).map(upper);
  const columns = definitions.map(translateDefinition);
  const integerKey = columns.some((column) => column.integerKey);
  const named = columns.some((column) => column.name?.toLowerCase() === "rowid");
  const parts = columns.map((column) => column.text).filter(Boolean);
  if (!options.includes("WITHOUT") && !integerKey && !named) parts.push("rowid BIGINT GENERATED BY DEFAULT AS IDENTITY UNIQUE");
  const head = render(translateTokens(tokens.slice(0, open))).text;
  const triggers = referenceTriggers(name, columns.flatMap((column) => (column.foreignKey ? [column.foreignKey] : [])));
  const text = [`${head} (${parts.join(", ")})`, ...triggers].join("; ");
  const change: SchemaChange | undefined = temporary ? undefined : { op: "create", type: "table", name, table: name, sql: storedSql(tokens), ifNotExists };
  return { kind: "query", query: { text, args: [] }, write: true, keepsRowid: true, tables: [name], ...(change ? { change } : {}) };
}

function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "punct" && token.text === "(") depth++;
    if (token.kind === "punct" && token.text === ")") depth--;
    if (token.kind === "punct" && token.text === "," && depth === 0) { parts.push([]); continue; }
    parts.at(-1)!.push(token);
  }
  return parts.filter((part) => significant(part).length);
}

/** One column or table constraint of CREATE TABLE / ADD COLUMN, in PostgreSQL. */
interface ForeignKey { columns: string[]; parent: string; parentColumns: string[]; onDelete: string }
interface Definition { text: string; name?: string; integerKey: boolean; foreignKey?: ForeignKey }

export function translateDefinition(tokens: Token[]): Definition {
  const all = significant(tokens);
  const { words, reference } = withoutReference(all);
  if (isWord(words[0], "FOREIGN")) {
    const close = matching(words, 2);
    const columns = splitTopLevel(words.slice(3, close)).map((part) => identifier(significant(part)[0]));
    return { text: "", integerKey: false, ...(reference ? { foreignKey: { ...reference, columns } } : {}) };
  }
  if (TABLE_CONSTRAINT.has(upper(words[0]))) return { text: render(translateTokens(spaced(stripConflictClauses(words)))).text, integerKey: false };
  const name = identifier(words[0]);
  let at = 1;
  const typeWords: string[] = [];
  while (at < words.length && !CONSTRAINT_START.has(upper(words[at]))) {
    if (words[at].kind === "punct" && words[at].text === "(") { at = matching(words, at) + 1; continue; }
    typeWords.push(words[at].text);
    at++;
  }
  const declared = typeWords.join(" ");
  const constraints = stripConflictClauses(words.slice(at));
  const primary = constraints.some((token) => isWord(token, "PRIMARY"));
  const integerKey = primary && declared.toUpperCase() === "INTEGER";
  const type = integerKey ? "BIGINT GENERATED BY DEFAULT AS IDENTITY" : columnType(declared);
  const rest = constraints.filter((token) => !isWord(token, "AUTOINCREMENT") && !(primary && isWord(token, "ASC", "DESC")));
  const collates = rest.some((token) => isWord(token, "COLLATE"));
  const collation = type === "TEXT" && !collates ? ' COLLATE "C"' : "";
  const tail = render(translateTokens(spaced(rest))).text;
  return { text: `${sqlName(name)} ${type}${collation}${tail ? ` ${tail}` : ""}`, name, integerKey, ...(reference ? { foreignKey: { ...reference, columns: [name] } } : {}) };
}

/*
 * SQLite checks foreign keys only on connections that turn them on, and most of this node's
 * connections do not: a row may name a parent that does not exist. PostgreSQL always checks. So a
 * REFERENCES clause is not kept as a constraint; its ON DELETE action becomes a trigger on the parent.
 */
function withoutReference(words: Token[]): { words: Token[]; reference?: Omit<ForeignKey, "columns"> } {
  const at = words.findIndex((token) => isWord(token, "REFERENCES"));
  if (at < 0) return { words };
  const parent = identifier(words[at + 1]);
  let end = at + 2;
  let parentColumns: string[] = [];
  if (words[end]?.text === "(") {
    const close = matching(words, end);
    parentColumns = splitTopLevel(words.slice(end + 1, close)).map((part) => identifier(significant(part)[0]));
    end = close + 1;
  }
  let onDelete = "";
  for (;;) {
    if (isWord(words[end], "ON") && isWord(words[end + 1], "DELETE", "UPDATE")) {
      const length = isWord(words[end + 2], "SET", "NO") ? 2 : 1;
      if (isWord(words[end + 1], "DELETE")) onDelete = words.slice(end + 2, end + 2 + length).map(upper).join(" ");
      end += 2 + length;
    } else if (isWord(words[end], "MATCH", "INITIALLY") || (isWord(words[end], "NOT") && isWord(words[end + 1], "DEFERRABLE"))) end += 2;
    else if (isWord(words[end], "DEFERRABLE")) end += 1;
    else break;
  }
  const kept = [...words.slice(0, at), ...words.slice(end)];
  return { words: kept, reference: { parent, parentColumns, onDelete } };
}

/**
 * The ON DELETE CASCADE / SET NULL of `child`'s references, as triggers on their parents. SQLite lets
 * a table refer to one not created yet, so each is recorded and installed once its parent exists,
 * now or when that table is created (`sqlite_install_references`, run after every CREATE TABLE).
 */
function referenceTriggers(child: string, keys: ForeignKey[]): string[] {
  const recorded = keys.filter((key) => key.onDelete === "CASCADE" || key.onDelete === "SET NULL").map((key) => {
    const name = quoteIdentifier(`sqlite_fk_${child}_${key.columns.join("_")}`.slice(0, 63));
    const parentColumns = key.parentColumns.length ? key.parentColumns : key.columns;
    const match = key.columns.map((column, index) => `${sqlName(column)} = OLD.${sqlName(parentColumns[index])}`).join(" AND ");
    const action = key.onDelete === "CASCADE" ? `DELETE FROM ${sqlName(child)} WHERE ${match}` : `UPDATE ${sqlName(child)} SET ${key.columns.map((column) => `${sqlName(column)} = NULL`).join(", ")} WHERE ${match}`;
    const routine = `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $jb$ BEGIN ${action}; RETURN NULL; END $jb$`;
    const trigger = `CREATE OR REPLACE TRIGGER ${name} AFTER DELETE ON ${sqlName(key.parent)} FOR EACH ROW EXECUTE FUNCTION ${name}()`;
    return `INSERT INTO sqlite_foreign_keys VALUES (${[name.slice(1, -1).replaceAll('""', '"'), key.parent, routine, trigger].map(literal).join(", ")}) ON CONFLICT (name) DO UPDATE SET parent = EXCLUDED.parent, routine = EXCLUDED.routine, trigger = EXCLUDED.trigger`;
  });
  return [...recorded, "SELECT sqlite_install_references()"];
}

/** `ON CONFLICT <algorithm>` inside a constraint is SQLite's own; PostgreSQL decides per statement. */
function stripConflictClauses(words: Token[]): Token[] {
  const kept: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    if (isWord(words[i], "ON") && isWord(words[i + 1], "CONFLICT")) { i += 2; continue; }
    kept.push(words[i]);
  }
  return kept;
}
function spaced(words: Token[]): Token[] {
  return words.flatMap((token, index) => (index ? [space, token] : [token]));
}

function planCreateIndex(tokens: Token[], words: Token[]): Plan {
  const { name, ifNotExists } = objectName(words, "INDEX");
  const on = words.findIndex((token) => isWord(token, "ON"));
  const table = identifier(words[on + 1]);
  return query(translateTokens(tokens), true, tokens, { change: { op: "create", type: "index", name, table, sql: storedSql(tokens), ifNotExists }, tables: [table] });
}

/* SQLite: CREATE TRIGGER [IF NOT EXISTS] n AFTER INSERT|DELETE|UPDATE [OF cols] ON t [WHEN cond] BEGIN …; END.
   PostgreSQL runs the body from a function the trigger names. */
function planCreateTrigger(tokens: Token[], words: Token[]): Plan {
  const { name, at, ifNotExists } = objectName(words, "TRIGGER");
  const on = words.findIndex((token, index) => index > at && isWord(token, "ON"));
  const table = identifier(words[on + 1]);
  const timing = words.slice(at + 1, on).map((token) => token.text).join(" ");
  const when = words.findIndex((token, index) => index > on && isWord(token, "WHEN"));
  const begin = words.findIndex((token, index) => index > on && isWord(token, "BEGIN"));
  const end = words.length - 1 - [...words].reverse().findIndex((token) => isWord(token, "END"));
  const condition = when >= 0 ? render(translateTokens(spaced(words.slice(when + 1, begin)))).text : "";
  const body = render(translateTokens(spaced(words.slice(begin + 1, end)))).text;
  const functionName = quoteIdentifier(`${name}_fn`);
  const text = [
    `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $jb$ BEGIN ${body}${body.trim().endsWith(";") ? "" : ";"} RETURN NULL; END $jb$;`,
    `${ifNotExists ? `DROP TRIGGER IF EXISTS ${sqlName(name)} ON ${sqlName(table)}; ` : ""}CREATE TRIGGER ${sqlName(name)} ${timing} ON ${sqlName(table)} FOR EACH ROW${condition ? ` WHEN (${condition})` : ""} EXECUTE FUNCTION ${functionName}()`,
  ].join(" ");
  return { kind: "query", query: { text, args: [] }, write: true, keepsRowid: true, tables: [table], change: { op: "create", type: "trigger", name, table, sql: storedSql(tokens), ifNotExists } };
}

function planDrop(tokens: Token[], words: Token[]): Plan {
  const type = upper(words[1]).toLowerCase();
  const ifExists = isWord(words[2], "IF");
  const name = identifier(words[ifExists ? 4 : 2]);
  if (type === "trigger") {
    return { kind: "query", query: { text: `DO $jb$ DECLARE t text; BEGIN SELECT tbl_name INTO t FROM sqlite_master WHERE type = 'trigger' AND name = ${literal(name)}; IF t IS NOT NULL THEN EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', ${literal(name)}, t); END IF; END $jb$`, args: [] }, write: true, keepsRowid: false, tables: [], change: { op: "drop", type: "trigger", name } };
  }
  if (type !== "table" && type !== "index") return query(translateTokens(tokens), true, tokens);
  return query(translateTokens(tokens), true, tokens, { change: { op: "drop", type, name }, tables: [name] });
}

export function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function planAlter(tokens: Token[], words: Token[]): Plan {
  const table = identifier(words[2]);
  const action = words.slice(3).map(upper);
  if (action[0] === "ADD") {
    const start = action[1] === "COLUMN" ? 5 : 4;
    const definition = translateDefinition(spaced(words.slice(start)));
    const sqliteDefinition = words.slice(start).map((token) => token.text).join(" ");
    return { kind: "query", query: { text: `ALTER TABLE ${sqlName(table)} ADD COLUMN ${definition.text}`, args: [] }, write: true, keepsRowid: false, tables: [table], change: { op: "addColumn", table, definition: sqliteDefinition } };
  }
  if (action[0] === "RENAME" && action[1] === "TO") {
    return query(translateTokens(tokens), true, tokens, { change: { op: "renameTable", from: table, to: identifier(words[5]) }, tables: [table, identifier(words[5])] });
  }
  if (action[0] === "RENAME") {
    const from = identifier(words[action[1] === "COLUMN" ? 5 : 4]);
    const to = identifier(words.at(-1)!);
    return query(translateTokens(tokens), true, tokens, { change: { op: "renameColumn", table, from, to }, tables: [table] });
  }
  if (action[0] === "DROP") {
    const column = identifier(words.at(-1)!);
    return query(translateTokens(tokens), true, tokens, { change: { op: "dropColumn", table, column }, tables: [table] });
  }
  return query(translateTokens(tokens), true, tokens, { tables: [table] });
}

/* INSERT [OR IGNORE|REPLACE|…] INTO t [(cols)] VALUES…|SELECT…|DEFAULT VALUES [ON CONFLICT…] [RETURNING…] */
function planInsert(tokens: Token[], schema: SchemaLookup): Plan {
  const positions = tokens.map((token, index) => ({ token, index })).filter(({ token }) => token.kind !== "space");
  const first = upper(positions[0].token);
  const conflict = first === "REPLACE" ? "REPLACE" : isWord(positions[1].token, "OR") ? upper(positions[2].token) : "";
  const into = positions.findIndex(({ token }) => isWord(token, "INTO"));
  const tableName = identifier(positions[into + 1].token);
  let afterTable = positions[into + 2];
  if (isWord(afterTable?.token, "AS")) afterTable = positions[into + 4];
  const body = tokens.slice(positions[into].index + 1);
  const shape = (): TableShape => {
    const found = schema.table(tableName);
    if (!found) throw new Error(`no such table: ${tableName}`);
    return found;
  };
  let columns: string[] | undefined;
  let rewritten: Token[] = [generated("INSERT INTO"), space, ...body];
  if (afterTable?.token.kind === "punct" && afterTable.token.text === "(") {
    const close = matching(tokens, afterTable.index);
    columns = splitTopLevel(tokens.slice(afterTable.index + 1, close)).map((part) => identifier(significant(part)[0]));
  } else if (!isWord(afterTable?.token, "DEFAULT")) {
    columns = shape().columns;
    const tableEnd = afterTable ? body.indexOf(afterTable.token) : body.length;
    rewritten = [generated("INSERT INTO"), space, ...body.slice(0, tableEnd), ...raw(` (${columns.map(quoteIdentifier).join(", ")}) `), ...body.slice(tableEnd)];
  }
  const tables = [tableName];
  const alias = isWord(positions[into + 2]?.token, "AS") ? identifier(positions[into + 3].token) : tableName;
  rewritten = qualifyUpsert(rewritten, alias, () => shape().columns);
  if (conflict === "IGNORE") rewritten = beforeReturning(rewritten, raw(" ON CONFLICT DO NOTHING"));
  if (conflict === "REPLACE") {
    const keys = shape().uniqueKeys;
    if (!keys.length) throw new Error(`INSERT OR REPLACE into ${tableName} needs a primary key or unique index with PostgreSQL`);
    const key = keys[0];
    const updates = (columns ?? shape().columns).filter((column) => !key.includes(column));
    const action = updates.length ? `DO UPDATE SET ${updates.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(", ")}` : "DO NOTHING";
    rewritten = beforeReturning(rewritten, raw(` ON CONFLICT (${key.map(quoteIdentifier).join(", ")}) ${action}`));
  }
  return query(translateTokens(rewritten), true, tokens, { tables });
}

/* In ON CONFLICT … DO UPDATE, SQLite reads a bare column as the existing row's; PostgreSQL calls it
   ambiguous with EXCLUDED's. Such columns are qualified with the target table. */
function qualifyUpsert(tokens: Token[], table: string, columns: () => string[]): Token[] {
  const doAt = tokens.findIndex((token, index) => !token.generated && isWord(token, "DO") && isWord(tokens[nextSignificant(tokens, index) ?? -1], "UPDATE"));
  if (doAt < 0) return tokens;
  const names = new Set(columns().map((column) => column.toLowerCase()));
  const out = tokens.slice(0, doAt);
  let depth = 0;
  let target = false;
  for (let i = doAt; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "punct" && token.text === "(") depth++;
    if (token.kind === "punct" && token.text === ")") depth--;
    if (depth === 0 && (isWord(token, "SET") || (token.kind === "punct" && token.text === ","))) target = true;
    else if (depth === 0 && token.kind === "punct" && token.text === "=") target = false;
    else if (depth === 0 && isWord(token, "WHERE", "RETURNING")) target = false;
    const before = previousSignificant(out);
    const after = tokens[nextSignificant(tokens, i) ?? -1];
    const bare = token.kind === "word" && !target && names.has(token.text.toLowerCase())
      && !(before?.kind === "punct" && before.text === ".") && !(after?.kind === "punct" && (after.text === "(" || after.text === "."));
    out.push(bare ? { kind: "word", text: `${sqlName(table)}.${sqlName(token.text)}`, generated: true } : token);
    if (isWord(token, "RETURNING") && depth === 0) { out.push(...tokens.slice(i + 1)); break; }
  }
  return out;
}

function beforeReturning(tokens: Token[], clause: Token[]): Token[] {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "punct" && token.text === "(") depth++;
    if (token.kind === "punct" && token.text === ")") depth--;
    if (depth === 0 && !token.generated && isWord(token, "RETURNING")) return [...tokens.slice(0, i), ...clause, space, ...tokens.slice(i)];
  }
  return [...tokens, ...clause];
}

/* UPDATE OR IGNORE skips each row whose new values would break a unique key, and updates the rest.
   PostgreSQL has no such statement, so the rows are updated one by one and a conflicting one is left. */
function planUpdateOr(tokens: Token[], words: Token[]): Plan {
  const conflict = upper(words[2]);
  const table = identifier(words[3]);
  const tableAt = tokens.indexOf(words[3]);
  if (conflict !== "IGNORE") return query(translateTokens([generated("UPDATE"), space, ...tokens.slice(tableAt)]), true, tokens);
  const whereAt = topLevelWord(tokens, tableAt, "WHERE");
  const set = tokens.slice(tableAt + 1, whereAt < 0 ? tokens.length : whereAt);
  const where = whereAt < 0 ? raw("TRUE") : tokens.slice(whereAt + 1);
  const select = render(translateTokens([...raw(`SELECT rowid FROM ${sqlName(table)} WHERE `), ...where]));
  const highest = tokens.reduce((max, token) => (token.kind === "param" ? Math.max(max, token.index! + 1) : max), 0);
  const update = render(translateTokens([...raw(`UPDATE ${sqlName(table)} `), ...set, ...raw(" WHERE rowid = "), { kind: "param", text: "?", index: highest, generated: true }]));
  return { kind: "updateOrIgnore", select, update, tables: [table] };
}

function topLevelWord(tokens: Token[], from: number, word: string): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "punct" && token.text === "(") depth++;
    if (token.kind === "punct" && token.text === ")") depth--;
    if (depth === 0 && isWord(token, word)) return i;
  }
  return -1;
}
