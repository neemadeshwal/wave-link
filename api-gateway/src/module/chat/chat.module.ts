import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { AuthModule } from '../auth/auth.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { MessageModule } from '../message/message.module';

// Note - we always import the entire module and not just few parts of it . 
@Module({
imports:[AuthModule,ConversationsModule,MessageModule],
  providers: [ChatGateway, ChatService],
})
export class ChatModule {}
