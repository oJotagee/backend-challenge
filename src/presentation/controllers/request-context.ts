export interface RequestWithId {
  id?: unknown;
}

export function correlationIdOf(req: RequestWithId): string {
  return typeof req.id === 'string' ? req.id : crypto.randomUUID();
}
