/** What the e2e bootstrap puts in the throwaway home before the daemon starts, and what the real-daemon specs look for. */
export const SEEDED_PROJECT = { id: 'e2e-seed-project', name: 'Seeded project' } as const;
export const SEEDED_STORE = { id: 'e2e-seed-store', displayName: 'Seeded notes' } as const;
export const SEEDED_COLUMN = { id: 'e2e-seed-details', displayName: 'Details' } as const;
export const SEEDED_ROW = { id: 'e2e-seed-row', details: 'Seeded details' } as const;
