import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConversationsService } from '../conversations/conversations.service';
import { MessageService } from '../message/message.service';
import { CreateMessageDto } from '../message/dto/create-message.dto';
import { RedisService } from '../redis/redis.service';

@WebSocketGateway({
  cors: {
    origin: '*', // for local testing only — never use '*' in production
  },
  namespace: '/chat',
})
// why onGatewayinit was also implemented.
// So for authenticating the connection there are two ways with which we do
// Earlier appraoch was to use guard but for guard during the handshake the connection will be established and for a temp time it will allow the connection then
// it will go thorugh the guards and block it . Now the issue is this is not a subscribeevent this is just connection gateway so the normal passing of jwt gurad wont run as it is outside the nestjs req-res cycle so unauthorized request will still access the connections

// To resolve the issue we have to use socket.io middleware which basically does the check before any gateway so direclty on namespace it will allow or reject the request.
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private conversationService: ConversationsService,
    private messageService: MessageService,
    private redisService: RedisService,
  ) {}
  @WebSocketServer()
  server!: Server;

  afterInit(server: Server) {
    // This runs once , when the gateway is initialzied  (server is ready)
    // Here you register socket.io middleware directly on namespace / server

    server.use((socket, next) => {
      // const token = socket.handshake.auth.token;
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (!token) return next(new Error('Unauthorized'));

      try {
        const payload = this.jwtService.verify(token, {
          secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
        });

        socket.data.user = payload;
        next();
      } catch (e) {
        next(new Error('Unauthorized'));
      }
    });
  }
  async handleConnection(client: Socket) {
    console.log(`Client connected ${client.id}`);

    const userId = client.data.user.sub;

    await this.redisService.addOnlineUser(userId);
  }

  async handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    console.log('Rooms at disconnect time:', Array.from(client.rooms)); // ← add this

    const userId = client.data.user.sub;

    await this.redisService.removeOnlineUser(userId);

    const rooms = client.data.joinedRoom || new Set<string>();

    for (const room of rooms) {
      client.broadcast.to(room).emit('user:offline', { userId });
    }
  }

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

      if (!client.data.joinedRoom) {
        client.data.joinedRoom = new Set<string>();
      }
      client.data.joinedRoom.add(conversationId);

      client.broadcast.to(conversationId).emit('user:online', { userId });

      return { success: true };
    } catch (e) {
      // NOTE:  since we are returning the error event we cant
      // simply use the throw because if we do that it will go through the nestjs exception filter
      // and socket response wont know the error happenend so always return so that even error will
      // be send like a proper response.
      if (e instanceof UnauthorizedException)
        return {
          success: false,
          error: e.message,
        };
      return { success: false, error: 'Internal server error' };
    }
  }
  // TODO: Phase 2 gap - @MessageBody() does not auto-validate like HTTP @Body() does,
  // since app.useGlobalPipes() only applies to the HTTP pipeline, not WebSocket.
  // Fix: apply ValidationPipe explicitly per-handler (@MessageBody(new ValidationPipe()) dto: CreateMessageDto)
  // or @UsePipes(ValidationPipe) at the gateway class level. Also need a WsExceptionFilter
  // to convert validation failures into the {success:false, error:...} ack shape instead of
  // the default generic 'exception' event.

  @SubscribeMessage('message:send')
  async handleMessageSentEvent(
    @ConnectedSocket() client: Socket,
    // Notice - here you have actually passed the validationpipe() instance unlike in http
    // Reason- we are already adding the newvaldiatonpiop() in global in app.ts now that way we dont have to handle it as class level
    // But that validationPipe() is only for http transport layer
    // For ws since it wont handle it on its own or catch the eror we pass it explicitly
    @MessageBody(new ValidationPipe())
    data: CreateMessageDto,
  ) {
    try {
      // We donot have to again check this i guess about that whether the conversationId or senderId exist or not ??
      const conversationId = data.conversationId;
      const senderId = client.data.user.sub;

      // if(!conversationId||!userId) throw new UnauthorizedException('You are not authorized for sending the message.');

      // should i have to manuallly check the content also cant messagebody() pipe handle it automcaticallly .

      const createMessageObj = {
        conversationId,
        type: data.type,
        content: data.content,
      };

      const message = await this.messageService.create(
        createMessageObj,
        senderId,
      );

      this.server.to(conversationId).emit('message:new', message);

      return { success: true, message };
    } catch (e) {
      return {
        success: false,
        error:
          e instanceof NotFoundException || e instanceof BadRequestException
            ? e.message
            : 'Internal server error',
      };
    }
  }

  @SubscribeMessage('typing:start')
  handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const conversationId = data.conversationId;
    const senderId = client.data.user.sub;
    client.broadcast
      .to(conversationId)
      .emit('typing:start', { userId: senderId });
  }

  @SubscribeMessage('typing:stop')
  handleTypingEnd(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const conversationId = data.conversationId;
    const senderId = client.data.user.sub;

    client.broadcast
      .to(conversationId)
      .emit('typing:stop', { userId: senderId });
  }
}
