import { Body, Controller, Get, Headers, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';

import { WageringQueries, type WagerTransactionView } from '@/application/use-cases/wagering-queries.use-case';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionResult,
} from '@/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionStatus } from '@/domain/enums/wager-transaction-status.enum';

import { idempotencyKeySchema, type WagerTransactionDto, wagerTransactionSchema } from '../dtos/wager-transaction.dto';
import { uuidParamSchema } from '../dtos/wallet.dto';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { correlationIdOf, type RequestWithId } from './request-context';

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') rawIdempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(wagerTransactionSchema)) body: WagerTransactionDto,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ProcessWagerTransactionResult> {
    const idempotencyKey = new ZodValidationPipe(idempotencyKeySchema).transform(rawIdempotencyKey);
    const result = await this.processWager.execute({
      idempotencyKey,
      data: body,
      correlationId: correlationIdOf(req),
      source: { type: 'http' },
    });

    res.status(statusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId', new ZodValidationPipe(uuidParamSchema)) id: string): Promise<WagerTransactionView> {
    return this.queries.getTransaction(id);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.queries.getTransactionByProviderExternalId(providerId, externalTransactionId);
  }
}

/**
 * 201 aplicada agora · 200 replay de aplicada · 202 aguardando referência ·
 * 422 rejeitada por regra de negócio (inclusive em replay: a decisão não muda).
 */
function statusFor(result: ProcessWagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}
