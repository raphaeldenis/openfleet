import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTRACT_VERSION, contractVersionInstructions } from '@openfleet/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGovernanceFixture, type GovernanceFixture } from '../governance/governanceQueue.testkit.js';

type PinnedTool = { name: string; inputSchemaHash: string };
type PinnedContract = { contractVersion: number; tools: PinnedTool[] };

const PINNED_CONTRACT_FILE = new URL('./contract.pinned.json', import.meta.url);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const isObject = typeof value === 'object' && value !== null;
  if (!isObject) return JSON.stringify(value);
  const sortedEntries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${sortedEntries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
};

const hashOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);

const byName = (a: PinnedTool, b: PinnedTool) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const currentContractOf = (tools: { name: string; inputSchema: unknown }[]): PinnedContract => ({
  contractVersion: CONTRACT_VERSION,
  tools: tools.map((tool) => ({ name: tool.name, inputSchemaHash: hashOf(tool.inputSchema) })).sort(byName),
});

const describeDifference = (pinned: PinnedContract, current: PinnedContract): string => {
  const pinnedHashByName = new Map(pinned.tools.map((tool) => [tool.name, tool.inputSchemaHash]));
  const currentHashByName = new Map(current.tools.map((tool) => [tool.name, tool.inputSchemaHash]));
  const added = [...currentHashByName.keys()].filter((name) => !pinnedHashByName.has(name));
  const removed = [...pinnedHashByName.keys()].filter((name) => !currentHashByName.has(name));
  const reshaped = [...currentHashByName].filter(([name, hash]) => pinnedHashByName.has(name) && pinnedHashByName.get(name) !== hash).map(([name]) => name);
  return `added: [${added.join(', ')}]; removed: [${removed.join(', ')}]; input schema changed: [${reshaped.join(', ')}]`;
};

const HOW_TO_FIX = [
  'The MCP tool contract changed. To accept it:',
  '1. raise CONTRACT_VERSION in packages/shared/src/mcpContract.ts by one,',
  '2. replace packages/core/src/mcp/contract.pinned.json with the contract printed below (same contractVersion),',
  '3. add a section for the new version to CHANGELOG.md.',
].join('\n');

let fixture: GovernanceFixture;
beforeEach(async () => { fixture = await startGovernanceFixture(); });
afterEach(async () => { await fixture.close(); });

describe('MCP contract version', () => {
  it('is announced to a client at initialization', async () => {
    const client = await fixture.connect(fixture.lead.id);

    expect(client.getInstructions()).toBe(contractVersionInstructions(CONTRACT_VERSION));
  });

  it('is reported by get_argus_status', async () => {
    const client = await fixture.connect(fixture.lead.id);

    const status = JSON.parse(((await client.callTool({ name: 'get_argus_status', arguments: {} })).content as { text: string }[])[0]!.text);

    expect(status.contract_version).toBe(CONTRACT_VERSION);
  });
});

describe('MCP contract guard', () => {
  it('fails when the tool names or input schemas differ from the pinned contract, unless CONTRACT_VERSION is raised with the pin', async () => {
    const client = await fixture.connect(fixture.lead.id);
    const pinned: PinnedContract = JSON.parse(readFileSync(PINNED_CONTRACT_FILE, 'utf8'));

    const current = currentContractOf((await client.listTools()).tools);

    const isPinnedForThisVersion = pinned.contractVersion === CONTRACT_VERSION;
    const sameContract = canonicalJson(pinned.tools) === canonicalJson(current.tools);
    const diagnosis = isPinnedForThisVersion
      ? `Pinned contract is version ${pinned.contractVersion}; ${describeDifference(pinned, current)}.`
      : `CONTRACT_VERSION is ${CONTRACT_VERSION} but the pinned file is version ${pinned.contractVersion}.`;
    const message = `${diagnosis}\n${HOW_TO_FIX}\n${JSON.stringify(current, null, 2)}`;

    expect(isPinnedForThisVersion && sameContract, message).toBe(true);
  });
});
