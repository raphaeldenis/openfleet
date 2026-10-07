import { realpathSync, statSync } from 'node:fs';
import { OpenFleetError } from '@openfleet/shared';
import { isAbsolute, resolve } from 'node:path';
import { run, WorktreeError } from '../git/worktrees.js';
import type { KnowledgeRepositoryLookupPort, RepositoryScopePort } from './knowledgeSearchPort.js';
import type { KnowledgeRepositoryScope } from './knowledgeTypes.js';

const unavailableRepository = () => new OpenFleetError('project_not_found', 'knowledge repository is not available in this project');

export class KnowledgeRepoScope implements RepositoryScopePort {
  constructor(private readonly ports: { repositories: KnowledgeRepositoryLookupPort }) {}

  async resolve({ projectId, repo }: { projectId: string; repo: string }): Promise<KnowledgeRepositoryScope> {
    if (!isAbsolute(repo)) {
      const registration = this.ports.repositories.findRepository({ projectId, repoKey: repo });
      if (registration === undefined) throw unavailableRepository();
      return registration;
    }
    const gitCommonDir = await this.canonicalCommonDirectory(repo);
    const registration = this.ports.repositories.findRepository({ projectId, gitCommonDir });
    if (registration === undefined) throw unavailableRepository();
    return registration;
  }

  private async canonicalCommonDirectory(path: string): Promise<string> {
    try {
      const canonicalPath = realpathSync.native(path);
      if (!statSync(canonicalPath).isDirectory()) throw unavailableRepository();
      const { stdout } = await run(['rev-parse', '--git-common-dir'], { cwd: canonicalPath, timeoutMs: 5000, maxBufferBytes: 8192 });
      return realpathSync.native(resolve(canonicalPath, stdout.trim()));
    } catch (error) {
      if (error instanceof WorktreeError && error.code === 'git_unavailable') throw new OpenFleetError('git_unavailable', 'git is not available to the daemon.');
      throw unavailableRepository();
    }
  }
}
