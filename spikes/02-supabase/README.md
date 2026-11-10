# Spike 02: per-project local Supabase on a Docker network

Goal: show that a local Supabase stack can start with its own `project_id` and port range, and that sibling containers (agents) can reach it over Docker networking, including on a separate per-project network.

Run on 2026-11-09. Host: Windows 11, Docker Desktop 29 (6.6 GiB VM memory), Supabase CLI 3.1.0 via `npx supabase@latest`. A second, unrelated stack (`moneo`, default ports 5432x) was running the whole time and was not affected.

## Commands

```sh
cd spikes/02-supabase
npx -y supabase@latest init
# edit supabase/config.toml (see below)
npx -y supabase@latest start                # prints JSON with URLs/keys when not on a TTY
npx -y supabase@latest status -o env        # API_URL, DB_URL, ANON_KEY, SERVICE_ROLE_KEY, PUBLISHABLE_KEY, SECRET_KEY, ...

NET=supabase_network_colony-spike
# REST through Kong from a sibling container
docker run --rm --network $NET colony-agent:dev \
  curl -s -o /dev/null -w "%{http_code}" http://supabase_kong_colony-spike:8000/rest/v1/ -H "apikey: $ANON_KEY"
# Postgres TCP
docker run --rm --network $NET colony-agent:dev sh -c \
  "python3 -c 'import socket;socket.create_connection((\"supabase_db_colony-spike\",5432),3);print(\"db ok\")'"
# Real SQL (psql from the cached postgres image, since colony-agent has no psql)
docker run --rm --network $NET --entrypoint psql public.ecr.aws/supabase/postgres:17.11.0.018 \
  "postgresql://postgres:postgres@supabase_db_colony-spike:5432/postgres" -tAc "select version()"

# Attach the stack to a separate project network
docker network create colony-proj-spike
docker network connect --alias supabase-kong colony-proj-spike supabase_kong_colony-spike
docker network connect --alias supabase-db   colony-proj-spike supabase_db_colony-spike
docker run --rm --network colony-proj-spike colony-agent:dev \
  curl -s -o /dev/null -w "%{http_code}" http://supabase-kong:8000/rest/v1/ -H "apikey: $ANON_KEY"

# Minimal stack (DB + Auth + REST + Kong only)
npx -y supabase@latest start -x studio,realtime,storage-api,imgproxy,postgres-meta,mailpit,logflare,vector,edge-runtime,supavisor

npx -y supabase@latest stop --no-backup
docker network rm colony-proj-spike
```

## config.toml changes

| Key | Default | Spike |
|---|---|---|
| `project_id` | `02-supabase` (folder name) | `colony-spike` |
| `[api] port` | 54321 | 55321 |
| `[db] port` | 54322 | 55322 |
| `[db] shadow_port` | 54320 | 55320 |
| `[db.pooler] port` (pooler disabled by default) | 54329 | 55329 |
| `[studio] port` | 54323 | 55323 |
| `[local_smtp] port` | 54324 | 55324 |
| `[analytics] port` | 54327 | 55327 |
| `[edge_runtime] inspector_port` | 8083 | 55383 |
| `[edge_runtime] enabled` | true | **false** |
| `[analytics] enabled` | true | **false** (logflare + vector) |
| `[local_smtp] enabled` | true | **false** (mailpit/inbucket) |

Everything else is left at its default (realtime, storage, studio, auth stay on).

## Results

| Check | Result |
|---|---|
| `supabase start` with custom project_id + 553xx ports, alongside a default-port stack | PASS |
| Containers are named `supabase_<svc>_colony-spike`, network `supabase_network_colony-spike` | PASS |
| Sibling container -> `http://supabase_kong_colony-spike:8000/rest/v1/` with anon key | PASS (200). Also 200 with the publishable and service-role keys |
| Sibling -> `/auth/v1/health` | PASS (GoTrue v2.197.0 JSON) |
| Sibling -> `supabase_db_colony-spike:5432` TCP | PASS (`db ok`) |
| Sibling psql `select version()` | PASS (PostgreSQL 17.11) |
| Separate network `colony-proj-spike`, before `network connect` | Unreachable, as expected (curl `000`) |
| After `docker network connect` kong + db, by container name and by alias (`supabase-kong`, `supabase-db`) | PASS (REST 200, auth 200, db TCP ok, psql ok) |
| Services not attached (e.g. `supabase_rest_*`) from the project network | Unreachable (`000`). Only what we attach is exposed |
| `supabase stop --no-backup` while kong/db were on the extra network | PASS: containers and volumes removed, our extra network left for us to delete |
| Minimal stack (`-x ...`) REST + auth from a sibling | PASS (200 / 200) |

