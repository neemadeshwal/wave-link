import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { PrismaPg } from '@prisma/adapter-pg';

import { Pool } from 'pg';
@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit,OnModuleDestroy {

     constructor(){
      const pool= new Pool({connectionString:process.env.DATABASE_URL});
      const adapter=new PrismaPg(pool);
      super({adapter});
     }
     async onModuleInit() {
         await this.$connect();
    console.log('✅ Database connected');

     }
     async onModuleDestroy() {
         await this.$disconnect();
     }
}
