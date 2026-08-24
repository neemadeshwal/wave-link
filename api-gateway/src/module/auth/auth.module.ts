import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UsersModule } from '../users/users.module';
import { JwtStrategy } from './strategy/jwt.strategy';

@Module({
  imports:[UsersModule, JwtModule.registerAsync({
    imports:[ConfigModule],
    inject: [ConfigService],
    
     useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
  })],
  controllers: [AuthController],

//   Controller → @UseGuards(JwtAuthGuard)
//     ↓
// JwtAuthGuard calls AuthGuard('jwt')
//     ↓
// AuthGuard('jwt') asks Passport: "do you have a strategy named 'jwt'?"
//     ↓
// Passport looks for JwtStrategy (which registered itself as 'jwt')
//     ↓
// But Passport only knows about strategies that were instantiated!

// So JwtStrategy needs to be in AuthModule's providers because:

// It makes NestJS instantiate JwtStrategy
// When instantiated, it extends PassportStrategy(Strategy), which automatically registers itself with Passport as the 'jwt' strategy
// Without it in providers, it's never instantiated, Passport never knows about it, and you get "Unknown authentication strategy 'jwt'" error

  providers: [AuthService,JwtStrategy],
})
export class AuthModule {}
