import type { Type } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { AttentionCardComponent } from '../inbox/attention-card.component';
import { EscalationCardsComponent } from '../inbox/escalation-cards.component';
import { GovernanceProposalsComponent } from '../inbox/governance-proposals.component';
import { InboxComponent } from '../inbox/inbox.component';
import { ManagerFieldsComponent } from '../managers/manager-fields.component';
import { ManagerGovernanceComponent } from '../managers/manager-governance.component';
import { ManagerLawsComponent } from '../managers/manager-laws.component';
import { MarkdownTableComponent } from '../notes/markdown-table.component';
import { NoteConflictBannerComponent } from '../notes/note-conflict-banner.component';
import { NoteEditorComponent } from '../notes/note-editor.component';
import { NoteHistoryComponent } from '../notes/note-history.component';
import { NoteListComponent } from '../notes/note-list.component';
import { NotesViewComponent } from '../notes/notes-view.component';
import { DaemonStepComponent } from '../onboarding/daemon-step.component';
import { OnboardingComponent } from '../onboarding/onboarding.component';
import { ProjectHomeComponent } from '../projects/project-home.component';
import { ProjectWorktreesComponent } from '../projects/project-worktrees.component';
import { ChoiceCardsComponent } from '../sessions/choice-cards.component';
import { HandoffPickerComponent } from '../sessions/handoff-picker.component';
import { ManagerGroupComponent } from '../sessions/manager-group.component';
import { ModelSelectorComponent } from '../sessions/model-selector.component';
import { PermissionModePickerComponent } from '../sessions/permission-mode-picker.component';
import { RightPanelSessionToggleComponent } from '../sessions/right-panel-session-toggle.component';
import { CommandPolicySettingsComponent } from '../settings/command-policy-settings.component';
import { ModelsSettingsComponent } from '../settings/models-settings.component';
import { ManagerChildrenComponent } from '../shell/todos/manager-children.component';
import { RightPanelComponent } from '../shell/right-panel.component';
import { SidebarFooterComponent } from '../shell/sidebar-footer.component';
import { SidebarGroupComponent } from '../shell/sidebar-group.component';
import { TodosTabComponent } from '../shell/todos/todos-tab.component';
import { TableCellEditorComponent } from '../tables/table-cell-editor.component';
import { TableCellComponent } from '../tables/table-cell.component';
import { TableGridComponent } from '../tables/table-grid.component';
import { TableKanbanComponent } from '../tables/table-kanban.component';
import { TableListComponent } from '../tables/table-list.component';
import { PopoverComponent } from './popover.component';
import { ThemeToggleButtonComponent } from './theme-toggle-button.component';
import { NewSessionFormComponent } from '../sessions/new-session-form.component';
import { PermissionModeListComponent } from '../sessions/permission-mode-list.component';
import { SessionListComponent } from '../sessions/session-list.component';
import { SettingsRowComponent } from '../settings/settings-row.component';
import { SettingsComponent } from '../settings/settings.component';

const RING_AND_SHADOW_DECLARATION = /(?:outline(?:-offset)?|box-shadow)\s*:[^;}]*/g;
const PIXEL_VALUE_BEYOND_HAIRLINE = /(?<![\d.])(?:[2-9]|\d{2,})(?:\.\d+)?px/;

function stylesShippedBy(component: Type<unknown>): string {
  const { styles } = (component as unknown as { ɵcmp: { styles: string[] } }).ɵcmp;
  return styles.join('\n');
}

const ACTIVE_ROW_ACCENT_BAR = /^box-shadow:\s*inset 2px 0 0 var\(--[^)]*accent\)$/;

function pixelDeclarationsBeyondHairline(stylesheet: string): string[] {
  const declarations = stylesheet.match(RING_AND_SHADOW_DECLARATION) ?? [];
  const isActiveRowAccentBar = (declaration: string) => ACTIVE_ROW_ACCENT_BAR.test(declaration.trim());
  return declarations.filter((declaration) => PIXEL_VALUE_BEYOND_HAIRLINE.test(declaration) && !isActiveRowAccentBar(declaration));
}

