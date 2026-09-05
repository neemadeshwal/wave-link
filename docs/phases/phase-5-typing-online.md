# Wavelink — Phase 2: Presence Tracking (Online/Offline)

## 1. The core design decision: two separate concerns

Presence tracking splits into two genuinely different problems, easy to conflate:

**Problem A — "Is this user online at all, anywhere?"**
A global, app-wide fact. True the moment a user connects, false the moment they disconnect. Has NOTHING to do with which conversation/room they're in.
→ Solved with **Redis** (shared storage, visible across all server instances)

**Problem B — "Tell the right people, right now, that this user just came online/went offline."**
A room-scoped broadcast. Only matters to people currently viewing a shared conversation with that user.
→ Solved with **Socket.IO room broadcasts**, triggered at specific lifecycle moments

**Why this split matters:** conflating these two leads to broadcasting presence at the wrong time (e.g., trying to broadcast "online" in `handleConnection`, before any room is even known) or storing presence in the wrong place (e.g., trying to use Socket.IO's local room list as if it were global truth, which breaks across multiple servers).

---

## 2. Where each piece lives, precisely

| Operation | Location | Why |
|---|---|---|
| `redisService.addOnlineUser(userId)` | `handleConnection` | Being online is true the instant you connect — no dependency on rooms/conversations at all |
| `redisService.removeOnlineUser(userId)` | `handleDisconnect` | Mirror of the above |
| Broadcast `user:online` to a room | `handleJoinConversation` | Rooms aren't known until a user actually joins one — can't broadcast to a room you don't know about yet |
| Broadcast `user:offline` to rooms | `handleDisconnect` | Uses previously-tracked room membership (see bug #1 below) — NOT `client.rooms` |

---

## 3. RedisService — the Facade pattern

Never expose the raw `ioredis` client directly to the rest of the app. Wrap it:

```typescript
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    this.client = new Redis({
      host: this.config.get<string>('REDIS_HOST'),
      port: this.config.get<number>('REDIS_PORT'),
    });
    console.log('✅ Redis connected');
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  async addOnlineUser(userId: string) {
    await this.client.sadd('online_users', userId);
  }

  async removeOnlineUser(userId: string) {
    await this.client.srem('online_users', userId);
  }

  async getOnlineUser(): Promise<string[]> {
    return this.client.smembers('online_users');
  }

  async isUserOnline(userId: string): Promise<boolean> {
    const result = await this.client.sismember('online_users', userId);
    return result === 1;
  }
}
```

**Why wrap instead of `extends Redis`:**
- `DatabaseService extends PrismaClient` makes sense because the app genuinely uses a large portion of Prisma's API surface
- `RedisService` needs only 3-4 specific operations right now — extending `Redis` would expose HUNDREDS of raw commands (including dangerous ones like `flushall`, which wipes the entire Redis instance) with no protection
- This is the **Facade pattern**: a simplified, purpose-built interface hiding a more complex general-purpose subsystem
- Named methods (`addOnlineUser` vs raw `sadd`) are self-documenting and safer — nobody outside `RedisService` should ever import `ioredis` directly
- Extensible later: rate limiting, caching, etc. all get their own named methods added to this same service, without ever exposing the raw client

**Redis commands used:**
- `SADD key value` — add to a Set (no duplicates allowed)
- `SREM key value` — remove from a Set
- `SMEMBERS key` — get everyone currently in the Set
- `SISMEMBER key value` — check if one specific value exists (returns 1 or 0)

---

## 4. Middleware guarantees — why no race condition exists at handleConnection

**Question raised:** could `handleConnection` fire before the JWT middleware (`afterInit`'s `server.use(...)`) finishes setting `socket.data.user`?

**Answer: No — structurally impossible, not just unlikely.**

`next()` in a middleware pipeline (Socket.IO, Express, and similar systems) is the explicit signal "I'm done, proceed to the next step." The `connection` event (which triggers `handleConnection`) is guaranteed by Socket.IO's internal architecture to only fire AFTER all registered middleware have successfully called `next()`, in sequence. This is a deliberate, blocking, sequential design — different from genuinely concurrent operations (like `Promise.all()`) where race conditions are a real risk.

**General principle:** middleware pipelines are designed specifically to eliminate this class of ordering bug. If you're using a proper middleware chain (not manually firing off independent async operations), you can trust that each step fully completes before the next begins.

---

## 5. Bug #1 — client.rooms is EMPTY inside handleDisconnect

**The bug:** tried to broadcast `user:offline` to all rooms the disconnecting socket was in, using:
```typescript
const rooms = Array.from(client.rooms); // returned []
```

**Root cause:** Socket.IO automatically cleans up a socket's room memberships around disconnect time — by the time your `handleDisconnect` code runs, `client.rooms` has already been emptied out. This is a genuine, documented Socket.IO quirk, not a mistake in your code logic.

**Diagnosis method:** added a debug log (`console.log('Rooms at disconnect time:', Array.from(client.rooms))`) and confirmed it printed `[]` — verified the hypothesis directly instead of guessing.

**The fix:** capture room membership EARLIER (at join time), store it somewhere that survives until disconnect — specifically on `client.data`, since that's tied to the socket's own lifetime and isn't affected by Socket.IO's internal room cleanup:

```typescript
// In handleJoinConversation, right after client.join(conversationId):
if (!client.data.joinedRoom) {
  client.data.joinedRoom = new Set<string>();
}
client.data.joinedRoom.add(conversationId);
```

```typescript
// In handleDisconnect:
const rooms = client.data.joinedRoom || new Set<string>();
for (const room of rooms) {
  client.broadcast.to(room).emit('user:offline', { userId });
}
```

**Why `client.data` (not Redis) is correct here:** a socket connection only ever exists on ONE specific server instance for its entire lifetime — there's no scenario where a different server needs to read this socket's own room-membership history. Unlike `online_users` (a genuinely global, cross-server fact), "which rooms did THIS socket join" is scoped entirely to this one socket, on this one server. In-memory (`client.data`) is the correct, sufficient choice.

---

## 6. Bug #2 — Array allows duplicates, causing triple-broadcast

**The bug:** clicking "Join" multiple times on the same conversation caused `user:offline` to broadcast THREE times on disconnect, instead of once.

**Root cause:** `client.data.joinedRoom` was implemented as a plain Array, and `.push(conversationId)` was called on every join click — including repeat clicks on the SAME conversation. Arrays don't prevent duplicates, so the same `conversationId` ended up in the array multiple times: `[roomA, roomA, roomA]`. The disconnect loop then iterated over all three, broadcasting three identical events.

**The fix:** use a `Set` instead of an `Array` — same underlying concept as Redis's `SADD` (which we'd already learned prevents duplicates). A JavaScript `Set`'s entire purpose is enforcing uniqueness:
```typescript
client.data.joinedRoom = new Set<string>(); // not []
client.data.joinedRoom.add(conversationId); // .add() ignores duplicates automatically
```

**Lesson:** when the underlying requirement is "track a list of unique things," reach for a `Set`, not an `Array` — this eliminates an entire class of duplicate-handling bugs at the data-structure level, rather than needing separate duplicate-checking logic layered on top of an Array.

---

## 7. Bug #3 — .push() is not a method on Set

**The bug:** after correctly switching to `new Set<string>()`, the very next line still had:
```typescript
client.data.joinedRoom.push(conversationId); // TypeError!
```

**Root cause:** `.push()` is an Array-specific method. Sets use `.add()` instead. Calling `.push()` on a `Set` throws `TypeError: ... push is not a function` at runtime — which surfaced as a generic "Internal server error" in the acknowledgment response, since the catch block swallowed the real error message.

**The fix:** `client.data.joinedRoom.add(conversationId)`.

**Lesson:** switching a variable's underlying data structure (Array → Set) requires checking EVERY method call on that variable, not just the declaration line. `.push()`, `.length`, `.map()`, array indexing (`arr[0]`) — none of these work the same way (or at all) on a `Set`. A partial refactor (changing the type but not all the usages) produces exactly this kind of runtime error.

**Broader lesson on debugging:** when a catch block swallows the real error and returns a generic message, add a temporary `console.log(e)` inside the catch block during debugging — the actual error/stack trace usually reveals the exact problem immediately (as it did here — a clear `TypeError` about `.push` not being a function).

---

## 8. Full debugging sequence — recap of the reasoning chain

This was a genuinely good real-world debugging chain, worth reviewing as a pattern:

1. **Symptom:** `user:offline` broadcast never happens on disconnect
2. **Hypothesis:** maybe `client.rooms` doesn't contain what we expect at disconnect time
3. **Verify, don't guess:** added a debug log, confirmed `client.rooms` was empty
4. **Root cause understood:** Socket.IO clears rooms before `handleDisconnect` fires
5. **Fix implemented:** track rooms manually via `client.data`, populated at join time
6. **New symptom appears:** offline event fires 3 times instead of once
7. **Hypothesis:** maybe multiple joins created duplicate entries
8. **Verify:** confirmed via direct question — yes, Join was clicked 3 times
9. **Fix implemented:** switch Array to Set for automatic deduplication
10. **New symptom appears:** join itself now fails with generic error
11. **Check server logs for real error** (not just the generic client-facing message)
12. **Root cause found:** `.push()` called on a `Set`, which has no such method
13. **Fix implemented:** use `.add()` instead
14. **Final verification:** full flow retested end-to-end, confirmed working

**The pattern worth internalizing:** hypothesize → verify with actual evidence (logs, direct questions) → understand root cause → fix → retest → repeat if a new symptom appears. Never fix based on assumption alone when a quick log statement can confirm or deny the hypothesis directly.

---

## 9. Final working implementation

```typescript
async handleConnection(client: Socket) {
  console.log(`Client connected ${client.id}`);
  const userId = client.data.user.sub;
  await this.redisService.addOnlineUser(userId);
}

async handleDisconnect(client: Socket) {
  console.log(`Client disconnected: ${client.id}`);
  const userId = client.data.user.sub;
  await this.redisService.removeOnlineUser(userId);

  const rooms = client.data.joinedRoom || new Set<string>();
  for (const room of rooms) {
    client.broadcast.to(room).emit('user:offline', { userId });
  }
}

@SubscribeMessage('conversation:join')
async handleJoinConversation(client: Socket, data: { conversationId: string }) {
  try {
    const conversationId = data.conversationId;
    const userId = client.data.user.sub;

    if (!conversationId || !userId) throw new UnauthorizedException(...);

    const isParticipant = await this.conversationService.isParticipant(conversationId, userId);
    if (!isParticipant) throw new UnauthorizedException(...);

    client.join(conversationId);

    if (!client.data.joinedRoom) {
      client.data.joinedRoom = new Set<string>();
    }
    client.data.joinedRoom.add(conversationId);

    client.broadcast.to(conversationId).emit('user:online', { userId });

    return { success: true };
  } catch (e) {
    // ... error handling as before
  }
}
```

---

## 10. Explicitly deferred (scoped out today, not forgotten)

**"Last seen" persistence** — a feature where, even without live "offline" broadcasts, a user opening a DM can see "last seen at 3:42 PM" for the other person.

**Why deferred:** requires a DIFFERENT Redis operation than what's built today — Sets only answer "is X currently a member, yes/no," they don't store timestamps. Would need something like:
```
SET last_seen:{userId} {timestamp}
```
set specifically inside `handleDisconnect`, then read on-demand when a conversation is explicitly opened (likely via a REST endpoint, not WebSocket, since it's a one-time lookup rather than a live stream).

**Decision made deliberately, not accidentally** — recognized as separate scope mid-conversation and consciously deferred rather than scope-creeping the current presence feature.

---

## 11. Remaining Phase 2 scope

1. "Last seen" persistence (deferred above)
2. Redis adapter for multi-server horizontal scaling (proving presence/messages work across 2+ server instances, not just one)
3. Read receipts over WebSocket (delivered/read status, mirroring the `message:send` pattern already built)