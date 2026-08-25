import { ConversationType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateConversationDto {
  @IsString()
  receiverId!: string;

  @IsEnum(ConversationType)
  type!: ConversationType;

  // name is just restricted to group so making it optional is good
  @IsOptional()
  @IsString()
  name?: string;

  // group avatar url is just restricted to group so making it optional is good

  @IsOptional()
  @IsUrl()
  groupAvatarUrl?: string;
}
