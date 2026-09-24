import { randomBytes, randomUUID } from 'node:crypto';
export const newId = (): string => randomUUID();
export const newToken = (): string => randomBytes(32).toString('base64url');
