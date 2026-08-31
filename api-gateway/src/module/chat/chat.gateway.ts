import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@WebSocketGateway({
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
  handleConnection(client: Socket) {
    console.log(`Client connected ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
  }
}
