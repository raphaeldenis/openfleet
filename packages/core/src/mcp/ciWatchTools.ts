import { MANAGER_ROLE, OpenFleetError, type Session } from '@openfleet/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { pullRequestUrlOf } from '../github/pullRequestRef.js';
import type { CiWatchService } from '../managers/ciWatchService.js';
import type { ManagerService } from '../managers/managerService.js';
import type { WatchedPr } from '../managers/watchedPrRepository.js';
import { ok } from './toolResults.js';

/** A watched pull request as a manager reads it: its address, and the typed error of the last failed poll when there is one. */
export const watchedPrView = (watched: WatchedPr) => ({
  repo: watched.repo,
  number: watched.number,
  url: pullRequestUrlOf(watched),
  ...(watched.lastNotifiedSha && { last_notified_sha: watched.lastNotifiedSha }),
  ...(watched.lastErrorCode && { last_error: { code: watched.lastErrorCode, at: watched.lastErrorAt } }),
});

export interface CiWatchToolDeps {
  ciWatch: CiWatchService;
  managers: Pick<ManagerService, 'get'>;
  caller: Session;
}

const pullRequestInput = {
  repo: z.string().describe('The GitHub repository as owner/name, e.g. acme/widgets'),
  number: z.number().describe('The pull request number'),
};

export function registerCiWatchTools(server: McpServer, { ciWatch, managers, caller }: CiWatchToolDeps): void {
  const requireManagerCaller = (): void => {
    const isManager = caller.role === MANAGER_ROLE && managers.get(caller.id) !== undefined;
    if (!isManager) throw new OpenFleetError('not_a_manager', 'pull request watching is for managers.', { hint: 'only a manager asks to be told when the CI of a pull request finishes.' });
  };

  server.registerTool('watch_pr', {
    description: 'Ask to be told when the CI of a pull request finishes. The daemon polls the checks with the GitHub CLI and sends you one scheduled event per head sha, "ci.finished status=<success|failure|skipped> pr=<url> sha=<sha>", delivered late rather than lost. Watching stops by itself when the pull request is merged or closed. At most 5 pull requests at a time.',
    inputSchema: pullRequestInput,
  }, async ({ repo, number }) => {
    requireManagerCaller();
    const watched = ciWatch.watch({ managerId: caller.id, repo, number });
    const { repo: watchedRepo, number: watchedNumber, url } = watchedPrView(watched);
    return ok({ repo: watchedRepo, number: watchedNumber, url });
  });

  server.registerTool('unwatch_pr', { description: 'Stop being told about the CI of a pull request', inputSchema: pullRequestInput }, async ({ repo, number }) => {
    requireManagerCaller();
    return ok({ unwatched: ciWatch.unwatch({ managerId: caller.id, repo, number }) });
  });

  server.registerTool('list_watched_prs', { description: 'The pull requests whose CI you are watching, with the typed error of the last failed poll (for example gh_not_authenticated)', inputSchema: {} }, async () => {
    requireManagerCaller();
    return ok({ pull_requests: ciWatch.activeOf(caller.id).map(watchedPrView) });
  });
}
