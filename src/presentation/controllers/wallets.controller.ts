import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';

import { type LedgerPageView, WageringQueries, type WalletView } from '@/application/use-cases/wagering-queries.use-case';
import { OpenWalletUseCase, type OpenWalletResult } from '@/application/use-cases/open-wallet.use-case';
import { ReconcileWalletUseCase, type ReconciliationResult } from '@/application/use-cases/reconcile-wallet.use-case';

import {
  type CreateWalletDto,
  createWalletSchema,
  type LedgerQueryDto,
  ledgerQuerySchema,
  uuidParamSchema,
} from '../dtos/wallet.dto';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { correlationIdOf, type RequestWithId } from './request-context';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletUseCase,
    private readonly queries: WageringQueries,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletDto,
    @Req() req: RequestWithId,
  ): Promise<OpenWalletResult> {
    return this.openWallet.execute({ ...body, correlationId: correlationIdOf(req) });
  }

  @Get(':walletId')
  get(@Param('walletId', new ZodValidationPipe(uuidParamSchema)) walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', new ZodValidationPipe(uuidParamSchema)) walletId: string,
    @Query(new ZodValidationPipe(ledgerQuerySchema)) query: LedgerQueryDto,
  ): Promise<LedgerPageView> {
    return this.queries.listLedger(walletId, query.cursor, query.limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', new ZodValidationPipe(uuidParamSchema)) walletId: string): Promise<ReconciliationResult> {
    return this.reconcileWallet.execute(walletId);
  }
}
