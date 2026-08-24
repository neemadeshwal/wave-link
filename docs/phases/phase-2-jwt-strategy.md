# Wavelink — JWT Strategy, Guards & Decorators

## 1. The three layers of route protection

When a user hits a protected route, three things work together in sequence:

```
Request with Authorization header
  → JwtAuthGuard (checks if request is allowed to proceed)
  → JwtStrategy (validates the token)
  → @CurrentUser() decorator (extracts user from validated token)
  → Controller handler receives user
```

Each layer has a specific job.

---

## 2. JwtStrategy — token validation

```typescript
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const secret = config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) throw new Error('JWT_ACCESS_SECRET not defined');

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: { sub: string; email: string }) {
    return { sub: payload.sub, email: payload.email };
  }
}
```

**What it does:**
- `jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken()` → tells Passport to look for the token in the `Authorization: Bearer <token>` header
- `ignoreExpiration: false` → rejects expired tokens (throws 401)
- `secretOrKey` → the secret used to verify the token signature
- `validate()` → runs after Passport successfully verifies the token; returns whatever you want attached to `req.user`

**Important:** The strategy name `'jwt'` is automatically registered by `PassportStrategy(Strategy)`.
You reference it later as `AuthGuard('jwt')`.

**Registration:** Must be listed in `AuthModule`'s `providers` array so NestJS instantiates it.

---

## 3. JwtAuthGuard — gatekeeper for routes

```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

**What it does:**
- Runs before your controller handler
- Uses the `'jwt'` strategy to validate the incoming request
- If validation passes: request continues to the controller
- If validation fails (expired token, bad signature, missing header): throws `401 UnauthorizedException`

**Usage in controllers:**
```typescript
@Get('me')
@UseGuards(JwtAuthGuard)
getMe(@CurrentUser() user) {
  return user;
}
```

**Execution order:**
```
HTTP Request
  → JwtAuthGuard.canActivate()
  → JwtStrategy.validate()
  → If valid: continue to controller
  → If invalid: throw 401
```

---

## 4. @CurrentUser() — extract user from request

```typescript
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user; // what JwtStrategy.validate() returned
  },
);
```

**What it does:**
- A parameter decorator that extracts `req.user` from the HTTP request
- `req.user` is populated by Passport after the strategy validates the token
- Returns whatever the strategy's `validate()` method returned

**Why it exists:**
Without it, you'd have to do:
```typescript
@Get('me')
@UseGuards(JwtAuthGuard)
getMe(@Req() req: Request) {
  const user = req.user; // manual extraction
  return user;
}
```

With the decorator:
```typescript
@Get('me')
@UseGuards(JwtAuthGuard)
getMe(@CurrentUser() user: { sub: string; email: string }) {
  return user; // clean, explicit, typed
}
```

---

## 5. The complete flow — request to protected endpoint

```
1. Client sends: GET /auth/me
   Header: Authorization: Bearer eyJhbGci...

2. JwtAuthGuard runs:
   - Calls AuthGuard('jwt')
   - AuthGuard finds the registered JwtStrategy

3. JwtStrategy runs:
   - ExtractJwt.fromAuthHeaderAsBearerToken() extracts the token from header
   - Verifies signature using JWT_ACCESS_SECRET
   - Checks expiry (ignoreExpiration: false means reject if expired)
   - Calls validate(payload) with the verified payload
   - Returns { sub: ..., email: ... }
   - Passport attaches this to req.user

4. If JwtStrategy passes:
   - Request continues to controller

5. @CurrentUser() decorator runs:
   - Extracts req.user
   - Passes it as a parameter to the handler

6. Controller handler executes:
   return { sub: "...", email: "..." }
```

If anything fails (expired, bad signature, missing header):
```
JwtAuthGuard catches the error
→ Throws UnauthorizedException
→ Client gets 401
```

---

## 6. Common gotchas

**Missing JwtStrategy in providers:**
If you forget to add `JwtStrategy` to `AuthModule`'s `providers`:
```
Error: Unknown authentication strategy "jwt"
```
Passport was told to use 'jwt' strategy but it was never registered.

**Trying to access `this` before `super()` in constructor:**
```typescript
// WRONG
constructor(private config: ConfigService) {
  const secret = this.config.get(...); // ← error: this not available yet
  super({...});
}

// RIGHT
constructor(config: ConfigService) {
  const secret = config.get(...); // ← use parameter, not this
  super({...});
}
```

**Token expired:**
Access tokens expire in 15 minutes — if you wait longer between login and testing, you'll get 401.
This is by design. Use a fresh token or implement the refresh endpoint.

**Pasting wrong token into Swagger:**
Swagger's Authorize dialog expects just the token string, no "Bearer" prefix.
Swagger adds "Bearer" automatically when sending the request.

---

## 7. Why three separate pieces (Strategy + Guard + Decorator)

**Strategy** = the logic for validating a token
**Guard** = when to apply that logic (on which routes)
**Decorator** = how to access the validated data

Separating them makes the system:
- Reusable: one strategy can be used by multiple guards
- Testable: test strategy validation independently
- Flexible: can use same strategy in different contexts (guards, pipes, etc.)

If they were all one class, you'd lose that flexibility.

---

## 8. Token structure reminder

When `AuthService.issueTokens()` calls `jwtService.signAsync({ sub: userId, email })`:

```typescript
// Inside the JWT:
{
  "sub": "7fe19114-b79a-4bac-bb47-759fd1e31ba6",
  "email": "neema@gmail.com",
  "iat": 1787558248,    // issued at
  "exp": 1787559148     // expires at (15m later)
}
```

- `sub` = standard claim, identifies the user
- `email` = custom claim
- `iat` and `exp` are added automatically by JwtService
- The whole thing is signed with JWT_ACCESS_SECRET

When verified, this payload is what gets passed to `JwtStrategy.validate()`.