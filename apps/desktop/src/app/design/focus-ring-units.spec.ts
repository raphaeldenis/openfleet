import type { Type } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { OnboardingComponent } from '../onboarding/onboarding.component';
import { NewSessionFormComponent } from '../sessions/new-session-form.component';
import { PermissionModeListComponent } from '../sessions/permission-mode-list.component';
import { SessionListComponent } from '../sessions/session-list.component';
import { SettingsComponent } from '../settings/settings.component';

const RING_AND_SHADOW_DECLARATION = /(?:outline(?:-offset)?|box-shadow)\s*:[^;}]*/g;
const PIXEL_VALUE_BEYOND_HAIRLINE = /(?<![\d.])(?:[2-9]|\d{2,})(?:\.\d+)?px/;

function stylesShippedBy(component: Type<unknown>): string {
  const { styles } = (component as unknown as { ɵcmp: { styles: string[] } }).ɵcmp;
  return styles.join('\n');
}

function ringAndShadowDeclarationsInPixels(component: Type<unknown>): string[] {
  const declarations = stylesShippedBy(component).match(RING_AND_SHADOW_DECLARATION) ?? [];
  return declarations.filter((declaration) => PIXEL_VALUE_BEYOND_HAIRLINE.test(declaration));
}

describe('focus rings and shadows follow the root font size', () => {
  it.each([
    ['the settings tabs', SettingsComponent],
    ['the session list', SessionListComponent],
    ['the new session form', NewSessionFormComponent],
    ['the permission mode list', PermissionModeListComponent],
    ['the onboarding', OnboardingComponent],
  ])('%s sizes its rings and shadows in rem', (_name, component) => {
    expect(ringAndShadowDeclarationsInPixels(component)).toEqual([]);
  });
});
