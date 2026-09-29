export interface NavItem {
  readonly key: string;
  readonly glyph: string;
  readonly label: string;
  readonly route: string | null;
  readonly availability: string | null;
}

// Single source of truth for when a not-yet-built section unlocks (per Capitaine, backlog
// task P3-T02 for Projects) — update this map only.
const AVAILABILITY_BY_SECTION: Readonly<Record<string, string>> = {
  project: 'Available in phase 3',
  toolkit: 'Available in phase 4',
  audit: 'Available in phase 4',
  mgrprofile: 'Available in phase 4',
  profiles: 'Not yet available',
  calendar: 'Available in phase 5',
  notes: 'Available in phase 3',
  triggers: 'Available in phase 5',
  integrations: 'Available in phase 5',
  usage: 'Available in phase 4',
};

// Order and labels mirror the Helm section of specs/design/OpenFleet.dc.html's `navDef` array.
// A null route means the backend this section needs hasn't landed yet — it still renders,
// disabled, with the phase text from AVAILABILITY_BY_SECTION explaining when it will.
const HELM_SECTIONS: ReadonlyArray<{ key: string; glyph: string; label: string; route: string | null }> = [
  { key: 'inbox', glyph: '◫', label: 'Inbox', route: '/inbox' },
  { key: 'project', glyph: '⌂', label: 'Project home', route: null },
  { key: 'toolkit', glyph: '⚒', label: 'Toolkit', route: null },
  { key: 'audit', glyph: '≣', label: 'Audit', route: null },
  { key: 'mgrprofile', glyph: '◎', label: 'Manager profile', route: null },
  { key: 'profiles', glyph: '◉', label: 'Profiles', route: null },
  { key: 'calendar', glyph: '▤', label: 'Calendar', route: null },
  { key: 'notes', glyph: '¶', label: 'Notes', route: null },
  { key: 'tables', glyph: '▦', label: 'Tables', route: '/tables' },
  { key: 'triggers', glyph: '⚡', label: 'Triggers & Playbooks', route: null },
  { key: 'integrations', glyph: '⇄', label: 'Integrations', route: null },
  { key: 'usage', glyph: '$', label: 'Usage', route: null },
  { key: 'settings', glyph: '⚙', label: 'Settings', route: '/settings' },
  { key: 'components', glyph: '◈', label: 'Component sheet', route: '/components' },
];

export const HELM_NAV_ITEMS: readonly NavItem[] = HELM_SECTIONS.map((section) => ({
  ...section,
  availability: section.route ? null : (AVAILABILITY_BY_SECTION[section.key] ?? 'Not yet available'),
}));

export interface PalettePage {
  readonly key: string;
  readonly icon: string;
  readonly label: string;
  readonly route: string;
}

// "Pages only ... no fake actions" — every entry here is a route that exists today.
export const PALETTE_PAGES: readonly PalettePage[] = [
  { key: 'sessions', icon: '🗂', label: 'Sessions', route: '/' },
  { key: 'inbox', icon: '◫', label: 'Inbox', route: '/inbox' },
  { key: 'tables', icon: '▦', label: 'Tables', route: '/tables' },
  { key: 'settings', icon: '⚙', label: 'Settings', route: '/settings' },
  { key: 'components', icon: '◈', label: 'Components', route: '/components' },
];
