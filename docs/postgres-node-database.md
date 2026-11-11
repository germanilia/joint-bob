# PostgreSQL node database

By default a node keeps its database in SQLite, in `node.db` in its data directory (`~/.joint-bob`). A node can keep the same database in PostgreSQL instead.

## Turn it on

1. Create an empty PostgreSQL 16 (or newer) database for this node. Each node needs its own database, because twins and cluster peers replicate between their own databases and never share one.
2. Add the connection string to the node's `~/.joint-bob/env`:

   ```bash
   JOINT_BOB_DATABASE_URL=postgres://joint_bob:PASSWORD@127.0.0.1:5432/joint_bob_node
   ```

3. Restart the service.

The variable is read when the service starts. The start-up log names the database without its password, for example `Node database: PostgreSQL (127.0.0.1:5432/joint_bob_node)`. If PostgreSQL cannot be reached, the service stops instead of starting.

The node starts with an empty database: projects, settings, accounts, sign-ins and secrets already in `node.db` are not copied over, so set the node up again as a new one.

The variable is not `DATABASE_URL`. That name belongs to the PostgreSQL secret accounts that projects attach, which are exported into agents' shells.

## What stays in SQLite

Only `node.db` moves. `supervisor.db` (the task supervisor's own state) and `file-sync.db` (built-in file sync's index) stay SQLite files in the data directory.

## Safety

- While the node uses PostgreSQL, the file `node-database-is-postgres` sits in the data directory. A Joint Bob process that starts without `JOINT_BOB_DATABASE_URL` sees it and stops, rather than starting an empty `node.db` beside the real database. To go back to SQLite, remove the variable and delete that file. The node then uses the `node.db` file as it was left.
- `JOINT_BOB_DATABASE_URL` stays with the service. Agents running as a person's own OS account (multi-user mode) never receive it, just as they cannot read `node.db`. Agents running as the service user receive it, just as they can read `node.db`.

## Backups and deployment

`scripts/deploy-installed-nodes.sh` backs up `node.db` with `VACUUM INTO` before it installs a release. It does not back up a PostgreSQL database: it says so and goes on, so back the database up yourself (`pg_dump`). Before updating a machine, the script also counts the conversation turns that an earlier update interrupted. On a PostgreSQL machine it reads that count from PostgreSQL, using `JOINT_BOB_DATABASE_URL` from the machine's `~/.joint-bob/env` and the `pg` package of an installed release. If it cannot read the count, it treats the machine as busy and retries later instead of updating it.

## How it works

The stores were written for SQLite and call the database synchronously. With PostgreSQL, each process runs its connections in a worker thread, and the calling thread waits for each answer, as node:sqlite waits for its disk. Each statement is translated from SQLite on its way to PostgreSQL. The translation (`src/postgres/sql-translation.ts`) handles:

- `?` parameters, `INSERT OR IGNORE` / `OR REPLACE`, `UPDATE OR IGNORE`, `IS ?` and case-insensitive `LIKE`;
- names whose case matters, `rowid`, and SQLite column types;
- `PRAGMA table_info`, `user_version` and `schema_version`, and the original text of each table in `sqlite_master`;
- `json_extract`, `json_each`, `->>`, two-argument `max`/`min`, `strftime` and triggers;
- foreign keys: `ON DELETE CASCADE` and `SET NULL` run as triggers on the parent table, installed once that table exists, since SQLite lets a table refer to one created later.

SQLite's locking is kept. Writes take a database-wide lock for the rest of their transaction, and a second writer waits up to five seconds for it (`busy_timeout`) before failing with `database is locked`. A statement that fails inside a transaction fails alone. A `SAVEPOINT` outside a transaction opens one.

A process holds one connection for statements outside transactions, plus one for each transaction open at that moment. The service, the task supervisor, and each agent shell command are separate processes, so allow for a few dozen connections per node. PostgreSQL's default `max_connections` of 100 is enough for one node.

Statements the translation cannot express fail with PostgreSQL's error, which follows the SQLite message the code expects, for example `UNIQUE constraint failed: browser_sessions.profileId (PostgreSQL 23505: …)`.

## Tests

`test/postgres-sql-translation.test.ts` checks the translation and always runs. `test/postgres-node-database.test.ts` runs against a real server when `JOINT_BOB_TEST_POSTGRES_URL` names a disposable database. With `JOINT_BOB_DATABASE_URL` set, the whole suite runs on PostgreSQL. Each test data directory gets a schema of its own, `jb_test_<hash>`, so use a database you can throw away.
