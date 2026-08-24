import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {

  constructor(config: ConfigService) {

    // Earlier we were extracting the secret directly inside the secretOrKEY which was causing error - 
    // As the config.get('jwt_secret') might return undefined also , if key doesn't exist .
    // So we have to extract the value here first and throw error if not defined in the env

    // Also we removed this becuase private config actually  tries to assign to this.config before super() is called which is illegal in derived classes.

    // Fixed by removing the private and use it like a regular parameter- 
    // Now we are just using the config parameter directly to extract the secret, then passing it to super() .
    // Once super() returns this is available if you ever need it later.
    const secret = config.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET is not defined in environment');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: { sub: string; email: string }) {
    return { sub: payload.sub, email: payload.email };
  }
}