function ringAndShadowDeclarationsInPixels(component: Type<unknown>): string[] {
  return pixelDeclarationsBeyondHairline(stylesShippedBy(component));
}

describe('focus rings and shadows follow the root font size', () => {
  it.each([
    ['the settings tabs', SettingsComponent],
    ['the session list', SessionListComponent],
    ['the new session form', NewSessionFormComponent],
    ['the permission mode list', PermissionModeListComponent],
    ['the onboarding', OnboardingComponent],
    ['the inbox filter chips', InboxComponent],
    ['the settings value buttons', SettingsRowComponent],
  ])('%s sizes its rings and shadows in rem', (_name, component) => {
    expect(ringAndShadowDeclarationsInPixels(component)).toEqual([]);
  });
});

const designAndSettingsComponents: [string, Type<unknown>][] = [
  ['the popover', PopoverComponent],
  ['the theme toggle', ThemeToggleButtonComponent],
  ['the models settings', ModelsSettingsComponent],
  ['the command policy settings', CommandPolicySettingsComponent],
];

const shellComponents: [string, Type<unknown>][] = [
  ['the right panel', RightPanelComponent],
  ['the todos tab', TodosTabComponent],
  ['the manager children', ManagerChildrenComponent],
  ['the sidebar group', SidebarGroupComponent],
  ['the sidebar footer', SidebarFooterComponent],
];

const notesComponents: [string, Type<unknown>][] = [
  ['the markdown table', MarkdownTableComponent],
  ['the note history', NoteHistoryComponent],
  ['the note conflict banner', NoteConflictBannerComponent],
  ['the note list', NoteListComponent],
  ['the notes view', NotesViewComponent],
  ['the note editor', NoteEditorComponent],
];

const projectsComponents: [string, Type<unknown>][] = [
  ['the project home', ProjectHomeComponent],
  ['the project worktrees', ProjectWorktreesComponent],
];

const managersComponents: [string, Type<unknown>][] = [
  ['the manager governance', ManagerGovernanceComponent],
  ['the manager fields', ManagerFieldsComponent],
  ['the manager laws', ManagerLawsComponent],
];

const tablesComponents: [string, Type<unknown>][] = [
  ['the table cell editor', TableCellEditorComponent],
  ['the table kanban', TableKanbanComponent],
  ['the table list', TableListComponent],
  ['the table cell', TableCellComponent],
  ['the table grid', TableGridComponent],
];

const inboxComponents: [string, Type<unknown>][] = [
  ['the escalation cards', EscalationCardsComponent],
  ['the governance proposals', GovernanceProposalsComponent],
  ['the attention card', AttentionCardComponent],
];

const sessionsAndOnboardingComponents: [string, Type<unknown>][] = [
  ['the manager group', ManagerGroupComponent],
  ['the handoff picker', HandoffPickerComponent],
  ['the choice cards', ChoiceCardsComponent],
  ['the right panel session toggle', RightPanelSessionToggleComponent],
  ['the permission mode picker', PermissionModePickerComponent],
  ['the model selector', ModelSelectorComponent],
  ['the daemon step', DaemonStepComponent],
];

describe.each([
  ['design and settings', designAndSettingsComponents],
  ['shell', shellComponents],
  ['notes', notesComponents],
  ['projects', projectsComponents],
  ['managers', managersComponents],
  ['tables', tablesComponents],
  ['inbox', inboxComponents],
  ['sessions and onboarding', sessionsAndOnboardingComponents],
])('focus rings and shadows of the %s components follow the root font size', (_folder, components) => {
  it.each(components)('%s sizes its rings and shadows in rem', (_name, component) => {
    expect(ringAndShadowDeclarationsInPixels(component)).toEqual([]);
  });
});
