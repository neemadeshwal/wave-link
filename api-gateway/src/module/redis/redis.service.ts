import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client!: Redis;

  constructor(
    private config:ConfigService
  ) {}
  async onModuleInit() {
    this.client = new Redis({
      host: this.config.get<string>('REDIS_HOST'),
      port: this.config.get<number>('REDIS_PORT'),
    });
    console.log('✅ Redis connected');
  }
  async onModuleDestroy() {
    await this.client.quit();
    console.log('Redis disconnected');
  }

  async addOnlineUser(userId: string) {
    await this.client.sadd('online_users', userId);
  }

  async removeOnlineUser(userId: string) {
    await this.client.srem('online_users', userId);
  }

  async getOnlineUser(): Promise<string[]> {
    return this.client.smembers('online_users');
  }

  async isUserOnline(userId: string): Promise<boolean> {
    const result = await this.client.sismember('online_users', userId);
    return result === 1;
  }
}
