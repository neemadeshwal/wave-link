# Wavelink Phase 1 — Conversations & Messages Over REST

## Overview
Phase 1 builds core chat functionality: authenticated users create conversations and send messages, all over REST with proper error handling, transactions, and validation. No realtime yet — that's Phase 2.

---

## 1. Architecture — request flow

```
User (authenticated via JWT)
  → POST /conversations or POST /messages
  → JwtAuthGuard validates token, attaches user to req.user
  → Controller receives request, calls Service
  → Service validates, checks permissions, executes DB operations
  → Response returned with appropriate status code
```

Each module has clear separation:
- **AuthModule** — auth logic only
- **ConversationsModule** — conversation CRUD + permissions
- **MessagesModule** — message CRUD + receipt management
- **UsersModule** — user queries (no auth logic)

---

## 2. Authentication layer (JWT)

**JwtStrategy:**
- Extracts token from `Authorization: Bearer <token>` header
- Verifies signature against `JWT_ACCESS_SECRET`
- Throws 401 if expired or invalid
- `validate()` returns `{ sub, email }` attached to `req.user`

**JwtAuthGuard:**
- Runs before controller handler
- Uses JwtStrategy to validate request
- Throws 401 if validation fails
- Used on protected routes: `@UseGuards(JwtAuthGuard)`

**@CurrentUser() decorator:**
- Extracts `req.user` cleanly
- Lets you write: `@CurrentUser() user: { sub: string }`
- Instead of: `@Req() req: Request` then `req.user.sub`

**Key insight:** Tokens are short-lived (15m). Refresh tokens (7d) are HttpOnly cookies — only sent to `/auth/refresh` endpoint, not on every request.

---

## 3. Conversations module — uniqueness & transactions

### Schema constraint
```prisma
model Conversation {
  id String @id @default(uuid())
  type ConversationType
  name String?
  participant1Id String?
  participant2Id String?
  groupAvatarUrl String?
  createdAt DateTime @default(now())

  @@unique([type, participant1Id, participant2Id])
}
```

**Why the unique constraint matters:**
```
User A clicks "start conversation with B" twice (network is slow)

Without constraint:
  → First click creates: Conversation(id: conv-1, participant1: A, participant2: B)
  → Second click creates: Conversation(id: conv-2, participant1: A, participant2: B)
  ❌ Two identical conversations exist

With constraint:
  → First click creates: Conversation(id: conv-1, ...)
  → Second click tries to create same combination
  → Postgres rejects: "Unique constraint violated"
  → Client gets 409 Conflict
  ✅ Only one conversation exists
```

**Composite PK on ConversationParticipant:**
```prisma
@@id([conversationId, userId])
```
Prevents one user appearing twice in the same conversation.

### Transaction pattern for create
```typescript
const conversation = await this.dbService.$transaction(async (tx) => {
  const conv = await tx.conversation.create({
    data: { participant1Id, participant2Id, type }
  });

  await tx.conversationParticipant.create({
    data: { conversationId: conv.id, userId: participant1Id, role: MEMBER }
  });

  await tx.conversationParticipant.create({
    data: { conversationId: conv.id, userId: participant2Id, role: MEMBER }
  });

  return conv;
});
```

**Why callback syntax (not array):**
- Operations execute sequentially, not in parallel
- Later operations can reference results of earlier ones (`conv.id`)
- All succeed or all fail together

**Why transaction at all:**
- Message and receipt creation must be atomic
- If message is created but receipt fails, you have orphaned data
- Transaction guarantees consistency

### Validations
```
Before DB touch:
1. senderId !== receiverId (can't chat with yourself)
2. receiver user exists (via UsersService.findById)
3. conversation doesn't already exist (via findFirst)

DB itself enforces:
- Unique constraint on (type, participant1Id, participant2Id)
```

---

## 4. Messages module — receipts & participant checking

### Schema
```prisma
model Message {
  id String @id @default(uuid())
  content String
  senderId String
  conversationId String
  type MessageType
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt   // auto-updates on modification
  deletedAt DateTime?              // nullable, only set on soft-delete

  sender User @relation(...)
  conversation Conversation @relation(...)
  receipts MessageReceipt[]
}

model MessageReceipt {
  messageId String
  userId String
  status MessageStatus  // SENT | DELIVERED | READ
  updatedAt DateTime

  @@id([messageId, userId])
}
```

