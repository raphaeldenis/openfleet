export const HUMAN_QA_PHRASES = /(QA|tests?|testing)\b.{0,40}\b(is|are)\b.{0,20}\bhuman|travail de l'humain|human'?s job/i;
// A section id such as "§5 Children" is not a count.
export const CHILDREN_COUNT_PHRASES = [/(?<!§)\b\d+\s+(children|enfants)\b/i, /cap\s*(of|=|:)\s*\d/i];
export const EXACT_MODEL_ID = /claude-(opus|sonnet|haiku|fable)-/;
export const BACKTICKED_TOOL_NAME = /`([a-z]+(?:_[a-z]+)+)`/g;
