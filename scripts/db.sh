#!/bin/sh
# Local development database. Runs a private Postgres cluster of its own, so
# nothing touches the machine's own databases.
#
# Its data lives in ~/.local/share/graphinity, outside the project: when the
# project folder is synced (iCloud Desktop & Documents), the sync service
# empties and locks files, and Postgres panicked mid-write ("could not write
# to log file: Operation canceled"). A database needs a folder no one else
# manages. Override with GRAPHINITY_DATA.
#
#   npm run db:start   create (first time) and start the cluster, apply schema
#   npm run db:apply   apply db/schema.sql again
#   npm run db:stop    stop the cluster
#
# Writes .local/api.env with the API's connection string. The API connects as
# a least-privilege login role, the same way it does in production.
set -eu
# Postgres on macOS refuses to start without a valid locale in the environment
# ("postmaster became multithreaded during startup").
export LC_ALL=C

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCAL="$ROOT/.local"
# No spaces: the socket folder appears in connection URLs.
DATA=${GRAPHINITY_DATA:-$HOME/.local/share/graphinity}
PGDATA="$DATA/pg"
PORT=54329
OWNER=graphinity_owner
DB=graphinity

PGBIN=${PGBIN:-}
if [ -z "$PGBIN" ]; then
  for d in /opt/homebrew/opt/postgresql@18/bin /opt/homebrew/opt/postgresql@17/bin /usr/local/opt/postgresql@17/bin; do
    if [ -x "$d/pg_ctl" ]; then PGBIN=$d; break; fi
  done
fi
[ -n "$PGBIN" ] || { echo "Postgres not found. Install it with: brew install postgresql@17" >&2; exit 1; }

psql_owner() { "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$DATA" -p "$PORT" -U "$OWNER" "$@"; }

init() {
  mkdir -p "$LOCAL" "$DATA"
  chmod 700 "$LOCAL" "$DATA"
  # Local socket connections are trusted (only this user can reach $DATA);
  # TCP connections need a password, like production.
  "$PGBIN/initdb" -D "$PGDATA" -U "$OWNER" --auth-local=trust --auth-host=scram-sha-256 -E UTF8 --locale=C >/dev/null
  echo "Created local cluster in $PGDATA"
}

start() {
  [ -d "$PGDATA" ] || init
  if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$DATA/pg.log" -w \
      -o "-p $PORT -k '$DATA' -c listen_addresses=127.0.0.1" start >/dev/null
    echo "Postgres running on 127.0.0.1:$PORT"
  fi
  if ! psql_owner -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1; then
    psql_owner -d postgres -c "CREATE DATABASE $DB"
  fi
  apply
  ensure_login_role
}

apply() {
  # pgvector isn't a "trusted" extension: an administrator turns it on, as
  # Supabase's dashboard does there. Build it once: docs/RUNBOOK.md.
  psql_owner -d "$DB" -c "CREATE SCHEMA IF NOT EXISTS extensions" -c "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions" >/dev/null
  psql_owner -d "$DB" -f "$ROOT/db/schema.sql"
  echo "Applied db/schema.sql (version $(psql_owner -d "$DB" -tAc 'SELECT version FROM app.schema_meta'))"
}

ensure_login_role() {
  # A new cluster for an existing .local/api.env (the data moved, or was
  # reset): give the API its login back, with the password it already has.
  if [ -f "$LOCAL/api.env" ] && ! psql_owner -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'graphinity_api'" | grep -q 1; then
    PASS=$(sed -n 's#^DATABASE_URL=postgres://graphinity_api:\([^@]*\)@.*#\1#p' "$LOCAL/api.env")
    [ -n "$PASS" ] || { echo ".local/api.env has no DATABASE_URL for graphinity_api; delete it and run db:start again" >&2; exit 1; }
    psql_owner -d postgres >/dev/null <<SQL
CREATE ROLE graphinity_api LOGIN PASSWORD '$PASS' IN ROLE app_api;
SQL
    psql_owner -d "$DB" -c "GRANT CONNECT ON DATABASE $DB TO graphinity_api" >/dev/null
    echo "Restored the API's database login"
  fi
  if [ ! -f "$LOCAL/api.env" ]; then
    PASS=$(openssl rand -hex 24)
    psql_owner -d postgres -c "DROP ROLE IF EXISTS graphinity_api" >/dev/null
    # Sent on standard input, not as an argument: arguments are visible to
    # every process on the machine (ps) while psql runs.
    psql_owner -d postgres >/dev/null <<SQL
CREATE ROLE graphinity_api LOGIN PASSWORD '$PASS' IN ROLE app_api;
SQL
    psql_owner -d "$DB" -c "GRANT CONNECT ON DATABASE $DB TO graphinity_api" >/dev/null
    umask 077
    {
      echo "DATABASE_URL=postgres://graphinity_api:$PASS@127.0.0.1:$PORT/$DB"
      echo "IP_HASH_KEY=$(openssl rand -hex 32)"
    } > "$LOCAL/api.env"
    echo "Wrote .local/api.env"
  fi
  # Local stand-in for Supabase Auth (npm run dev:auth). Added separately so
  # older .local/api.env files gain it too.
  if ! grep -q '^SUPABASE_SECRET_KEY=' "$LOCAL/api.env"; then
    umask 077
    {
      echo "SUPABASE_URL=http://localhost:54321"
      echo "SUPABASE_SECRET_KEY=dev_secret_$(openssl rand -hex 24)"
    } >> "$LOCAL/api.env"
  fi
  # Integration tests create and drop their own throwaway databases as the owner.
  echo "TEST_DATABASE_ADMIN_URL=postgres:///postgres?host=$DATA&port=$PORT&user=$OWNER" > "$LOCAL/test.env"
}

stop() {
  "$PGBIN/pg_ctl" -D "$PGDATA" -w stop >/dev/null && echo "Postgres stopped"
}

case "${1:-}" in
  start) start ;;
  apply) apply ;;
  stop) stop ;;
  *) echo "usage: db.sh start|apply|stop" >&2; exit 2 ;;
esac
