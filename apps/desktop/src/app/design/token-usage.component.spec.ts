import { inputBinding } from '@angular/core';
import { render, screen } from '@testing-library/angular/zoneless';
import { describe, expect, it } from 'vitest';
import type { TokenUsageLoad } from '../core/session-usage.service';
import { TokenUsageComponent } from './token-usage.component';

async function renderUsage(usage: TokenUsageLoad) {
  await render(TokenUsageComponent, { bindings: [inputBinding('usage', () => usage)] });
  return screen.getByTestId('token-usage');
}

describe('TokenUsageComponent', () => {
  it('reads the input and output tokens in compact form', async () => {
    const element = await renderUsage({ inputTokens: 12_345, outputTokens: 4_100 });

    expect(element).toHaveTextContent('12.3k in / 4.1k out');
  });

  it('gives the exact counts to assistive technology, not only the compact text', async () => {
    const element = await renderUsage({ inputTokens: 12_345, outputTokens: 4_100 });

    expect(element).toHaveAccessibleName('12,345 input tokens, 4,100 output tokens');
  });

  it('reads a real zero as zero', async () => {
    const element = await renderUsage({ inputTokens: 0, outputTokens: 0 });

    expect(element).toHaveTextContent('0 in / 0 out');
  });

  it('keeps small counts exact', async () => {
    const element = await renderUsage({ inputTokens: 999, outputTokens: 1 });

    expect(element).toHaveTextContent('999 in / 1 out');
  });

  it('drops a trailing .0 from a round count', async () => {
    const element = await renderUsage({ inputTokens: 2_000, outputTokens: 1_000_000 });

    expect(element).toHaveTextContent('2k in / 1M out');
  });

  it('moves to the next unit instead of showing 1000k', async () => {
    const element = await renderUsage({ inputTokens: 999_960, outputTokens: 999_940 });

    expect(element).toHaveTextContent('1M in / 999.9k out');
  });

  it('abbreviates a very large count in billions', async () => {
    const element = await renderUsage({ inputTokens: 2_345_000_000, outputTokens: 12_000_000 });

    expect(element).toHaveTextContent('2.3B in / 12M out');
  });

  it('reads no data as n/a, never as zero', async () => {
    const element = await renderUsage(null);

    expect(element).toHaveTextContent('n/a');
    expect(element).toHaveAccessibleName('Token usage not available');
  });

  it('tells a failed request from an absence of data', async () => {
    const element = await renderUsage('unavailable');

    expect(element).toHaveTextContent('error');
    expect(element).toHaveAccessibleName('Token usage unavailable: the request failed');
    expect(element).not.toHaveTextContent('n/a');
  });

  it('says it is loading before the first answer', async () => {
    const element = await renderUsage(undefined);

    expect(element).toHaveAccessibleName('Token usage loading');
    expect(element).not.toHaveTextContent('n/a');
  });
});
