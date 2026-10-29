/** The version of the MCP tool contract: raised by one on every added tool or changed tool shape (see docs/mcp-contract.md). */
export const CONTRACT_VERSION = 13;

/** The sentence the MCP server announces at initialization; clients read the version from it. */
export const CONTRACT_VERSION_INSTRUCTIONS_PREFIX = 'openfleet MCP contract_version: ';

export const contractVersionInstructions = (version: number = CONTRACT_VERSION): string => `${CONTRACT_VERSION_INSTRUCTIONS_PREFIX}${version}`;
