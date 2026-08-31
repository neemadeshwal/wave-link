import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { AuthModule } from '../auth/auth.module';
import { ConversationsModule } from '../conversations/conversations.module';

// Note - we always import the entire module and not just few parts of it . 
@Module({
imports:[AuthModule,ConversationsModule],
  providers: [ChatGateway, ChatService],
})
export class ChatModule {}
