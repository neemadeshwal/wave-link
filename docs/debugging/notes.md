# Debugging Notes: Docker Postgres Port Collision

## Symptom
`npx prisma db pull` (or any Prisma command) fails with:
```
Error: P1010
User was denied access on the database `(not available)`
```
Even though:
- `docker compose ps` shows Postgres container `Up`
- `.env` `DATABASE_URL` credentials are correct
- Directly `docker exec`-ing into the container and running `psql` works fine

## Root Cause
**A process already running natively on your host machine (not in Docker) was bound to port 5432** — the default Postgres port. This could be a Homebrew-installed Postgres, a leftover Postgres.app, or anything else that starts its own local server.

When Docker tries to forward `host:5432 -> container:5432`, if the host port is already taken by another process, connections to `localhost:5432` from your app go to **whichever process actually owns that port on the host** — which in this case was the *native* Postgres, not the Docker one. That native Postgres has no idea about your `wavelink` user/database, so it correctly rejects the connection — but the error message makes it look like a credentials problem, when it's actually a "wrong server" problem.

## How to Diagnose This
```bash
lsof -i :5432
```
Look at the `COMMAND` and `USER` columns. If you see a `postgres` process owned by your own Mac user account (not something clearly Docker-related), that's a native process squatting on the port.

Cross-check: try connecting via `docker exec` directly into the container (bypasses the host port entirely):
```bash
docker exec -it <container_name> psql -U <user> -d <db>
```
If this works but connecting from your host machine (via Prisma, `psql -h localhost`, etc.) doesn't — that's the smoking gun for a port collision, not a credentials issue.

## The Fix
Two options:

**Option A — Stop the native Postgres** (if you don't need it):
```bash
brew services stop postgresql
# or, if not a brew service and it won't die:
sudo kill <PID>
```
⚠️ Some native installs respawn automatically via `launchd` even after `kill` — if it comes back, don't keep fighting it, use Option B instead.

**Option B — Remap Docker's port instead** (safer, avoids touching anything else that depends on the native instance):

In `docker-compose.yaml`:
```yaml
ports:
  - '5433:5432'   # host:container — host port changed, container port unchanged
```

Then:
```bash
docker compose down
docker compose up -d
```

Update `.env`:
```
DATABASE_URL="postgresql://<user>:<password>@localhost:5433/<db>?schema=public"
```

## Key Takeaway
**Before assuming a connection error is about credentials, check `lsof -i :<port>` to confirm which process actually owns that port on your host.** Docker containers running services that use "standard" ports (5432 Postgres, 6379 Redis, 5672 RabbitMQ, etc.) are common collision points if you've ever installed those services natively for any other project or tool (e.g. a GUI client like TablePlus). This will happen again on other projects/ports — the diagnostic pattern is always: does `docker exec` work but the host connection doesn't? → port collision, not an auth bug.

---

## Bonus: unrelated YAML bug hit in the same session
```
go-yaml load error in parser (while parsing a block mapping) at L1.C1-C15: did not find expected key
```
Cause: a stray character (`version: '3.9'.` — trailing period) made line 1 invalid YAML.
Fix: Compose V2 doesn't need the `version:` key at all anymore — just delete that line if you see the "obsolete" warning, rather than editing it.