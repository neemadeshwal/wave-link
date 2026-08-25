import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth } from '@nestjs/swagger';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async create(
    @CurrentUser() user: { sub: string },
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversationsService.create(dto, user.sub);
  }
}
