import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from 'src/common/dto/create-user.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UsersService,

    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}
  async signup(dto: CreateUserDto) {
    try {
      const user = await this.userService.create(dto);
      return this.issueTokens(user.id, user.email);
    } catch (e) {
      if (e instanceof ConflictException) throw e;

      throw new InternalServerErrorException('An error occured');
    }
  }

  async login(dto: LoginDto) {
    try {
      const user = await this.userService.findByEmail(dto.email);

      if (!user) throw new BadRequestException('Invalid credentials');
      // order matters always plain text first then hash
      const passwordValid = await bcrypt.compare(
        dto.password,
        user.passwordHash,
      );

      if (!passwordValid) throw new BadRequestException('Invalid credentials');

      return this.issueTokens(user.id, user.email);
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new InternalServerErrorException('An error occured');
    }
  }

  private async issueTokens(userId: string, email: string) {
    const payload = { sub: userId, email };

    // the authmodule is already handling the configuration in access token . 
    const accessToken = await this.jwtService.signAsync(payload);
    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: '7d',
    });
    return { accessToken, refreshToken };
  }
}
