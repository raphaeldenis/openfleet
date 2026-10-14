import {
  ACCESSES_BY_RESOURCE_TYPE, GRANTABLE_RESOURCE_TYPES, MAX_DENIAL_REASON_CHARS, MAX_INCIDENT_CHARS, MAX_LAW_TEXT_CHARS, MAX_PERMISSION_FIELD_CHARS, MAX_ROLE_CHARS,
  OpenFleetError, RESOURCE_ACCESSES, RESOURCE_TYPES,
  type LawPayload, type PermissionPayload, type ResourceAccess, type ResourceAccessPayload, type ResourceType,
} from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';
import { visibleTextOf } from './visibleText.js';

const invalidBody = (message: string, hint?: string) => new OpenFleetError('invalid_body', message, { hint });

interface TextField { field: string; value: string; maxChars: number }

/** The visible text; throws invalid_body when nothing visible is left or when it is longer than `maxChars`. */
function requiredText({ field, value, maxChars }: TextField): string {
  const visibleText = visibleTextOf(value);
  if (visibleText.length === 0) throw invalidBody(`${field} must not be blank.`);
  if (visibleText.length > maxChars) throw invalidBody(`${field} must not exceed ${maxChars} characters.`);
  return visibleText;
}

/** Written text is stored visible and with its secrets masked: the human reads what is stored. */
const storedText = (textField: TextField) => maskedSecrets(requiredText(textField));

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T => values.includes(value as T);

export const storedIncident = (incident: string): string => storedText({ field: 'incident', value: incident, maxChars: MAX_INCIDENT_CHARS });

export const storedDenialReason = (reason: string | undefined): string => {
  if (reason === undefined) throw invalidBody('a denial needs a reason.');
  return requiredText({ field: 'reason', value: reason, maxChars: MAX_DENIAL_REASON_CHARS });
};

export const lawPayloadOf = ({ text }: { text: string }): LawPayload => ({ text: storedText({ field: 'body', value: text, maxChars: MAX_LAW_TEXT_CHARS }) });

const storedPermissionField = (field: keyof PermissionPayload, value: string) => storedText({ field, value, maxChars: MAX_PERMISSION_FIELD_CHARS });

export const permissionPayloadOf = (fields: Record<keyof PermissionPayload, string>): PermissionPayload => ({
  action: storedPermissionField('action', fields.action),
  scope: storedPermissionField('scope', fields.scope),
  condition: storedPermissionField('condition', fields.condition),
  exclusions: storedPermissionField('exclusions', fields.exclusions),
});

const GRANTABLE_RESOURCE_TYPE_LIST = GRANTABLE_RESOURCE_TYPES.join(', ');

/** Checks the type, the access and their pairing; the resource id is checked against the project by the caller. */
export function resourceAccessPayloadOf(fields: { resourceType: string; resourceId: string; access: string; role: string }): ResourceAccessPayload {
  if (!isOneOf(RESOURCE_TYPES, fields.resourceType)) throw invalidBody(`resource_type must be one of: ${RESOURCE_TYPES.join(', ')}.`);
  if (!isOneOf(RESOURCE_ACCESSES, fields.access)) throw invalidBody(`access must be one of: ${RESOURCE_ACCESSES.join(', ')}.`);
  const resourceType: ResourceType = fields.resourceType;
  const access: ResourceAccess = fields.access;
  const isGrantable = (GRANTABLE_RESOURCE_TYPES as readonly ResourceType[]).includes(resourceType);
  if (!isGrantable) throw invalidBody(`${resourceType} access is not available in OpenFleet yet.`, `Request access to one of: ${GRANTABLE_RESOURCE_TYPE_LIST}.`);
  const allowedAccesses = ACCESSES_BY_RESOURCE_TYPE[resourceType];
  if (!allowedAccesses.includes(access)) throw invalidBody(`access ${access} does not apply to a ${resourceType}.`, `Use one of: ${allowedAccesses.join(', ')}.`);
  return {
    resourceType,
    resourceId: requiredText({ field: 'resource_id', value: fields.resourceId, maxChars: MAX_PERMISSION_FIELD_CHARS }),
    access,
    role: storedText({ field: 'role', value: fields.role, maxChars: MAX_ROLE_CHARS }),
  };
}
