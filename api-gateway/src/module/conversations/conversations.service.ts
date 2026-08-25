import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { UsersService } from '../users/users.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { RoleType } from '@prisma/client';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly dbService: DatabaseService,
    private readonly userService: UsersService,
  ) {}

  async create(dto: CreateConversationDto, senderId: string) {
    try {
      // 1. Validate if user is not creating conversation with itself.
      if (dto.receiverId === senderId)
        throw new BadRequestException(
          "You can't create conversation with yourself.",
        );

      // 2. Check if receiver exists (findbyid throws if not)
      await this.userService.findById(dto.receiverId);

      // 3. Check if conversation donot exist already.
      const existing = await this.dbService.conversation.findFirst({
        where: {
          AND: [
            { type: dto.type },
            { participant1Id: senderId },
            { participant2Id: dto.receiverId },
          ],
        },
      });
      if (existing) {
        throw new ConflictException(
          'Already conversation row exist for this pair',
        );
      }
      // Array syntax
      // About transactions , the most simple way to write transactions is by,
      // Array syntax which bascially means to execute all the operations in array
      // atomically. But all three operations are prepared before the execution starts ,
      // So the excution happens in parallel (concurrently) and not one after the other.

      // The problem wit this appracoh is that as the second and third operations depend on the
      // conversationId in the first , but first hasn't finished,

      // Callback Syntax
      // To solve this issue , we run the async func as a single transc first.
      // Tx is the transactional client - same as this.dbservic but locked to this transaction
      // execution happens sequentially and benefit , each operation can use results from the previous
      // operations. await tx.conversation.create() waits for the conversation to be created, stores it in conversation variable.

      // Now the rest two operations can use conversation.id, now it exists , and return the conversaton at the end deremines the
      // whole transcation returns

      // 4. Create all the three rows atomically
      const result = await this.dbService.$transaction(async (tx) => {
        const conversation = await tx.conversation.create({
          data: {
            participant1Id: senderId,
            participant2Id: dto.receiverId,
            type: dto.type,
            groupAvatarUrl: dto.groupAvatarUrl,
            name: dto.name,
          },
        });

        await tx.conversationParticipant.create({
          data: {
            role: RoleType.MEMBER,
            conversationId: conversation.id,
            userId: senderId,
          },
        });

        await tx.conversationParticipant.create({
          data: {
            role: RoleType.MEMBER,
            conversationId: conversation.id,
            userId: dto.receiverId,
          },
        });
        return conversation;
      });
      return result;
    } catch (e) {
      if (e instanceof NotFoundException) throw e;

      if (e instanceof ConflictException) throw e;

      if (e instanceof BadRequestException) throw e;
      console.log(e);
      throw new InternalServerErrorException('internal error occured.');
    }
  }

  async isParticipant(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    const participant = await this.dbService.conversationParticipant.findFirst({
      where: {
        conversationId,
        userId,
      },
    });
    return !!participant;
  }
}
