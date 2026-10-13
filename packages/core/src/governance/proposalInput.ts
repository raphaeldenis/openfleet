import {
  ACCESSES_BY_RESOURCE_TYPE, GRANTABLE_RESOURCE_TYPES, MAX_DENIAL_REASON_CHARS, MAX_INCIDENT_CHARS, MAX_LAW_TEXT_CHARS, MAX_PERMISSION_FIELD_CHARS, MAX_ROLE_CHARS,
  OpenFleetError, RESOURCE_ACCESSES, RESOURCE_TYPES,
  type LawPayload, type PermissionPayload, type ResourceAccess, type ResourceAccessPayload, type ResourceType,
} from '@openfleet/shared';
import { maskedSecrets } from '../redact.js';

const invalidBody = (message: string, hint?: string) => new OpenFleetError('invalid_body', message, { hint });

/** The text trimmed; throws invalid_body when it is blank or longer than `maxChars`. */
function requiredText({ field, value, maxChars }: { field: string; value: string; maxChars: number }): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalidBody(`${field} must not be blank.`);
  if (trimmed.length > maxChars) throw invalidBody(`${field} must not exceed ${maxChars} characters.`);
  return trimmed;
}

/** Written text is stored with its secrets masked: the human reads what is stored. */
const storedText = (field: string, value: string, maxChars: number) => maskedSecrets(requiredText({ field, value, maxChars }));

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T => values.includes(value as T);

export const storedIncident = (incident: string): string => storedText('incident', incident, MAX_INCIDENT_CHARS);

export const storedDenialReason = (reason: string | undefined): string => {
  if (reason === undefined) throw invalidBody('a denial needs a reason.');
  return requiredText({ field: 'reason', value: reason, maxChars: MAX_DENIAL_REASON_CHARS });
};

export const lawPayloadOf = ({ text }: { text: string }): LawPayload => ({ text: storedText('body', text, MAX_LAW_TEXT_CHARS) });

export const permissionPayloadOf = (fields: Record<keyof PermissionPayload, string>): PermissionPayload => ({
  action: storedText('action', fields.action, MAX_PERMISSION_FIELD_CHARS),
  scope: storedText('scope', fields.scope, MAX_PERMISSION_FIELD_CHARS),
  condition: storedText('condition', fields.condition, MAX_PERMISSION_FIELD_CHARS),
  exclusions: storedText('exclusions', fields.exclusions, MAX_PERMISSION_FIELD_CHARS),
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
    role: storedText('role', fields.role, MAX_ROLE_CHARS),
  };
}
