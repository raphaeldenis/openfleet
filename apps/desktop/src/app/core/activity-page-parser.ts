import { ActivityPageSchema, type ActivityPage } from '@openfleet/shared';

/** Reads the daemon's answer to GET /api/activity; null when the body or any row is unreadable, so a bad answer never shows as a shorter log. */
export function parseActivityPage(body: unknown): ActivityPage | null {
  const parsed = ActivityPageSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
