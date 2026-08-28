import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { ConversationsService } from '../conversations/conversations.service';
import { MessageStatus } from '@prisma/client';

@Injectable()
export class MessageService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly conversationService: ConversationsService,
  ) {}

  async create(dto: CreateMessageDto, senderId: string) {
    try {
      const isParticipant = await this.conversationService.isParticipant(
        dto.conversationId,
        senderId,
      );

      if (!isParticipant) throw new ForbiddenException('Not a participant');
      // What is somebody hacks the conversation they are not part of .And also bypass isParticpant pass, what will be the db level defense in this.
      // Nothing is there right now , so TODO : db level defense would be to foreign key constraint . Add that later.
      
      const message = await this.dbService.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            content: dto.content,
            conversationId: dto.conversationId,
            type: dto.type,
            senderId,
          },
        });

        const participants = await tx.conversationParticipant.findMany({
          where: {
            conversationId: dto.conversationId,
          },
        });

        await Promise.all(
          participants.map((participant) => {
            return tx.messageRecipient.create({
              data: {
                messageId: message.id,
                status: MessageStatus.SENT,
                userId: participant.userId,
              },
            });
          }),
        );
        return message;
      });

      return message;
    } catch (e) {
      if (e instanceof ForbiddenException) throw e;

      throw new InternalServerErrorException(
        'Internal server error.Please try again.',
      );
    }
  }
}
