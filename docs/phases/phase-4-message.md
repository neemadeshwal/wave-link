# Wavelink — Phase 4: message:send & Realtime Testing

## 1. The message:send handler — final implementation

```typescript
@SubscribeMessage('message:send')
async handleMessageSentEvent(
  @ConnectedSocket() client: Socket,
  @MessageBody()
  data: { conversationId: string; content: string; type: MessageType },
) {
  try {
    const conversationId = data.conversationId;
    const senderId = client.data.user.sub;

    const createMessageObj = {
      conversationId,
      type: data.type,
      content: data.content,
    };

    const message = await this.messageService.create(createMessageObj, senderId);

    this.server.to(conversationId).emit('message:new', message);

    return { success: true, message };
  } catch (e) {
    return {
      success: false,
      error: (e instanceof NotFoundException || e instanceof BadRequestException)
        ? e.message
        : 'Internal server error',
    };
  }
}
```

**Design decision confirmed:** No duplicated business logic. `ChatGateway` is purely the realtime transport layer — it delegates all validation, DB writes, and receipt creation to `MessageService.create()` (built in Phase 1). Same service powers both the REST endpoint and the WebSocket event.

---

## 2. Why senderId doesn't need re-validation, but conversationId does

**`senderId` comes from `client.data.user.sub`** — set during the WebSocket handshake middleware, which already verified the JWT. This value cannot be missing or forged at this point in the flow — trust it completely.

**`conversationId` comes from raw client input** — could be empty, malformed, or pointing to a conversation the user isn't part of. But tracing through `isParticipant`:

```typescript
async isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const participant = await this.dbService.conversationParticipant.findFirst({
    where: { conversationId, userId },
  });
  return !!participant;
}
```

Even with `conversationId: ''`, `findFirst` runs a valid Prisma query that simply matches no rows — returns `null` → `!!null` → `false`. No crash, no special handling needed. The existing `isParticipant` check inside `MessageService.create()` already handles this gracefully by rejecting with `UnauthorizedException`. No need for manual pre-checks in the gateway handler — the service layer's existing validation is sufficient.

**Lesson:** Before adding defensive checks "just in case," trace through what the downstream code actually does with bad input. Sometimes it's already handled gracefully, and extra checks are pure redundancy.

---

## 3. Consistent error/success shape across WebSocket events

**Established convention for all WS acknowledgments in this project:**
```typescript
// Success
{ success: true, message: <data> }

// Failure
{ success: false, error: <string> }
```

Used identically in both `conversation:join` and `message:send`. This matters because whatever frontend consumes these events needs ONE predictable shape to check (`if (response.success)`) rather than handling different error formats per event type. Consistency here isn't cosmetic — it directly reduces frontend complexity and bugs.

---

## 4. WebSocket validation gap — confirmed, documented, deferred

**The gap:** `@MessageBody()` does NOT auto-validate like HTTP's `@Body()` does.

**Why:** `app.useGlobalPipes(new ValidationPipe(...))` in `main.ts` only applies to the **HTTP request pipeline**. WebSockets are a completely separate transport layer in NestJS — global HTTP pipes do not extend to `@MessageBody()` automatically.

**The fix (deferred as TODO):**
```typescript
// Option A: per-parameter
@MessageBody(new ValidationPipe()) data: CreateMessageDto

// Option B: per-gateway-class
@UsePipes(ValidationPipe)
@WebSocketGateway({...})
export class ChatGateway { ... }
```

**Additional complexity:** unlike HTTP, a failed WS `ValidationPipe` doesn't automatically populate the acknowledgment callback — it emits a generic `exception` event by default. Would need a custom `WsExceptionFilter` to convert validation failures into the `{success: false, error: ...}` shape used everywhere else in this project.

**Current mitigation:** relying on `MessageService.create()`'s existing validation (participant check, Prisma constraints) as a partial safety net. Raw empty/malformed `content` currently is NOT explicitly rejected at the WS layer — this is a known, accepted gap for now.

```typescript
// TODO: Phase 2 gap - @MessageBody() does not auto-validate like HTTP @Body() does,
// since app.useGlobalPipes() only applies to the HTTP pipeline, not WebSocket.
// Fix: apply ValidationPipe explicitly per-handler or via @UsePipes() at gateway level.
// Also need a WsExceptionFilter to convert validation failures into the
// {success:false, error:...} ack shape instead of the default generic 'exception' event.
```

---

## 5. Critical concept: emit() vs return() have different delivery timing

**The scenario that surfaced this:** In testing, the `message:new` broadcast arrived at the client BEFORE the `message:send` acknowledgment (return value), even though in the source code, the broadcast line executes before the return statement:

```typescript
this.server.to(conversationId).emit('message:new', message);  // Line A
return { success: true, message };                             // Line B
```

**What actually happens and why:**

