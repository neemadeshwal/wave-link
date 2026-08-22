# Wavelink Phase 0 — Concepts & Decisions Notes

## 1. Docker — what it actually does in this project

Docker runs **services** — long-running programs that listen on a network port.
Postgres, Redis, RabbitMQ are all services. Docker lets you run all three
locally in isolated containers without installing them natively on your machine.

`docker-compose.yaml` defines all three services in one file.
`docker compose up -d` starts them all in the background.
`docker compose down` stops them.

**Colima** is the lightweight Docker runtime used on this Mac instead of Docker
Desktop. It must be started manually before any Docker commands work:
```bash
colima start
```
If Colima crashes or is in a broken state:
```bash
colima stop --force
colima start
# or if that fails:
colima delete
colima start
```

**Key distinction:**
- Docker runs *services* (Postgres, Redis, RabbitMQ)
- npm installs *libraries* (Prisma, bcrypt, NestJS packages)
- These are completely different categories — never confuse them

---

## 2. Prisma: `generate` vs `migrate`

| Command | Touches | Output |
|---|---|---|
| `prisma migrate dev` | Postgres database | SQL files in `prisma/migrations/` |
| `prisma generate` | Your filesystem | TypeScript client in `node_modules/@prisma/client` |

**`migrate`** = creates/alters tables in the database. Does NOT produce TypeScript code.

**`generate`** = produces the typed TypeScript client from your schema. Does NOT touch the database.

**Why `@prisma/client` was empty:**
The npm package ships as an empty shell. It has no real content until
`prisma generate` fills it by reading YOUR schema. This is why
`import { PrismaClient } from '@prisma/client'` fails on a fresh project
before generate has been run.

**Correct order every time schema.prisma changes:**
```bash
npx prisma migrate dev --name <description>
npx prisma generate  # usually runs automatically after migrate dev
```

**If you see:** `Module '"@prisma/client"' has no exported member 'PrismaClient'`
→ Run `npx prisma generate` before anything else.

---

## 3. DatabaseService — why a single shared instance

`DatabaseService` extends `PrismaClient` and is registered as a NestJS provider.
NestJS providers are **singletons by default** — one instance for the lifetime
of the application.

**Why singleton matters for database connections:**
When `PrismaClient` initializes, it opens a **connection pool** — a set of real
TCP connections to Postgres kept open and ready. Postgres has a hard connection
limit (default 100). Each `new PrismaClient()` opens its own pool (~10
connections by default). Multiple instances = multiple pools = connection limit
exhaustion at scale.

One shared `DatabaseService` = one pool = controlled, predictable connection usage.

**Why `OnModuleInit` and `OnModuleDestroy`:**

`OnModuleInit` → calls `$connect()` explicitly at startup.
- Purpose: **fail fast** — if Postgres is unreachable, the app crashes immediately
  on boot with a clear error rather than throwing cryptic errors on the first
  real user request
- Without it: Prisma connects lazily on first query (works, but harder to diagnose)

`OnModuleDestroy` → calls `$disconnect()` on shutdown.
- Purpose: gracefully closes all open connections in the pool
- Without it: connections stay open on Postgres's side until timeout, wasting
  resources and potentially blocking new connections

---

## 4. NestJS DI — how modules share providers

Three key arrays in `@Module()` decorator:

- `providers` — registers a class with the DI container; NestJS instantiates it
  once (singleton scope by default)
- `exports` — makes that instance available to any module that imports this module
- `imports` — brings in everything exported by another module, making it
  injectable in this module's services/controllers

**`@Global()` decorator:**
When a module is marked `@Global()`, its exports are available everywhere without
needing to explicitly import that module in every consumer module.
The global module still needs to be imported **once** in `AppModule`.

Use `@Global()` for truly cross-cutting concerns (DatabaseModule, ConfigModule).
Don't overuse it — it makes dependencies less visible.

**DatabaseModule is `@Global()` because:**
Every module in a chat app needs database access. Importing it explicitly
everywhere adds noise with no benefit.

**What a new module needs to inject `DatabaseService`:**
Nothing extra — just inject it in the constructor. `@Global()` handles the rest:
```typescript
constructor(private readonly dbService: DatabaseService) {}
```

---

## 5. Module separation — UsersModule vs AuthModule

