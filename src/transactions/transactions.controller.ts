import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  AuthorizeTransactionDto,
  authorizeTransactionSchema,
} from './dto/authorize-transaction.dto';
import {
  ConfirmTransactionDto,
  confirmTransactionSchema,
} from './dto/confirm-transaction.dto';
import {
  VoidTransactionDto,
  voidTransactionSchema,
} from './dto/void-transaction.dto';
import { TransactionsService } from './transactions.service';

@Controller('v1/pos/transactions')
export class TransactionsController {
  constructor(private readonly service: TransactionsService) {}

  @Post('authorize')
  async authorize(
    @Body(new ZodValidationPipe(authorizeTransactionSchema))
    dto: AuthorizeTransactionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.authorize(dto);
    res.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.transaction;
  }

  @Post('confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirm(
    @Body(new ZodValidationPipe(confirmTransactionSchema))
    dto: ConfirmTransactionDto,
  ): Promise<void> {
    await this.service.confirm(dto.transactionId);
  }

  @Post('void')
  @HttpCode(HttpStatus.NO_CONTENT)
  async void(
    @Body(new ZodValidationPipe(voidTransactionSchema))
    dto: VoidTransactionDto,
  ): Promise<void> {
    await this.service.void(dto);
  }
}
