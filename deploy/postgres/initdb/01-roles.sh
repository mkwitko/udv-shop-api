#!/usr/bin/env bash
# Roda uma vez, no initdb. Três credenciais com três propósitos:
#
#   udv_migrate  dono do schema, faz DDL. Só o `prisma migrate deploy` usa.
#   udv_app      só DML. É a credencial do processo que atende requisição, então é a que vaza
#                numa injeção de SQL — sem DDL, o pior caso deixa de ser DROP SCHEMA.
#   udv_backup   pg_read_all_data, usado pelo pg_dump.
set -euo pipefail

: "${POSTGRES_APP_PASSWORD:?defina POSTGRES_APP_PASSWORD}"
: "${POSTGRES_MIGRATE_PASSWORD:?defina POSTGRES_MIGRATE_PASSWORD}"
: "${POSTGRES_BACKUP_PASSWORD:?defina POSTGRES_BACKUP_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE udv_migrate LOGIN PASSWORD '${POSTGRES_MIGRATE_PASSWORD}';
CREATE ROLE udv_app     LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}';
CREATE ROLE udv_backup  LOGIN PASSWORD '${POSTGRES_BACKUP_PASSWORD}';

GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO udv_migrate, udv_app, udv_backup;

-- No Postgres 15+ o schema public não dá CREATE a todo mundo: o dono precisa ser explícito.
ALTER SCHEMA public OWNER TO udv_migrate;
GRANT USAGE ON SCHEMA public TO udv_app, udv_backup;

-- Tabela que o migrate criar daqui pra frente já nasce acessível ao app. Sem este bloco,
-- cada migration nova precisaria de um GRANT manual.
ALTER DEFAULT PRIVILEGES FOR ROLE udv_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO udv_app;
ALTER DEFAULT PRIVILEGES FOR ROLE udv_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO udv_app;

-- Cobre o que já existir no momento do init (num cluster novo, nada).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO udv_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO udv_app;

GRANT pg_read_all_data TO udv_backup;

-- Timeout no role, não no código: query travada deixa de segurar conexão para sempre.
ALTER ROLE udv_app SET statement_timeout = '30s';
ALTER ROLE udv_app SET idle_in_transaction_session_timeout = '60s';
-- Migration pode ser legitimamente longa; sem teto.
ALTER ROLE udv_migrate SET statement_timeout = '0';
SQL
