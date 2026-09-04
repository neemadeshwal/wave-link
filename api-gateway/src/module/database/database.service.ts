import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { PrismaPg } from '@prisma/adapter-pg';

import { Pool } from 'pg';
import { ConfigService } from '@nestjs/config';
@Injectable()
export class DatabaseService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL');

    const pool = new Pool({ connectionString });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }
  async onModuleInit() {
    await this.$connect();
    console.log('✅ Database connected');
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
