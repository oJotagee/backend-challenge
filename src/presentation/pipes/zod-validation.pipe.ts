import { type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

export class RequestValidationError extends Error {
  readonly code = 'INVALID_PAYLOAD';

  constructor(readonly details: { path: string; message: string }[]) {
    super('Request validation failed');
    this.name = 'RequestValidationError';
  }
}

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new RequestValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
}
