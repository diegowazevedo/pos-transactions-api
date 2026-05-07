import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import * as crypto from 'crypto';
import { Request } from 'express';
import { RedisService } from '../../redis/redis.service';
import { SKIP_HMAC_KEY } from '../decorators/skip-hmac.decorator';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Injectable()
export class HmacGuard implements CanActivate {
  private readonly logger = new Logger(HmacGuard.name);
  private readonly secret: string;
  private readonly toleranceSeconds: number;

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {
    this.secret = this.config.getOrThrow<string>('hmac.secret');
    this.toleranceSeconds = this.config.getOrThrow<number>(
      'hmac.timestampToleranceSeconds',
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_HMAC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context.switchToHttp().getRequest<RawBodyRequest>();

    const signature = this.headerString(req, 'x-signature');
    const timestamp = this.headerString(req, 'x-timestamp');

    if (!signature || !timestamp) {
      throw new UnauthorizedException('Missing X-Signature or X-Timestamp');
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      throw new UnauthorizedException('Invalid X-Timestamp');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > this.toleranceSeconds) {
      throw new UnauthorizedException('Timestamp outside tolerance window');
    }

    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const method = req.method.toUpperCase();
    const path = req.originalUrl.split('?')[0];
    const payload = `${timestamp}.${method}.${path}.${rawBody.toString('utf8')}`;

    const expected = crypto
      .createHmac('sha256', this.secret)
      .update(payload)
      .digest('hex');

    if (!this.safeCompareHex(expected, signature)) {
      throw new UnauthorizedException('Invalid signature');
    }

    const replayKey = `hmac:seen:${signature}`;
    const reserved = await this.redis.client.set(
      replayKey,
      '1',
      'EX',
      this.toleranceSeconds,
      'NX',
    );
    if (reserved !== 'OK') {
      throw new UnauthorizedException('Signature replay detected');
    }

    return true;
  }

  private headerString(req: Request, name: string): string | undefined {
    const value = req.headers[name];
    if (Array.isArray(value)) return value[0];
    return value;
  }

  private safeCompareHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
      return false;
    }
  }
}
