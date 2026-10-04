import { BLOCK_SEPARATOR, childrenOf, stringField, type NodeVisitor } from './lexicalNode.js';

const headingVisitor =
  (headingMarkdown: string): NodeVisitor =>
  () =>
    headingMarkdown;

const SECTION_HEADING_BY_BODY_SECTION: Record<string, string> = {
  'mission-profile-expertise': '### Expertise',
  'mission-profile-mission': '### Mission',
};

export const visitMissionProfile = headingVisitor('## Mission profile');
export const visitMissionPulseActions = headingVisitor('## Pulse actions');
export const visitMissionLaws = headingVisitor('## Laws');
export const visitMissionResources = headingVisitor('## Resources');

export const visitMissionBody: NodeVisitor = (node, context) => {
  const section = stringField(node, 'section');
  const sectionHeading = Object.hasOwn(SECTION_HEADING_BY_BODY_SECTION, section) ? SECTION_HEADING_BY_BODY_SECTION[section] : undefined;
  const body = context.renderBlocks(childrenOf(node));
  const parts = [sectionHeading, body].filter((part): part is string => part !== undefined && part !== '');
  return parts.join(BLOCK_SEPARATOR);
};
