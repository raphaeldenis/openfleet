import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { startDaemon, type Daemon } from '../daemon.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { UsageLedgerService } from '../usage/usageLedgerService.js';

const tempDirs = createTempDirTracker();
let daemon: Daemon;
let config: Config;

const assistantLine = (id: string, timestamp: string, model: string) =>
  JSON.stringify({ type: 'assistant', timestamp, message: { id, model, usage: { input_tokens: 1, output_tokens: 2 } } });

beforeAll(async () => {
  config = loadConfig({ OPENFLEET_HOME: tempDirs.make('of-usage-route-'), OPENFLEET_PORT: '0' });
  daemon = await startDaemon(config);
  const transcriptText = [assistantLine('m1', '2026-10-01T10:00:00.000Z', 'model-a'), assistantLine('m2', '2026-10-02T10:00:00.000Z', 'model-b')].join('\n');
  new UsageLedgerService(daemon.db).ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText, billingCodeOf: () => 'root', timestampWindow: { earliestMs: 0, latestMs: Number.MAX_SAFE_INTEGER } });
});
afterAll(async () => {
  await daemon.close();
  tempDirs.removeAll();
});

const getDaily = (query = '', headers: Record<string, string> = { authorization: `Bearer ${config.adminToken}` }) =>
  fetch(`${daemon.server.url}/api/usage/daily${query}`, { headers });

describe('GET /api/usage/daily on a booted daemon', () => {
  it('answers the daily buckets as items', async () => {
    const response = await getDaily();
    const body = (await response.json()) as { items: { dayUtc: string; model: string; costStatus: string; costUsd: number | null }[] };

    expect(response.status).toBe(200);
    expect(body.items.map((item) => [item.dayUtc, item.model, item.costStatus, item.costUsd])).toEqual([
      ['2026-10-01', 'model-a', 'unpriced', null],
      ['2026-10-02', 'model-b', 'unpriced', null],
    ]);
  });

  it('filters by model and day range', async () => {
    const body = (await (await getDaily('?model=model-b&from=2026-10-02&to=2026-10-02')).json()) as { items: unknown[] };

    expect(body.items).toHaveLength(1);
  });

  it('refuses a malformed day with a client error', async () => {
    expect((await getDaily('?from=yesterday')).status).toBe(400);
  });

  it('refuses a request without the admin token', async () => {
    expect((await getDaily('', {})).status).toBe(401);
  });
});
