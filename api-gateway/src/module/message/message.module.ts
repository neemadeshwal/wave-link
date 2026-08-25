import { Module } from '@nestjs/common';
import { MessageService } from './message.service';
import { MessageController } from './message.controller';
import { ConversationsService } from '../conversations/conversations.service';
import { ConversationsModule } from '../conversations/conversations.module';

@Module({
  imports:[ConversationsModule],
  controllers: [MessageController],
  providers: [MessageService],
})
export class MessageModule {}
