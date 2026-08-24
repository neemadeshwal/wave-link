import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { CreateUserDto } from 'src/common/dto/create-user.dto';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { jwtAuthGuard } from './guards/jwt-auth.guard';
import { ApiBearerAuth } from '@nestjs/swagger';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('signup')
  signup(@Body() dto: CreateUserDto) {
    return this.authService.signup(dto);
  }

  @Get('me')
  // .addBearerAuth() is added in the swagger config,which adds the 'authorize button' to
  // swagger UI . But swagger was not told which endpoints actually need that token.

  // @ApiBearerAuth() so even though feeding the swagger with token , swagger ui didnt know that
  // /auth/me required the token so it never sent the authroization header with your request.
  // Your backend got a request without a token -> 401 unauthorized.
  @ApiBearerAuth()
  @UseGuards(jwtAuthGuard)
  getMe(@CurrentUser() user: { sub: string; email: string }) {
    return user;
  }

  // 1. Request hits protected route without Authorization header
  // 2. JwtAuthGuard runs
  // 3. JwtStrategy tries to extract token:
  //    - ExtractJwt.fromAuthHeaderAsBearerToken() looks for Authorization header
  //    - Header doesn't exist → extraction returns null/undefined
  // 4. Passport checks: "is there a token to validate?"
  //    - No token found
  //    - The guard requires authentication
  // 5. Passport throws UnauthorizedException (401)
  // 6. @CurrentUser() decorator is NEVER reached
  //    - The request dies at the guard level
}