`this.server.to(...).emit(...)` is a **direct, synchronous push** — the moment this line executes, Socket.IO immediately writes the event to the underlying transport (WebSocket frame) and sends it toward all sockets in that room. There's minimal internal overhead — it's about as close to "instant" as this system gets.

`return { success: true, message }` from a `@SubscribeMessage()` handler is NOT instant network delivery either — but it goes through **more internal plumbing**: NestJS has to capture the return value, package it according to Socket.IO's acknowledgment protocol, and match it to the specific callback function the client registered when it originally called `.emit('message:send', data, callback)`. This extra bookkeeping step adds a small amount of additional latency compared to a raw `.emit()` broadcast.

**The result:** code order (Line A before Line B) DOES roughly match delivery order in this case — but the deeper lesson is more important than the specific example: **`.emit()` broadcasts and acknowledgment `return` values are two functionally different delivery mechanisms**, each with their own path through the underlying protocol. Even when written in a specific sequence in your source code, you cannot assume rigid guarantees about which one a client will "see" first, especially once network latency, multiple hops (e.g., through Redis in a multi-server setup), or varying payload sizes are introduced.

**Why this matters for later phases:** This is a preview of a much bigger theme in distributed/event-driven systems — RabbitMQ (Phase 3) and BullMQ (Phase 4) will have many independent channels/queues delivering messages with NO strict global ordering guarantee unless you explicitly design for it (e.g., using message sequence numbers, timestamps, or explicit acknowledgment chains). Relying on "the order I wrote the code" as a proxy for "the order things will happen" is a common source of subtle bugs in async systems. Right now the practical impact is negligible (a few milliseconds), but the *pattern* — multiple independent delivery paths, no strict ordering — will resurface with higher stakes later.

**Practical takeaway for frontend design:** never assume the acknowledgment always arrives before or after the broadcast. Design the UI to handle either order gracefully (e.g., using the message's real `id` from either source to deduplicate/reconcile state, rather than assuming a strict sequence of events).

---

## 6. CORS and WebSocket — the "xhr poll error" debugging lesson

**Symptom:** `[connect_error] xhr poll error` when connecting from a standalone HTML file (`file://` origin) to `http://localhost:3000`.

**Root cause:** No `cors` configuration on `@WebSocketGateway()`. Socket.IO's client attempts multiple transport strategies — starting with a WebSocket upgrade attempt, but falling back to HTTP long-polling (`xhr poll`) if the upgrade is blocked. When CORS blocks the connection at the browser level, the error surfaces during this long-polling fallback attempt, hence the specific wording "xhr poll error" — even though the underlying issue is CORS, not anything related to polling itself.

**Fix:**
```typescript
@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: '*',  // '*' is fine for local dev/testing ONLY — restrict in production
  },
})
```

**Lesson for future debugging:** `xhr poll error` (or similar polling-related error messages) from a Socket.IO client is a strong signal to check CORS configuration first, even though the error text doesn't mention CORS explicitly. This is a recognizable pattern worth remembering rather than re-deriving each time.

---

## 7. Realtime test page — proving the system works end-to-end

Built a minimal standalone HTML file (no build step, Socket.IO client loaded via CDN) to visually demonstrate two-user realtime messaging:

**Structure:**
1. **Token input + Connect button** — establishes authenticated WebSocket connection (simulates "login" by pasting a different token per browser tab)
2. **ConversationId input + Join button** — emits `conversation:join`
3. **Message input + Send button** — emits `message:send`
4. **Persistent listener** for `message:new` — appends any broadcast message to the visible message log, regardless of which tab/user triggered it

**Key insight on simulating multiple users:** Since both browser tabs load the *identical* HTML/JS file, the only way to make them behave as different users is through **data the user manually provides** (pasting a different token per tab) — the code itself is never different between tabs. This is a foundational testing technique for any multi-client realtime system.

**Verified:** Message sent from Tab 1 (User A) appeared instantly in Tab 2 (User B) with no refresh, no polling — genuine proof that the full JWT-auth → room-join → message-create → broadcast pipeline works correctly end-to-end.

---

## 8. Phase 2 progress so far

**Completed:**
- JWT-authenticated WebSocket connections (Socket.IO middleware in `afterInit`)
- `conversation:join` — validated room joining with acknowledgment pattern
- `message:send` — realtime message creation, reusing Phase 1's `MessageService`, broadcasting via `message:new`
- Verified end-to-end with both a Node.js test script and a visual two-tab HTML demo

**Known gaps (documented as TODOs, not blockers):**
- No WS-level input validation (relies on service-layer checks as partial safety net)
- No WsExceptionFilter for converting validation failures into consistent ack shape

**Next up:**
- Typing indicators (ephemeral, no DB writes)
- Presence tracking (online/offline via Redis)
- Redis adapter for multi-server horizontal scaling