Leftovers after cleanup: none (0 containers, no `colony-spike` network or volumes). The `moneo` stack kept running.

## Numbers

| Scenario | Time | RAM (`docker stats`) |
|---|---|---|
| Cold start (pulled realtime, studio, postgres, storage-api images; others cached) | 255 s | about 1020 MiB, 8 containers |
| Warm start, full stack (images cached, fresh volume) | 30 s | same |
| Warm start, minimal (`db, auth, rest, kong`) | 22 s | about 195 MiB (kong 95, db 85, auth 11, rest 7) |
| `stop --no-backup` | 5 to 8 s | |

Full-stack RAM by container: studio 284, realtime 226, storage 160, db 124, pg_meta 111, kong 93, rest 12, auth 11 (MiB).
Images on disk are large: postgres about 1.6 GB, studio 1.8 GB, storage-api 1.5 GB, realtime 560 MB.

## Gotchas

- `npx supabase@latest` pins image tags to that CLI release. Here it pulled newer postgres/studio/storage/realtime images than the ones already cached for the other project, so the "cold" start downloaded several GB. **Pin the CLI version** in the control plane, so every project uses the same cached images.
- Non-TTY `supabase start` prints a JSON blob (keys included) instead of the table. Use `supabase status -o env` (or `-o json`) to read the values, and do not log raw start output.
- `supabase init` defaults `project_id` to the folder name. Always set it explicitly; it becomes the container, network and volume suffix.
- `GET /rest/v1/` returned 200 even without an `apikey` header with this CLI and image set, so a 200 from the root does not prove the key works. Test a real table or `/auth/v1/health` for a stronger signal.
- The anon, service-role and JWT secret are the well-known local dev defaults, the same for every project. That is fine for isolated dev stacks, but agents in project A could use project B's keys if they could reach B's network. Isolation therefore comes from the network, not from the keys.
- Docker Desktop has 6.6 GiB here. Two full stacks are about 2 GiB before any agents run, so the default for agents should be the minimal set.
- The CLI runs on the host and works from a directory holding `supabase/config.toml`. Running it from Git Bash on Windows was fine. Paths under OneDrive did not cause problems for start/stop (no bind mounts are needed when there are no functions or seed files).

## Recommendation for the control plane (Phase 4)

1. **Per-project workdir**: `~/.colony/projects/<slug>/supabase/config.toml`, generated from a template and committed to the project repo if the project wants migrations tracked. `project_id = "colony-<slug>"`.
2. **Port allocation**: give each project a block of 10 ports, `base = 55300 + 10*n` with n = a stable project index (stored in the DB, reused after delete). Offsets: +0 shadow, +1 api, +2 db, +3 studio, +4 smtp, +7 analytics, +8 edge inspector, +9 pooler (mirrors the default 5432x layout). Before starting, check every port is free on the host and pick the next slot if not. Host ports are only for the human (Studio, local psql). Agents use Docker DNS and do not need them.
3. **Start**: `supabase start -x studio,realtime,storage-api,imgproxy,postgres-meta,mailpit,logflare,vector,edge-runtime,supavisor` by default (about 200 MiB, about 22 s warm). Add a "full" toggle that also turns on Studio and pg_meta for the Infra panel / Studio link. Use a pinned CLI version, pre-pull its images once, and run with `--workdir`.
4. **Attach**: after start, `docker network connect --alias supabase-kong colony-proj-<slug> supabase_kong_colony-<slug>` and the same with `--alias supabase-db` for db. Agents then always use the same in-network URLs: `SUPABASE_URL=http://supabase-kong:8000`, `DATABASE_URL=postgresql://postgres:postgres@supabase-db:5432/postgres`, plus `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` read from `supabase status -o json`. Never join agents to `supabase_network_*` itself; that network holds every internal service.
5. **Stop**: `supabase stop --workdir ... --project-id colony-<slug>` on idle (keeps data in volumes). Use `--no-backup` only for "wipe/reset". Re-attach networks after every start, because stop removes the containers. Stop does not remove `colony-proj-*`; that network belongs to the project lifecycle.
6. **Health**: poll `http://supabase-kong:8000/auth/v1/health` from inside the project network (or the host port), and check that `supabase_db_*` is healthy, before marking the stack ready.
