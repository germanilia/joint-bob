/**
 * What a PostgreSQL schema needs before SQLite statements can run in it: SQLite's catalog
 * (`sqlite_master`, kept by the connection as statements change the schema), its pragmas and the
 * SQLite functions the stores call. Every statement is idempotent; one connection runs them under
 * an advisory lock, so connections starting together do not race.
 */
export const SUPPORT_SQL = String.raw`
CREATE TABLE IF NOT EXISTS sqlite_master (
  type TEXT COLLATE "C" NOT NULL, name TEXT COLLATE "C" PRIMARY KEY, tbl_name TEXT COLLATE "C" NOT NULL,
  rootpage BIGINT NOT NULL DEFAULT 0, sql TEXT
);
CREATE TABLE IF NOT EXISTS sqlite_pragma (name TEXT COLLATE "C" PRIMARY KEY, value BIGINT NOT NULL);
INSERT INTO sqlite_pragma VALUES ('schema_version', 0) ON CONFLICT DO NOTHING;
-- PRAGMA data_version: every write transaction adds one, under the write lock (see connection.ts).
INSERT INTO sqlite_pragma VALUES ('data_version', 0) ON CONFLICT DO NOTHING;
CREATE OR REPLACE VIEW pragma_schema_version AS SELECT value AS schema_version FROM sqlite_pragma WHERE name = 'schema_version';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'nocase' AND collnamespace = current_schema()::regnamespace) THEN
    CREATE COLLATION nocase (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
  END IF;
END $$;

-- References whose ON DELETE action runs as a trigger on the parent, installed once the parent exists.
CREATE TABLE IF NOT EXISTS sqlite_foreign_keys (name TEXT COLLATE "C" PRIMARY KEY, parent TEXT NOT NULL, routine TEXT NOT NULL, trigger TEXT NOT NULL);
CREATE OR REPLACE FUNCTION sqlite_install_references() RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT k.name, k.routine, k.trigger FROM sqlite_foreign_keys k
    WHERE COALESCE(to_regclass(quote_ident(k.parent)), to_regclass(k.parent)) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = k.name AND t.tgrelid = COALESCE(to_regclass(quote_ident(k.parent)), to_regclass(k.parent)))
  LOOP
    EXECUTE r.routine;
    EXECUTE r.trigger;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION sqlite_json_path(path TEXT) RETURNS TEXT[] LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN path = '$' THEN ARRAY[]::TEXT[]
    ELSE string_to_array(regexp_replace(regexp_replace(substr(path, 2), '\[(\d+)\]', '.\1', 'g'), '^\.', ''), '.') END
$$;

-- JSON, not JSONB, keeps a nested value's text as stored, as SQLite's json_extract returns it.
CREATE OR REPLACE FUNCTION sqlite_json_value(v JSON) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE json_typeof(v) WHEN 'null' THEN NULL WHEN 'string' THEN v #>> '{}'
    WHEN 'boolean' THEN CASE WHEN v::TEXT = 'true' THEN '1' ELSE '0' END ELSE v::TEXT END
$$;

CREATE OR REPLACE FUNCTION json_extract(doc TEXT, path TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT sqlite_json_value(doc::JSON #> sqlite_json_path(path))
$$;

-- json_extract where the caller needs the value's own type: as JSON, which the connection decodes, or as a number.
CREATE OR REPLACE FUNCTION sqlite_json_typed(doc TEXT, path TEXT) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT doc::JSONB #> sqlite_json_path(path)
$$;
CREATE OR REPLACE FUNCTION sqlite_json_number(doc TEXT, path TEXT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE json_typeof(v) WHEN 'number' THEN (v #>> '{}')::NUMERIC WHEN 'boolean' THEN (v::TEXT = 'true')::INT::NUMERIC
    WHEN 'string' THEN CASE WHEN (v #>> '{}') ~ '^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?\s*$' THEN (v #>> '{}')::NUMERIC END END
  FROM (SELECT doc::JSON #> sqlite_json_path(path) AS v) s
$$;

-- A value taken out of PostgreSQL's own json_each is JSON, not text.
CREATE OR REPLACE FUNCTION json_extract(doc JSON, path TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT json_extract(doc::TEXT, path)
$$;

-- json_extract with several paths returns a JSON array of the values found, as SQLite does.
CREATE OR REPLACE FUNCTION json_extract(doc TEXT, first_path TEXT, second_path TEXT, VARIADIC more_paths TEXT[] DEFAULT '{}')
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT '[' || string_agg(COALESCE((doc::JSON #> sqlite_json_path(p))::TEXT, 'null'), ',' ORDER BY n) || ']'
  FROM unnest(ARRAY[first_path, second_path] || more_paths) WITH ORDINALITY t(p, n)
$$;

CREATE OR REPLACE FUNCTION sqlite_json_arrow(doc TEXT, path TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT (doc::JSON #> sqlite_json_path(CASE WHEN path LIKE '$%' THEN path ELSE '$.' || path END))::TEXT
$$;
CREATE OR REPLACE FUNCTION sqlite_json_arrow_value(doc TEXT, path TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT sqlite_json_value(doc::JSON #> sqlite_json_path(CASE WHEN path LIKE '$%' THEN path ELSE '$.' || path END))
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_operator WHERE oprname = '->>' AND oprleft = 'text'::regtype AND oprright = 'text'::regtype AND oprnamespace = current_schema()::regnamespace) THEN
    CREATE OPERATOR ->> (LEFTARG = TEXT, RIGHTARG = TEXT, FUNCTION = sqlite_json_arrow_value);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_operator WHERE oprname = '->' AND oprleft = 'text'::regtype AND oprright = 'text'::regtype AND oprnamespace = current_schema()::regnamespace) THEN
    CREATE OPERATOR -> (LEFTARG = TEXT, RIGHTARG = TEXT, FUNCTION = sqlite_json_arrow);
  END IF;
END $$;

-- Boolean, so it works as a condition as SQLite's integer does; selected, it reads back as 1 or 0.
CREATE OR REPLACE FUNCTION json_valid(doc TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF doc IS NULL THEN RETURN NULL; END IF;
  PERFORM doc::JSONB;
  RETURN TRUE;
EXCEPTION WHEN others THEN RETURN FALSE;
END $$;

CREATE OR REPLACE FUNCTION sqlite_json_type(v JSON) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE json_typeof(v) WHEN 'string' THEN 'text' WHEN 'boolean' THEN v::TEXT
    WHEN 'number' THEN CASE WHEN v::TEXT ~ '^-?\d+$' THEN 'integer' ELSE 'real' END ELSE json_typeof(v) END
$$;

CREATE OR REPLACE FUNCTION json_each(doc TEXT, root TEXT DEFAULT '$')
RETURNS TABLE(key TEXT, value TEXT, type TEXT, atom TEXT, fullkey TEXT, path TEXT) LANGUAGE sql IMMUTABLE AS $$
  WITH target AS (SELECT doc::JSON #> sqlite_json_path(root) AS v)
  SELECT (e.ordinality - 1)::TEXT, sqlite_json_value(e.value), sqlite_json_type(e.value),
    CASE WHEN json_typeof(e.value) IN ('object', 'array') THEN NULL ELSE sqlite_json_value(e.value) END,
    root || '[' || (e.ordinality - 1) || ']', root
  FROM target, json_array_elements(target.v) WITH ORDINALITY e(value, ordinality) WHERE json_typeof(target.v) = 'array'
  UNION ALL
  SELECT e.key, sqlite_json_value(e.value), sqlite_json_type(e.value),
    CASE WHEN json_typeof(e.value) IN ('object', 'array') THEN NULL ELSE sqlite_json_value(e.value) END,
    root || '.' || e.key, root
  FROM target, json_each(target.v) e WHERE json_typeof(target.v) = 'object'
  UNION ALL
  SELECT NULL, sqlite_json_value(target.v), sqlite_json_type(target.v), sqlite_json_value(target.v), root, root
  FROM target WHERE json_typeof(target.v) NOT IN ('array', 'object')
$$;


CREATE OR REPLACE FUNCTION sqlite_max(a ANYCOMPATIBLE, b ANYCOMPATIBLE) RETURNS ANYCOMPATIBLE LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL WHEN a >= b THEN a ELSE b END
$$;
CREATE OR REPLACE FUNCTION sqlite_min(a ANYCOMPATIBLE, b ANYCOMPATIBLE) RETURNS ANYCOMPATIBLE LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL WHEN a <= b THEN a ELSE b END
$$;

-- SQLite sums truth values and numeric text as numbers.
CREATE OR REPLACE FUNCTION sqlite_sum_bool(state BIGINT, value BOOLEAN) RETURNS BIGINT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value IS NULL THEN state ELSE COALESCE(state, 0) + value::INT END
$$;
CREATE OR REPLACE FUNCTION sqlite_sum_text(state NUMERIC, value TEXT) RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value IS NULL THEN state
    WHEN value ~ '^\s*[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?\s*$' THEN COALESCE(state, 0) + value::NUMERIC
    ELSE COALESCE(state, 0) END
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sum' AND pronamespace = current_schema()::regnamespace AND proargtypes[0] = 'boolean'::regtype) THEN
    CREATE AGGREGATE sum(BOOLEAN) (SFUNC = sqlite_sum_bool, STYPE = BIGINT);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'sum' AND pronamespace = current_schema()::regnamespace AND proargtypes[0] = 'text'::regtype) THEN
    CREATE AGGREGATE sum(TEXT) (SFUNC = sqlite_sum_text, STYPE = NUMERIC);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION strftime(format TEXT, at TEXT) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE t TIMESTAMPTZ := CASE WHEN at = 'now' THEN clock_timestamp() ELSE at::TIMESTAMPTZ END;
BEGIN
  t := t AT TIME ZONE 'UTC';
  RETURN replace(replace(replace(replace(replace(replace(replace(replace(format,
    '%Y', to_char(t, 'YYYY')), '%m', to_char(t, 'MM')), '%d', to_char(t, 'DD')), '%H', to_char(t, 'HH24')),
    '%M', to_char(t, 'MI')), '%f', to_char(t, 'SS.MS')), '%S', to_char(t, 'SS')), '%s', floor(extract(epoch FROM t))::BIGINT::TEXT);
END $$;

CREATE OR REPLACE FUNCTION pragma_table_info(t TEXT)
RETURNS TABLE(cid BIGINT, name TEXT, type TEXT, notnull BIGINT, dflt_value TEXT, pk BIGINT) LANGUAGE sql STABLE AS $$
  SELECT (row_number() OVER (ORDER BY a.attnum) - 1)::BIGINT, a.attname::TEXT,
    CASE format_type(a.atttypid, NULL) WHEN 'bigint' THEN 'INTEGER' WHEN 'text' THEN 'TEXT' WHEN 'double precision' THEN 'REAL'
      WHEN 'bytea' THEN 'BLOB' ELSE upper(format_type(a.atttypid, NULL)) END,
    a.attnotnull::INT::BIGINT, pg_get_expr(d.adbin, d.adrelid),
    COALESCE((SELECT k.n FROM pg_constraint c, unnest(c.conkey) WITH ORDINALITY k(attnum, n)
      WHERE c.conrelid = a.attrelid AND c.contype = 'p' AND k.attnum = a.attnum), 0)::BIGINT
  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = COALESCE(to_regclass(quote_ident(t)), to_regclass(t)) AND a.attnum > 0 AND NOT a.attisdropped
    AND NOT (a.attname = 'rowid' AND a.attidentity <> '')
  ORDER BY a.attnum
$$;

CREATE OR REPLACE FUNCTION sqlite_table_shape(t TEXT, OUT columns TEXT[], OUT keys JSONB) LANGUAGE sql STABLE AS $$
  WITH rel AS (SELECT COALESCE(to_regclass(quote_ident(t)), to_regclass(t)) AS oid)
  SELECT
    (SELECT array_agg(a.attname::TEXT ORDER BY a.attnum) FROM rel, pg_attribute a
      WHERE a.attrelid = rel.oid AND a.attnum > 0 AND NOT a.attisdropped AND NOT (a.attname = 'rowid' AND a.attidentity <> '')),
    (SELECT COALESCE(jsonb_agg(cols ORDER BY primary_key DESC, name), '[]'::JSONB) FROM (
      SELECT i.indisprimary AS primary_key, c.relname AS name,
        (SELECT jsonb_agg(a.attname ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
      FROM rel, pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = rel.oid AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
        AND NOT EXISTS (SELECT 1 FROM unnest(i.indkey) k(attnum) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          WHERE a.attname = 'rowid' AND a.attidentity <> '')
    ) keys)
  FROM rel WHERE rel.oid IS NOT NULL
$$;
`;
