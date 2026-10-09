import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

import {
  IdempotencyConflictError,
  InvalidCursorError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '@/application/errors/application-errors';
import { BusinessRuleViolationError, CurrencyMismatchError, InvalidMoneyError, InvalidWagerTransactionError } from '@/domain/errors/domain-error';

import { RequestValidationError } from '../pipes/zod-validation.pipe';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Um status por SITUAÇÃO, igual em todos os endpoints (seção 9):
 * 400 payload inválido · 404 recurso inexistente · 409 conflito (idempotência / wallet duplicada)
 * 422 regra de negócio · 503 falha transitória (pode reenviar) · 500 bug.
 * (202 pendente e 422 REJECTED de transação são respostas normais do controller, não erros.)
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.map(exception);

    if (status === HttpStatus.SERVICE_UNAVAILABLE) response.setHeader('Retry-After', '1');

    if (status >= 500) this.logger.error({ err: exception, code: body.error.code }, 'request failed');

    response.status(status).json(body);
  }

  private map(e: unknown): { status: number; body: ErrorBody } {
    const body = (code: string, message: string, details?: unknown): ErrorBody => ({
      error: { code, message, ...(details ? { details } : {}) },
    });

    if (e instanceof RequestValidationError) return { status: 400, body: body(e.code, e.message, e.details) };

    if (
      e instanceof InvalidMoneyError ||
      e instanceof CurrencyMismatchError ||
      e instanceof InvalidWagerTransactionError ||
      e instanceof InvalidCursorError
    ) {
      return { status: 400, body: body(e.code, e.message) };
    }

    if (e instanceof WalletNotFoundError || e instanceof TransactionNotFoundError) {
      return { status: 404, body: body(e.code, e.message) };
    }

    if (e instanceof IdempotencyConflictError) {
      return { status: 409, body: body(e.code, e.message, { existingTransactionId: e.existingTransactionId }) };
    }

    if (e instanceof WalletAlreadyExistsError) return { status: 409, body: body(e.code, e.message) };

    if (e instanceof BusinessRuleViolationError) return { status: 422, body: body(e.code, e.message) };

    if (e instanceof TransientInfrastructureError) {
      return { status: 503, body: body(e.code, 'Temporarily unavailable, retry with the same Idempotency-Key') };
    }

    if (e instanceof HttpException) {
      return { status: e.getStatus(), body: body(HttpStatus[e.getStatus()] ?? 'HTTP_ERROR', e.message) };
    }

    return { status: 500, body: body('INTERNAL_ERROR', 'Unexpected error') };
  }
}
