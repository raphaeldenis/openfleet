import { copyFor } from '../core/error-copy';

export type Load<T> = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'loaded'; value: T };

export const LOADING: Load<never> = { status: 'loading' };

export const failedLoadOf = (error: unknown): Load<never> => ({ status: 'failed', message: copyFor(error, { action: 'generic' }).text });

export const loadedValueOf = <T>(load: Load<T>): T | undefined => (load.status === 'loaded' ? load.value : undefined);
