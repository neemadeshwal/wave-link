import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './module/database/database.module';
import { UsersModule } from './module/users/users.module';

@Module({
  imports: [UsersModule,  DatabaseModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