**Why receipts exist for ALL participants, not just receiver:**

```
Scenario: User A sends message to User B in a conversation

Database creates:
1. Message { id: msg-1, senderId: A, content: "..." }
2. MessageReceipt { messageId: msg-1, userId: A, status: SENT }
3. MessageReceipt { messageId: msg-1, userId: B, status: SENT }

Why User A's receipt too?
- A's app queries message and checks A's receipt → sees status: SENT
- Later when B opens app, B's receipt updates to DELIVERED
- A's app polls → sees B's receipt is now DELIVERED → shows double tick
- Later when B reads, B's receipt updates to READ
- A's app polls → sees B's receipt is now READ → shows blue tick

Without A's receipt:
- A would only know "message exists" not "message status"
- A couldn't show ticks to A themself
```

### Message creation flow
```
1. Validate sender is a participant in that conversation
   → if not: throw 403 Forbidden
   → if yes: continue

2. Atomic transaction:
   a. Create Message row
   b. Fetch all ConversationParticipants for that conversation
   c. Create MessageReceipt for each participant (all start as SENT)

3. Return Message with receipts
```

**Why participant check BEFORE transaction:**
- If check fails (user not a participant), return 403 immediately
- No point starting a transaction that will ultimately fail
- Save DB resources, fail fast

**Why participant check is separate method:**
```typescript
// In ConversationsService:
async isParticipant(conversationId: string, userId: string): boolean {
  const participant = await this.dbService.conversationParticipant.findFirst({
    where: { conversationId, userId }
  });
  return !!participant;
}

// In MessageService:
const isParticipant = await this.conversationService.isParticipant(
  dto.conversationId,
  senderId
);
if (!isParticipant) throw new ForbiddenException('Not a participant');
```

This keeps concerns separated — `ConversationsService` owns all conversation queries.

### Why findFirst for composite PK
```typescript
// WRONG — findUnique doesn't work well with composite PKs
const participant = await this.dbService.conversationParticipant.findUnique({
  where: {
    conversationId_userId: { conversationId, userId }  // ← error-prone syntax
  }
});

// RIGHT — findFirst works with any combination of fields
const participant = await this.dbService.conversationParticipant.findFirst({
  where: { conversationId, userId }
});
```

`findFirst` is the standard, safe choice for querying by composite PK values.

---

## 5. Error handling patterns

### Validation errors (400)
```typescript
if (content === '') throw new BadRequestException('Content cannot be empty');
if (!isValidUUID(conversationId)) throw new BadRequestException('Invalid ID');
```

### Permission errors (403)
```typescript
if (!isParticipant) throw new ForbiddenException('Not a participant');
```

### Not found errors (404)
```typescript
const user = await this.userService.findById(receiverId);
if (!user) throw new NotFoundException('User not found');
```

### Conflict errors (409)
```typescript
if (existingConversation) throw new ConflictException('Conversation already exists');
```

### Unexpected errors (500)
```typescript
catch (e) {
  if (e instanceof BadRequestException) throw e;
  if (e instanceof NotFoundException) throw e;
  if (e instanceof ForbiddenException) throw e;
  if (e instanceof ConflictException) throw e;
  throw new InternalServerErrorException('Unexpected error');
}
```

**Pattern:** Known exceptions pass through, unexpected ones become 500.

---

## 6. DTO validation patterns

### CreateConversationDto
```typescript
export class CreateConversationDto {
  @IsEnum(ConversationType)
  type: ConversationType;

  @IsUUID()
  receiverId: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUrl()
  groupAvatarUrl?: string;
}
```

**Notes:**
- `type` uses `@IsEnum` to validate against actual enum values
- `receiverId` uses `@IsUUID()` to validate UUID format
- Optional fields use `@IsOptional()` — if present, still validated by other decorators
- GlobalValidationPipe handles: whitelist (strip unknown fields), transform (convert to DTO instance), forbidNonWhitelisted (throw on extra fields)

