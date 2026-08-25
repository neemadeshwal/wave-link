import { MessageType } from "@prisma/client";
import { IsEnum, IsString, IsUUID, MinLength } from "class-validator";
import {Trim} from "class-sanitizer";
export class CreateMessageDto{

    @IsEnum(MessageType)
    type!:MessageType;

    @IsUUID()
    conversationId!:string;

    @IsString()
    @MinLength(1)
    @Trim()
    content!:string;

}