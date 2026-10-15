export const MANAGER_BASE_PATH = '/api/manager-base';

export interface ManagerBaseSectionView {
  /** The short id a section is addressed by, `§1` to `§10`. */
  id: string;
  title: string;
  bytes: number;
}

/** What `GET /api/manager-base` answers: the identity and the outline of the shipped base, never its text. */
export interface ManagerBaseView {
  version: number;
  /** sha256 hex of the normalized body. */
  sha: string;
  bytes: number;
  sections: ManagerBaseSectionView[];
}
