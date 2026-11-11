import { DatabaseSync } from "node:sqlite";

// The node database for the service's own scripts: node.db, or the PostgreSQL database that
// JOINT_BOB_DATABASE_URL names, opened through the service's module (docs/postgres-node-database.md).
const postgres = process.env.JOINT_BOB_DATABASE_URL?.trim() ? await import("../dist/node-database.js") : undefined;

export function openNodeDatabase(file, options = {}) {
  return postgres ? postgres.openNodeDatabase(file) : new DatabaseSync(file, options);
}
