export interface NavItem {
  readonly key: string;
  readonly glyph: string;
  readonly label: string;
  readonly route: string | null;
  readonly availability: string | null;
}

export interface HelmNavContext {
  readonly currentManagerId: string | null;
}

const COMING_SOON = 'Coming soon';
const SELECT_A_MANAGER = 'Select a manager';

// Order and labels mirror the Helm section of specs/design/OpenFleet.dc.html's `navDef` array.
// Settings is deliberately absent: it opens from the sidebar footer gear and ⌘,.
// A null route renders the section disabled, with its availability text.
const helmSectionsFor = ({ currentManagerId }: HelmNavContext): ReadonlyArray<{ key: string; glyph: string; label: string; route: string | null; unroutedAvailability?: string }> => [
  { key: 'inbox', glyph: '◫', label: 'Inbox', route: '/inbox' },
  { key: 'project', glyph: '⌂', label: 'Project home', route: '/project' },
  { key: 'toolkit', glyph: '⚒', label: 'Toolkit', route: null },
  { key: 'audit', glyph: '≣', label: 'Audit', route: '/audit' },
  {
    key: 'mgrprofile',
    glyph: '◎',
    label: 'Manager profile',
    route: currentManagerId ? `/manager/${encodeURIComponent(currentManagerId)}` : null,
    unroutedAvailability: SELECT_A_MANAGER,
  },
  { key: 'profiles', glyph: '◉', label: 'Profiles', route: null },
  { key: 'calendar', glyph: '▤', label: 'Calendar', route: null },
  { key: 'notes', glyph: '¶', label: 'Notes', route: '/notes' },
  { key: 'tables', glyph: '▦', label: 'Tables', route: '/tables' },
  { key: 'triggers', glyph: '⚡', label: 'Triggers & Playbooks', route: null },
  { key: 'integrations', glyph: '⇄', label: 'Integrations', route: null },
  { key: 'usage', glyph: '$', label: 'Usage', route: '/usage' },
  { key: 'components', glyph: '◈', label: 'Component sheet', route: '/components' },
];

/** The Helm sections; Manager profile links to the current manager and stays disabled without one. */
export function helmNavItemsFor(context: HelmNavContext): readonly NavItem[] {
  return helmSectionsFor(context).map(({ unroutedAvailability, ...section }) => ({
    ...section,
    availability: section.route ? null : (unroutedAvailability ?? COMING_SOON),
  }));
}

export const HELM_NAV_ITEMS: readonly NavItem[] = helmNavItemsFor({ currentManagerId: null });
