import { describe, expect, it, vi } from 'vitest';
import { parseMarkdownBlocks } from '../apps/desktop/src/app/notes/markdown-blocks.js';
import { planPlaybookArchive } from '../packages/core/src/import/scape/playbookArchive.js';
import { expandMentionBlocks, type MentionLookup } from '../packages/core/src/notes/mentionExpander.js';

const ARCHIVED_MENTION = '@note:synthetic-target';
const TEMPLATE_HEADINGS = ['Playbooks (ex-Scape)', 'Secrets — to set as environment variables'];

const hostileDescription = [
  'Intro line',
  '```bash',
  'printf SYNTHETIC',
  '```',
  '# heading',
  '- bullet',
  '* star bullet',
  '1. numbered',
  '> quote',
  '| a | b |',
  '|---|---|',
  `see ${ARCHIVED_MENTION}`,
].join('\n');

function archiveBodyOfHostilePlaybook(): string {
  const lexicalContent = JSON.stringify({ root: { type: 'root', children: [
    { type: 'paragraph', children: [{ type: 'text', text: hostileDescription }] },
    { type: 'playbook-step', kind: 'shell', label: `label ${ARCHIVED_MENTION}`, args: { command: `echo ${ARCHIVED_MENTION}` } },
  ] } });
  const playbook = { id: 'pb', name: `name ${ARCHIVED_MENTION}`, lexicalContent, secrets: '[]', createdAt: 811089628, updatedAt: 811089628 };
  const archive = planPlaybookArchive({ project: { id: 'p1', name: 'Synthetic', createdAt: 0 }, playbooks: [playbook], secretNames: [] });
  return String(archive!.record.body_md);
}

describe('archived playbook text stays inert', () => {
  it('expands no mention through the real mention expander', () => {
    const lookup: MentionLookup = {
      getNote: vi.fn(() => ({ id: 'synthetic-target', title: 'Target', bodyMd: 'TARGET BODY', projectId: 'p1' })),
      describeOther: vi.fn(),
    };

    const blocks = expandMentionBlocks(archiveBodyOfHostilePlaybook(), lookup);

    expect(blocks).toEqual([]);
    expect(lookup.getNote).not.toHaveBeenCalled();
  });

  it('produces no code, list or quote block and only the template headings through the real parser', () => {
    const blocks = parseMarkdownBlocks(archiveBodyOfHostilePlaybook());

    const activeBlockTypes = blocks.map((block) => block.type).filter((type) => type !== 'paragraph' && type !== 'heading');
    const headingTexts = blocks.flatMap((block) => (block.type === 'heading' ? [block.segments.map((segment) => segment.text).join('')] : []));
    expect(activeBlockTypes).toEqual([]);
    expect(headingTexts).toEqual(TEMPLATE_HEADINGS);
  });

  it('keeps the conversion marker and the readable source text', () => {
    const body = archiveBodyOfHostilePlaybook();

    expect(body).toContain('[non converti: playbook]');
    expect(body).toContain('printf SYNTHETIC');
    expect(body).toContain('bullet');
  });
});
