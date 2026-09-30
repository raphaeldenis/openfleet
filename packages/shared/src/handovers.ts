export const HANDOVER_KINDS = ['design_link', 'doc_path'] as const;
export type HandoverKind = (typeof HANDOVER_KINDS)[number];

export interface Handover { id: string; sessionId: string; kind: HandoverKind; value: string; createdAt: string }
