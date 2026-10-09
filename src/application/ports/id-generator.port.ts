import { uuidv7 } from 'uuidv7';

export const ID_GENERATOR = Symbol('ID_GENERATOR');

export interface IdGenerator {
  next(): string;
}

/**
 * UUID v7: ordenado pelo tempo de criação. Índices B-tree de PK crescem "no fim",
 * em vez de inserções aleatórias espalhadas como no UUID v4.
 */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