**AuthModule** is responsible for: login, signup flow, JWT signing/verification,
guards, passport strategies.

**UsersModule** is responsible for: creating users, finding users, updating user
data — direct database operations on the User model.

**Why separate:**
- `AuthService` depends on `UsersService`, not on Prisma directly
- If you swap Prisma for TypeORM, you change `UsersModule` internals only —
  `AuthModule` never knows it happened
- `UsersService` can be reused by other modules (AdminModule, ProfileModule)
  without creating a dependency on AuthModule
- Single responsibility: each module has one clear job

**Dependency direction:**
```
AuthModule → UsersModule → DatabaseModule → Postgres
```
Never the reverse. `UsersModule` has zero knowledge of JWTs or auth.

---

## 6. Password hashing — bcrypt

```typescript
import * as bcrypt from 'bcrypt'; // CommonJS module — use * as syntax
const hash = await bcrypt.hash(plainTextPassword, 10);
```

**The `10` is the cost factor (salt rounds):**
It means bcrypt runs `2^10 = 1024` iterations internally.
The output hash length is always fixed — cost factor only affects CPU time.

**The tradeoff:**
- `10` rounds ≈ 100ms per hash — standard for web apps
- `14` rounds ≈ 1500ms per hash — users notice the lag
- Higher cost = slower for attackers brute-forcing passwords
- bcrypt is **deliberately slow** — unlike MD5/SHA256 which are fast (bad for passwords)

**Never store plain text passwords. Always:**
1. Hash on signup before saving to DB
2. Compare with `bcrypt.compare(plainText, storedHash)` on login
3. Never return `passwordHash` in API responses

---

## 7. NestJS HTTP Exceptions — use the right one

Always use NestJS built-in exceptions, never plain `new Error()`.
Plain `Error` is not caught by NestJS's exception filter → generic 500.

| Exception | HTTP Status | When to use |
|---|---|---|
| `BadRequestException` | 400 | Malformed input, missing fields |
| `UnauthorizedException` | 401 | Not logged in |
| `ForbiddenException` | 403 | Logged in but not allowed |
| `NotFoundException` | 404 | Resource doesn't exist |
| `ConflictException` | 409 | Duplicate resource (e.g. email already exists) |
| `InternalServerErrorException` | 500 | Unexpected server error |

**Duplicate email → `ConflictException` not `BadRequestException`:**
The request is valid, it just conflicts with existing DB state. 409 is semantically correct.

**Always rethrow known exceptions in catch blocks:**
```typescript
catch(e) {
  if (e instanceof ConflictException) throw e; // rethrow — don't swallow it
  throw new InternalServerErrorException('Unable to create user');
}
```
Without the rethrow, catch blocks swallow deliberately thrown exceptions and
replace them with generic 500s.

---

## 8. Schema design decisions

**One `Conversation` table with `type` enum (DIRECT | GROUP)** — not two separate tables.

Why: splitting into two tables means `Message.conversationId` needs two nullable
FKs (one per table), and "get all user conversations" requires a UNION query.
One table with nullable group-only fields (`name`, `groupAvatarUrl`) is cleaner.

**Composite PKs on join tables:**
```prisma
@@id([conversationId, userId])  // ConversationParticipant
@@id([messageId, userId])       // MessageRecipient
```
A participant is uniquely identified by the combination of conversation + user.
No separate `id` column needed.

**Always add timestamp defaults in schema:**
```prisma
createdAt DateTime @default(now())  // set automatically on insert
updatedAt DateTime @updatedAt       // set automatically on every update
deletedAt DateTime?                 // null until soft-deleted
```
Not adding `@default(now())` forces you to pass timestamps from application
code on every create — Prisma will throw a type error reminding you.

**Soft delete pattern:**
`deletedAt DateTime?` — null means active, populated means deleted.
Never hard-delete messages — always soft-delete so read receipts,
conversation history, and audit trails remain intact.

---

## 9. DTO best practices

- Always map DTO fields explicitly to DB fields — never spread a DTO directly
  into a Prisma create call
- Reason: DTO field names can differ from DB column names, and some fields need
  transformation before storage (e.g. `password` → `passwordHash`)
- Use class-validator decorators for input validation
- Strip sensitive fields before returning to client:
```typescript
const { passwordHash, ...userWithoutPassword } = user;
return userWithoutPassword;
```