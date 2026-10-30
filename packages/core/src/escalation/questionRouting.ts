import { ESCALATING_CLASSES, isExecutedClaim, isQuestionClass, type EscalatingClass, type EscalationPolicy, type PlanQuestion, type QuestionClass } from '@openfleet/shared';
import { computeFloorClasses } from './floorClasses.js';

export type QuestionRoute = 'human' | 'self' | 'arbiter';

export interface QuestionRouting {
  /** The class the manager wrote, or unknown when it is outside the vocabulary. */
  declared: QuestionClass | 'unknown';
  /** The escalating classes the code found in the question. */
  computed: EscalatingClass[];
  /** The declared class when escalating, joined with the computed ones: it never loses a computed class. */
  effective: EscalatingClass[];
  /** The effective classes the project took off its human list. */
  disabledByProject: EscalatingClass[];
  route: QuestionRoute;
}

export type RoutingPolicy = Partial<Pick<EscalationPolicy, 'humanClasses' | 'extraRules'>>;

/** Decides who answers a question: a human, the question's own proven resolution, or the arbiter. */
export function routeQuestion(question: PlanQuestion, policy: RoutingPolicy = {}): QuestionRouting {
  const declared = isQuestionClass(question.class) ? question.class : 'unknown';
  const computed = computeFloorClasses(question, policy.extraRules);
  const effective = ESCALATING_CLASSES.filter((escalatingClass) => computed.includes(escalatingClass) || escalatingClass === declared);
  const humanClasses = policy.humanClasses ?? ESCALATING_CLASSES;
  const disabledByProject = effective.filter((escalatingClass) => !humanClasses.includes(escalatingClass));

  const isUnknown = declared === 'unknown';
  const hasClassOnHumanList = effective.length > disabledByProject.length;
  const isFactualAndProvenByARun = declared === 'factual' && question.resolution !== undefined && isExecutedClaim(question.resolution);
  const isEscalatingOnlyThroughDisabledClasses = effective.length > 0 && !hasClassOnHumanList;

  const route = routeOf({ isUnknown, hasClassOnHumanList, isEscalatingOnlyThroughDisabledClasses, isFactualAndProvenByARun });
  return { declared, computed, effective, disabledByProject, route };
}

function routeOf(facts: { isUnknown: boolean; hasClassOnHumanList: boolean; isEscalatingOnlyThroughDisabledClasses: boolean; isFactualAndProvenByARun: boolean }): QuestionRoute {
  if (facts.isUnknown || facts.hasClassOnHumanList) return 'human';
  if (facts.isEscalatingOnlyThroughDisabledClasses) return 'arbiter';
  if (facts.isFactualAndProvenByARun) return 'self';
  return 'arbiter';
}
