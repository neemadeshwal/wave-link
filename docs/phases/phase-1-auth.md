# Wavelink — Auth Module Concepts & Decisions

## 1. Auth flow — request lifecycle

```
POST /auth/login
  → Global middleware (CORS, Helmet)
  → ValidationPipe (whitelist, transform)
  → AuthController.login() — receives body, delegates to service
  → AuthService.login()
      → UsersService.findByEmail() — fetch user from DB
      → bcrypt.compare(plainText, hash) — verify password
      → JwtService.signAsync(payload) — create tokens
      → return { accessToken, refreshToken }
  → Controller returns response to client
```

**Controllers are thin** — no business logic, no DB calls.
Only job: receive request, call service, return response.

---

## 2. JWT — access token vs refresh token

**accessToken:**
- Short-lived (15 minutes)
- Sent in `Authorization: Bearer <token>` header on every request
- Stored in memory on the client (safest against XSS)
- Lost on page refresh — client hits `/auth/refresh` to get a new one

**refreshToken:**
- Long-lived (7 days)
- Only sent to `/auth/refresh` endpoint, not on every request
- Stored in HttpOnly, SameSite cookie

**JWT payload:**
```typescript
{ sub: user.id, email: user.email }
```
- `sub` (subject) = standard JWT claim identifying who the token belongs to
- Use `id` not `email` — email can change, id is immutable
- `id` is used to query the DB on protected routes

---

## 3. Refresh token flow

```
Normal request → send accessToken in Authorization header
accessToken valid → proceed
accessToken expired → client receives 401
Client hits POST /auth/refresh → sends refreshToken (from HttpOnly cookie)
Server:
  1. Validates refreshToken signature
  2. Checks expiry
  3. Optionally checks against DB (token rotation)
  If valid → issue new accessToken
Client retries original request with new accessToken
User never notices the token expired
```

**Key point:** refreshToken is NOT sent on every request.
Only sent to the specific `/auth/refresh` endpoint.

---

## 4. Token storage — security tradeoffs

| Storage | XSS Risk | CSRF Risk | Survives Refresh | Use for |
|---|---|---|---|---|
| localStorage | HIGH — any JS can read it | Low | Yes | Never use for tokens |
| Memory (JS var) | LOW — not accessible externally | Low | No | accessToken |
| HttpOnly Cookie | LOW — JS cannot read it | Medium | Yes | refreshToken |

**HttpOnly cookie** = browser never exposes it to JavaScript.
`document.cookie` won't show it. XSS can't steal it.

**CSRF mitigation** on cookies: set `SameSite: strict` or `SameSite: lax`.
This prevents other sites from tricking the browser into sending your cookie.

---

## 5. bcrypt — password hashing

```typescript
import * as bcrypt from 'bcrypt'; // CommonJS — always use * as syntax

// Hashing (signup)
const hash = await bcrypt.hash(plainTextPassword, 10);

// Comparing (login)
const isValid = await bcrypt.compare(plainTextPassword, storedHash);
// ↑ plain text first, hash second — order matters
```

**`bcrypt.verify` does not exist** — the method is `bcrypt.compare`.

**Cost factor (salt rounds):**
- `10` = `2^10 = 1024` iterations ≈ 100ms per hash
- Higher = slower for attackers, but also slower for users
- `10` is the industry standard for web apps
- bcrypt is deliberately slow — unlike MD5/SHA256 (fast = bad for passwords)

---

## 6. ValidationPipe — global vs controller level

```typescript
// main.ts — global, applies to every incoming request
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,            // strips unknown fields from payload
  forbidNonWhitelisted: true, // throws 400 if unknown fields sent
  transform: true,            // transforms raw JSON to DTO class instances
}))
```

**`whitelist: true`** — security against mass assignment attacks.
Without it, a client could send extra fields (e.g. `role: "ADMIN"`) that
slip through to the DB if not explicitly mapped. Whitelist strips anything
not declared in the DTO before it reaches the service.

**`forbidNonWhitelisted: true`** — throws 400 instead of silently stripping.
Useful in development to catch mistakes early.

**`transform: true`** — transforms the raw JSON body into an actual instance
of the DTO class so class-validator decorators can run against it.
Requires `class-transformer` package installed.

**Global vs controller/handler level:**
- Global (`main.ts`) — universal concerns: whitelist, transform, class validation
- Controller level (`@UsePipes()`) — controller-specific concerns
- Handler level — route-specific concerns
- JWT guards are controller/handler specific — not all routes need auth

---

## 7. Module wiring for auth

```
AppModule
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, UsersModule, AuthModule]

AuthModule
  imports: [UsersModule, JwtModule.registerAsync(...)]
  providers: [AuthService]
  controllers: [AuthController]

UsersModule
  providers: [UsersService]
  exports: [UsersService]  ← required so AuthModule can inject it
```

**`JwtModule.registerAsync()` vs `JwtModule.register()`:**
- `register()` — reads env vars eagerly at module definition time
  — if env not loaded yet, secret is `undefined` silently
- `registerAsync()` — waits for DI container, then calls `useFactory`
  — env is guaranteed to be loaded by then
- Always use `registerAsync()` for anything depending on env vars

---

## 8. Signup — return tokens vs return user object

**Return tokens immediately (our approach):**
- Better UX — user is instantly logged in after signup
- One less round trip
- Tradeoff: couples account creation with session creation
- If you add email verification later, this flow needs to change

**Return user object, separate login:**
- More flexible — can add email verification gate without breaking clients
- Worse UX — user has to enter credentials again immediately after signing up
- Better for apps that require email verification before access

For Wavelink: return tokens immediately. No email verification needed.

---

## 9. Swagger setup

```typescript
// Always set up Swagger BEFORE app.listen()
const config = new DocumentBuilder()
  .setTitle('Wavelink API')
  .setDescription('Chat application API')
  .setVersion('1.0.0')
  .addBearerAuth() // JWT auth button — not addBasicAuth()
  .build();

const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup('api/docs', app, document); // UI at /api/docs

await app.listen(process.env.PORT ?? 3000); // always last
```

**`addBearerAuth()`** — adds `Authorization: Bearer <token>` input for JWT.
**`addBasicAuth()`** — adds username/password input for Basic HTTP auth. Wrong for JWT.

If Swagger returns 404: check that `SwaggerModule.setup` is called before `app.listen()`.

---

## 10. class-transformer

Required peer dependency for `ValidationPipe` with `transform: true`.
`class-validator` defines validation rules (`@IsString()`, `@IsEmail()` etc.)
`class-transformer` transforms raw JSON into DTO class instances so those rules can run.

```bash
npm install class-transformer
```

If you see: `The "class-transformer" package is missing` — install it.