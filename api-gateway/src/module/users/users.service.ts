import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

// supposed to import like * as bcrypt as it is commonjs module and this import style can cause issues in some ts configs
//import bcrypt from 'bcrypt';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from 'src/common/dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly dbService: DatabaseService) {}

  async create(dto: CreateUserDto) {
    try {
      // notice that when user is
      const existingUser = await this.dbService.user.findUnique({
        where: { email: dto.email },
      });
      if (existingUser) throw new ConflictException('Email already exist');

      // hashing the password for extra security
      const passHash = await bcrypt.hash(dto.password, 10);

      const user = await this.dbService.user.create({
        // Usually we just pass the data object , but it not recommended for dto obj to directly pass while creating user,
        // Reason why - dto fields can mismatch with the actual db table fields and sometimes we want to transform our fields before
        //storing it to db so for that reason always map the respective dto to its respective db fields.

        // forgot to add default(now()) which caused the incomplete data fields erro while creating so changed the schema and added
        //  date(now()) in date time field.

        data: {
          name: dto.name,
          email: dto.email,
          avatarUrl: dto.avatarUrl,
          passwordHash: passHash,
        },
      });

      const { passwordHash, ...userWithoutPassword } = user;

      return userWithoutPassword;
    } catch (e) {
      // The same conflictException is rethrown here
      // Reason why - Throwing it again as it is , lets it bubble up to nestjs's exception filter,
      // which will send 409 to the client.
      // rethrowing also keep the error thrown unchanged (from conflic -internal server error)
      if (e instanceof ConflictException) throw e;
      throw new InternalServerErrorException('Unable to create user');
    }
  }

  async findByEmail(email: string) {
    try {
      const user = await this.dbService.user.findUnique({
        where: {
          email,
        },
      });

      return user;
    } catch (e) {
      throw new InternalServerErrorException('Failed to fetch user');
    }
  }
}
