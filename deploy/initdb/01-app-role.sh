#!/bin/sh
# Runs once, when the Postgres volume is first initialised (docker-entrypoint-initdb.d).
# Creates the runtime role spoor_app (no superuser); it owns every table the app migrates.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE spoor_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$POSTGRES_APP_PASSWORD';
GRANT CONNECT, TEMPORARY ON DATABASE $POSTGRES_DB TO spoor_app;
GRANT USAGE, CREATE ON SCHEMA public TO spoor_app;
SQL
