import { StatementSync } from "node:sqlite";

export interface Counted<T> {
  result: T;
  /** The text of every statement that was run, once per run. */
  statements: string[];
  /** How many times JSON was parsed. */
  parses: number;
}

const METHODS = ["get", "all", "run", "iterate"] as const;

function start(): { statements: string[]; parses: () => number; stop: () => void } {
  const statements: string[] = [];
  let parses = 0;
  const original = Object.fromEntries(METHODS.map((method) => [method, StatementSync.prototype[method]])) as unknown as Record<(typeof METHODS)[number], (...args: unknown[]) => unknown>;
  for (const method of METHODS) {
    (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]): unknown {
      statements.push(this.sourceSQL);
      return original[method].apply(this, args);
    };
  }
  const parse = JSON.parse;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parses++; return parse(...args); }) as typeof JSON.parse;
  return {
    statements,
    parses: () => parses,
    stop: () => {
      for (const method of METHODS) (StatementSync.prototype as unknown as Record<string, unknown>)[method] = original[method];
      JSON.parse = parse;
    },
  };
}

/**
 * Runs `work` and reports the SQL statements it ran and how often it parsed JSON. It counts
 * what the application code really does: the statement methods and `JSON.parse` are replaced
 * for the length of the call. A cache proves itself with it: the second identical read runs
 * none of the queries the first one ran.
 */
export function counting<T>(work: () => T): Counted<T> {
  const counter = start();
  try { return { result: work(), statements: counter.statements, parses: counter.parses() }; }
  finally { counter.stop(); }
}

export async function countingAsync<T>(work: () => Promise<T>): Promise<Counted<T>> {
  const counter = start();
  try { return { result: await work(), statements: counter.statements, parses: counter.parses() }; }
  finally { counter.stop(); }
}

/** How many of the counted statements read or wrote the named table. */
export function touching(counted: Counted<unknown>, table: string): number {
  return counted.statements.filter((sql) => sql.includes(table)).length;
}
