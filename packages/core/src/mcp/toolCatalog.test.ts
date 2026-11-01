import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';
import { TOOL_CATALOG, TOOL_CATEGORIES } from './toolCatalog.js';

let fixture: GovernanceFixture;
beforeEach(async () => { fixture = await startGovernanceFixture(); });
afterEach(async () => { await fixture.close(); });

const registeredToolNames = async (): Promise<string[]> => {
  const client = await fixture.connect(fixture.lead.id);
  return (await client.listTools()).tools.map((tool) => tool.name).sort();
};

describe('the tool catalog', () => {
  it('has an entry for every tool a manager sees, so a new tool cannot ship without a category', async () => {
    const registered = await registeredToolNames();

    const withoutEntry = registered.filter((name) => !(name in TOOL_CATALOG));

    expect(withoutEntry).toEqual([]);
  });

  it('has no entry for a tool that is not registered, so a removed tool leaves the catalog', async () => {
    const registered = new Set(await registeredToolNames());

    const staleEntries = Object.keys(TOOL_CATALOG).filter((name) => !registered.has(name));

    expect(staleEntries).toEqual([]);
  });

  it('gives each entry one of the known categories and a domain', () => {
    const entries = Object.entries(TOOL_CATALOG);

    const malformed = entries.filter(([, entry]) => !TOOL_CATEGORIES.includes(entry.category) || entry.domain.length === 0);

    expect(malformed).toEqual([]);
  });

  it('classifies tools that only read as read_only and tools that remove state as destructive', () => {
    expect(TOOL_CATALOG['list_notes']?.category).toBe('read_only');
    expect(TOOL_CATALOG['query_data_store']?.category).toBe('read_only');
    expect(TOOL_CATALOG['create_note']?.category).toBe('additive');
    expect(TOOL_CATALOG['delete_note']?.category).toBe('destructive');
    expect(TOOL_CATALOG['create_session']?.category).toBe('execution_external');
  });
});