### CreateMessageDto
```typescript
export class CreateMessageDto {
  @IsUUID()
  conversationId: string;

  @IsString()
  @MinLength(1)
  content: string;

  @IsEnum(MessageType)
  type: MessageType;
}
```

**Notes:**
- `@MinLength(1)` prevents empty strings
- Client sends `conversationId` in body, not URL path (simpler)

---

## 7. Controller patterns

### Protected endpoint
```typescript
@Controller('messages')
export class MessageController {
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(
    @Body() dto: CreateMessageDto,
    @CurrentUser() user: { sub: string }
  ) {
    return this.messageService.create(dto, user.sub);
  }
}
```

**Pattern:**
- `@UseGuards(JwtAuthGuard)` runs before handler
- `@CurrentUser()` extracts authenticated user cleanly
- Controller is thin — no logic, just delegation

---

## 8. Module wiring

### ConversationsModule
```typescript
@Module({
  imports: [UsersModule],
  providers: [ConversationsService],
  controllers: [ConversationsController],
  exports: [ConversationsService],  // ← important: so other modules can inject it
})
export class ConversationsModule {}
```

### MessagesModule
```typescript
@Module({
  imports: [ConversationsModule],
  providers: [MessageService],
  controllers: [MessageController],
})
export class MessagesModule {}
```

### AppModule
```typescript
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    UsersModule,
    AuthModule,
    ConversationsModule,
    MessagesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

**Order matters for understanding:**
- `ConfigModule` first (needed by everything)
- `DatabaseModule` next (needed by everything)
- `UsersModule` (no dependencies on other domain modules)
- `AuthModule` (depends on UsersModule)
- `ConversationsModule` (depends on UsersModule)
- `MessagesModule` (depends on ConversationsModule)

---

## 9. Database design decisions made

**One Conversation table (not split by type):**
- GROUP conversations need `name` and `groupAvatarUrl`
- DIRECT conversations don't
- Solution: One table with nullable fields, `type` enum to distinguish
- Tradeoff: Some columns are always null for DIRECT, but simplicity wins

**Composite PKs on join tables:**
- ConversationParticipant: `@@id([conversationId, userId])`
- MessageReceipt: `@@id([messageId, userId])`
- Benefit: No need for separate UUID ID columns; the combination is unique
- Tradeoff: Can't query by single field easily (but we don't need to)

**Soft deletes on Message:**
- `deletedAt DateTime?` instead of hard delete
- Benefit: Message history survives deletion, read receipts intact, audit trail
- Tradeoff: Queries must filter `WHERE deletedAt IS NULL` (done in find methods)

**Participant fields on Conversation:**
- `participant1Id` and `participant2Id` stored on Conversation row
- Same data also in ConversationParticipant table
- Benefit: Database enforces uniqueness constraint directly
- Tradeoff: Data duplication, extra fields, extra FK constraints

---

## 10. Phase 1 vs Phase 2

**Phase 1 (complete):**
- REST API only
- Requests are request-response cycles (client waits for response)
- Message polling would require client to hit endpoint every N seconds
- Works, but not real-time

**Phase 2 (next):**
- WebSocket layer via Socket.IO
- Client stays connected, receives messages instantly
- Typing indicators, presence tracking
- Horizontal scaling via Redis adapter

Phase 1 is the foundation — without the solid REST layer and database design, Phase 2's realtime becomes fragile.

---

## 11. Key learnings

1. **Uniqueness at database level** — don't rely on app logic alone (constraints prevent bugs at the source)
2. **Transactions for multi-row operations** — atomic all-or-nothing prevents orphaned data
3. **Participant checking before expensive operations** — fail fast, save resources
4. **Receipts for all participants** — even sender's own message needs a receipt to track status
5. **Composite PKs on join tables** — natural primary key based on the relationship, no artificial UUID needed
6. **Soft deletes** — preserve history and audit trails
7. **Module exports** — services aren't magically available to other modules; they must be exported
8. **Guard-before-service pattern** — authenticate/authorize before hitting the database
9. **DTO validation as a security boundary** — DTOs + ValidationPipe strip malicious input before it reaches services
10. **Error codes matter** — 400/403/404/409/500 each tell the client exactly what went wrong