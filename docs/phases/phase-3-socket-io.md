# Wavelink — Phase 3: conversation:join & WebSocket Testing

## 1. The conversation:join event — full implementation

### Event naming convention
Following the same pattern as `message:send`:
```
noun:verb — present tense, active request from client to server
```

- `conversation:join` — client requests to join a specific conversation's room
- NOT `conversation:joined` (past tense implies a broadcast/announcement, not a request)
- NOT `user:joined` or `client:joined` (wrong noun — you're joining a CONVERSATION, not announcing a user)

### The handler
```typescript
@SubscribeMessage('conversation:join')
async handleJoinConversation(
  @ConnectedSocket() client: Socket,
  @MessageBody() data: { conversationId: string },
) {
  try {
    const conversationId = data.conversationId;
    const userId = client.data.user.sub;

    if (!conversationId || !userId)
      throw new UnauthorizedException(
        'You are not authorized for this conversation.',
      );

    const isParticipant = await this.conversationService.isParticipant(
      conversationId,
      userId,
    );

    if (!isParticipant)
      throw new UnauthorizedException(
        'You are not part of this conversation.',
      );

    client.join(conversationId);

    return { success: true };
  } catch (e) {
    if (e instanceof UnauthorizedException)
      return { success: false, error: e.message };
    return { success: false, error: 'Internal server error' };
  }
}
```

### Key decorators
- `@SubscribeMessage('event-name')` — marks a method as handling a specific incoming WebSocket event (equivalent to `@Post()` in REST, but for WS events)
- `@ConnectedSocket()` — extracts the socket/client object itself
- `@MessageBody()` — extracts the payload data the client sent with the event

---

## 2. Critical bugs caught and fixed in this session

### Bug 1: Inverted validation logic
```typescript
// WRONG — this throws when conversationId OR userId EXISTS (opposite of intent)
if (conversationId || userId) throw new UnauthorizedException(...)

// RIGHT — throws when EITHER is MISSING
if (!conversationId || !userId) throw new UnauthorizedException(...)
```
**Lesson:** Always read validation conditions literally, out loud if needed. "If conversationId OR userId" reads as "if either exists" — the opposite of what you want when checking for missing values.

### Bug 2: Forgot await on async method
```typescript
// WRONG — isParticipant returns a Promise, this assigns the Promise itself, not the boolean
const isParticipant = this.conversationService.isParticipant(conversationId, userId);

// RIGHT
const isParticipant = await this.conversationService.isParticipant(conversationId, userId);
```
**Lesson:** Any method that touches the database is async. Missing `await` means you're checking if a Promise object is truthy (always true) instead of the actual boolean result — this bug would have silently let anyone join any conversation.

### Bug 3: Hardcoded room name
```typescript
// WRONG — every single conversation join lands in the same literal room
client.join('convo-1');

// RIGHT — dynamic, based on the actual conversation being joined
client.join(conversationId);
```
**Lesson:** Watch for leftover placeholder/test values that need to become dynamic variables before considering code "done."

### Bug 4: Throwing instead of returning in acknowledgment pattern
```typescript
// WRONG — throwing (even a plain object) doesn't reach the client's ack callback
catch (e) {
  throw { success: false, error: e, message: "An error occured" };
}

// RIGHT — return the object so Socket.IO delivers it via the client's callback
catch (e) {
  return { success: false, error: 'Internal server error' };
}
```
**Lesson:** In WebSocket handlers using the acknowledgment pattern, `throw` triggers NestJS's WS exception handling (emits a generic `exception` event) — it does NOT populate the client's acknowledgment callback. Only `return` does that. This is a fundamentally different error-handling model than HTTP controllers, where `throw` is exactly how you signal errors.

---

## 3. Why guard-based auth doesn't work for handleConnection (recap)

`@UseGuards()` only wraps method calls that go through NestJS's request pipeline (`@Get()`, `@Post()`, `@SubscribeMessage()`). Lifecycle hooks like `handleConnection` are called directly by the framework, bypassing guards entirely.

**Solution used:** Socket.IO middleware registered in `afterInit`, which runs during the handshake — before the connection is even established, let alone before any lifecycle hook fires.

```typescript
afterInit(server: Server) {
  server.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = this.jwtService.verify(token, { secret: ... });
      socket.data.user = payload;
      next();
    } catch (e) {
      next(new Error('Unauthorized'));
    }
  });
}
```

---

## 4. Postman's Socket.IO testing limitations (important — avoid wasting time)

### What went wrong
Postman's Socket.IO support has genuine gaps as of this session:

1. **No dedicated field for the `auth` object** during handshake — this is Socket.IO's recommended, secure way to pass tokens (`io(url, { auth: { token } })`). Open GitHub issue since 2023, unresolved.
   - **Workaround used:** pass token as a query param instead (`?token=xyz`), and update server code to check both:
     ```typescript
     const token = socket.handshake.auth.token || socket.handshake.query.token;
     ```
   - **Important:** query params are a TESTING WORKAROUND ONLY. Real frontend code should always use the `auth` object — query params can leak into logs/browser history.

2. **"Events" tab with "Listen" toggle is for INCOMING server broadcasts, not outgoing client events.** Turning on "Listen" for `conversation:join` tells Postman "notify me if the server emits this to me" — completely different from "let me send this event to the server."

3. **The "Message" tab sends raw messages, not named Socket.IO events with payloads + acknowledgment callbacks.** Typing `{ "conversationId": "..." }` into the Message tab does NOT trigger a `@SubscribeMessage('conversation:join')` handler — it's not structured as a proper Socket.IO event emission.

### The fix: bypass Postman entirely for event testing
Built a minimal Node.js script using `socket.io-client` directly:

```javascript
const { io } = require('socket.io-client');

const socket = io('http://localhost:3000/chat', {
  auth: { token: 'YOUR_TOKEN' },
});

socket.on('connect', () => {
  console.log('✅ Connected:', socket.id);
  
  socket.emit('conversation:join', { conversationId: 'YOUR_ID' }, (response) => {
    console.log('📩 Server responded:', response);
  });
});

socket.on('connect_error', (err) => {
  console.log('❌ Connection error:', err.message);
});
```

**Why this is better than fighting Postman:**
- Direct control over event names, payloads, and acknowledgment callbacks
- No UI ambiguity — you're writing the exact client code your real frontend will eventually use
- Faster iteration than clicking through Postman's UI each time

**Setup:**
```bash
mkdir ws-test-client
cd ws-test-client
npm init -y
npm install socket.io-client
node test.js
```

Gitignored from the main repo since it's a dev tool, not part of the app:
```
ws-test-client/node_modules
```

---

## 5. Testing results confirmed

**Positive case (real conversation, real participant):**
```
✅ Connected: hVYv5xS6UuPrmnMEAAAB
📩 Server responded: { success: true }
```

**Negative case (fake/non-participant conversationId):**
```
✅ Connected: UzTB2FFw-bmGDNzbAAAD
📩 Server responded: { success: false, error: 'You are not part of this conversation.' }
```

Both confirm: JWT middleware validates connection → `isParticipant` check correctly gates room access → acknowledgment pattern correctly communicates success/failure back to client.

---

## 6. Key takeaways for next session

1. **Read your own conditionals literally** — `if (a || b)` vs `if (!a || !b)` are opposite checks; a moment of careful reading catches this before it becomes a security hole
2. **Every DB-touching method needs `await`** — forgetting it doesn't always crash loudly; sometimes it silently breaks logic (truthy Promise object)
3. **In WebSocket acknowledgment patterns: `return`, don't `throw`** — fundamentally different from HTTP controllers
4. **Tooling has real limitations** — don't burn excessive time forcing a tool to do something it wasn't built for; a 10-minute pivot to a custom script saved much more time than continuing to fight Postman's UI
5. **Environment and fatigue affect reasoning quality** — recognizing "I'm drained, let's continue tomorrow" is itself a good engineering decision, not a failure

---

## 7. What's next (Phase 2 continued)

- `message:send` over WebSocket — move message creation from REST to realtime
  - Same validation/DB logic as `MessageService.create()` (reuse it, don't duplicate)
  - After DB write succeeds, broadcast `message:new` to the conversation room
- Presence tracking (online/offline via Redis)
- Typing indicators (ephemeral, no DB writes)
- Redis adapter for multi-server horizontal scaling testing