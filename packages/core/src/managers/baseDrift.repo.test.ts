import { describe, expect, it } from 'vitest';
import { checkBaseDrift } from './baseDrift.js';
import { managerFirstPromptOf } from './managerFirstPrompt.js';
import { loadManagerBase } from './managerBase.js';
import { MISSION_NOTE_BODY } from './projectProfileTemplate.js';
import { RELEASED_BASE_SHAS } from './releasedBaseShas.js';

const shippedBase = loadManagerBase();
const DRIFT_RECIPE =
  "base drift: never edit a line of RELEASED_BASE_SHAS. For a changed body, bump `version:` in templates/manager/base.md, write the new sha in templates/manager/base.sha256 and add `<version>: '<sha>'` to releasedBaseShas.ts. For a restated rule, make the mission point to the section of the base.";

describe('the shipped manager base against the repository', () => {
  it('has no drift: its sha is the one released for its version and no mission text of the repository restates its rules', () => {
    const findings = checkBaseDrift({
      base: shippedBase,
      releasedShas: RELEASED_BASE_SHAS,
      missions: [
        { label: 'first prompt of a manager', text: managerFirstPromptOf('') },
        { label: 'mission note skeleton', text: MISSION_NOTE_BODY },
      ],
    });

    expect(findings, DRIFT_RECIPE).toEqual([]);
  });

  it('reports a released version whose body is edited', () => {
    const editedBase = { ...shippedBase, sha: 'sha-of-an-edited-body' };

    const findings = checkBaseDrift({ base: editedBase, releasedShas: RELEASED_BASE_SHAS, missions: [] });

    expect(findings).toEqual([expect.objectContaining({ kind: 'base_edited_without_bump', version: shippedBase.version })]);
  });
});
