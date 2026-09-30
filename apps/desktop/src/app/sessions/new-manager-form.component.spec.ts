import { render, screen, within } from '@testing-library/angular/zoneless';
import userEvent from '@testing-library/user-event';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionFormComponent } from './new-session-form.component';
import { FleetApiService } from '../core/fleet-api.service';

const PULSE_RANGE_ERROR = '✕ Pulse cadence must be between 1 and 86,400 seconds — enter a whole number in that range';
const CAP_RANGE_ERROR = '✕ Children cap must be between 1 and 64 — enter a whole number in that range';

function fakeApi() {
  return { createSession: vi.fn().mockResolvedValue({ id: 's-new' }), createManagerSession: vi.fn().mockResolvedValue({ id: 'm-new' }) };
}

async function renderManagerForm(api = fakeApi()) {
  const { fixture } = await render(NewSessionFormComponent, {
    providers: [
      provideRouter([]),
      { provide: FleetApiService, useValue: api },
      { provide: ActivatedRoute, useValue: { queryParamMap: new BehaviorSubject(convertToParamMap({ mode: 'manager' })) } },
    ],
  });
  vi.spyOn(fixture.debugElement.injector.get(Router), 'navigate').mockResolvedValue(true);
  return api;
}

async function fillEverythingButTheManagerNumbers(): Promise<void> {
  await userEvent.type(screen.getByTestId('new-session-directory'), '/tmp/wt');
  await userEvent.type(screen.getByTestId('new-session-name'), 'Lead');
  await userEvent.type(screen.getByTestId('manager-mission'), 'Ship phase 3');
}

const submitButton = () => screen.getByTestId('new-session-submit');
const pulseField = () => screen.getByTestId('manager-pulse-seconds');
const capField = () => screen.getByTestId('manager-children-cap');
const preset = (name: string) => within(screen.getByRole('group', { name: 'Pulse cadence presets' })).getByRole('button', { name });
const capStepper = (direction: 'Decrease' | 'Increase') => screen.getByRole('button', { name: `${direction} children cap` });

async function setNumber(field: HTMLElement, value: string): Promise<void> {
  await userEvent.clear(field);
  if (value !== '') await userEvent.type(field, value);
}

describe('the New manager form: pulse cadence and children cap', () => {
  describe('pulse cadence', () => {
    it('shows its bounds next to the field', async () => {
      await renderManagerForm();

      expect(pulseField()).toHaveAccessibleDescription(/seconds · 1 – 86,400/);
    });

    it('offers the daemon default and four cadences as presets, the daemon default being the one in force', async () => {
      await renderManagerForm();

      const names = within(screen.getByRole('group', { name: 'Pulse cadence presets' })).getAllByRole('button').map((button) => button.textContent?.trim());
      expect(names).toEqual(['Daemon default', '5 min', '10 min', '30 min', '1 h']);
      expect(preset('Daemon default')).toHaveAttribute('aria-pressed', 'true');
      expect(preset('5 min')).toHaveAttribute('aria-pressed', 'false');
    });

    it.each([
      ['5 min', 300],
      ['10 min', 600],
      ['30 min', 1800],
      ['1 h', 3600],
    ])('choosing %s fills the field with %i seconds and sends them', async (presetName, seconds) => {
      const api = await renderManagerForm();
      await fillEverythingButTheManagerNumbers();

      await userEvent.click(preset(presetName));
      await userEvent.click(submitButton());

      expect(pulseField()).toHaveValue(seconds);
      expect(preset(presetName)).toHaveAttribute('aria-pressed', 'true');
      expect(preset('Daemon default')).toHaveAttribute('aria-pressed', 'false');
      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ pulseSeconds: seconds }));
    });

    it('choosing "Daemon default" after a typed value empties the field and sends no pulse seconds', async () => {
      const api = await renderManagerForm();
      await fillEverythingButTheManagerNumbers();
      await setNumber(pulseField(), '45');

      await userEvent.click(preset('Daemon default'));
      await userEvent.click(submitButton());

      expect(pulseField()).toHaveValue(null);
      expect(preset('Daemon default')).toHaveAttribute('aria-pressed', 'true');
      expect(api.createManagerSession.mock.calls[0]![0]).not.toHaveProperty('pulseSeconds');
    });

    it('choosing "Daemon default" clears an out-of-range pulse error and re-enables Create', async () => {
      await renderManagerForm();
      await setNumber(pulseField(), '0');
      expect(screen.getByTestId('manager-pulse-seconds-error')).toBeTruthy();

      await userEvent.click(preset('Daemon default'));

      expect(screen.queryByTestId('manager-pulse-seconds-error')).toBeNull();
      expect(submitButton()).toBeEnabled();
    });

    it('a custom value matching no preset leaves every preset unpressed', async () => {
      await renderManagerForm();

      await setNumber(pulseField(), '45');

      for (const name of ['Daemon default', '5 min', '10 min', '30 min', '1 h']) expect(preset(name)).toHaveAttribute('aria-pressed', 'false');
    });

    it('a keyboard user tabs to a preset and activates it with Enter and with Space', async () => {
      await renderManagerForm();
      preset('5 min').focus();

      await userEvent.keyboard('{Enter}');
      expect(pulseField()).toHaveValue(300);

      preset('1 h').focus();
      await userEvent.keyboard(' ');
      expect(pulseField()).toHaveValue(3600);
    });

    it.each([
      ['0', 'below the minimum'],
      ['86401', 'above the maximum'],
      ['1.5', 'not a whole number'],
    ])('says what is wrong and what to do when the pulse is %s (%s)', async (typed) => {
      await renderManagerForm();

      await setNumber(pulseField(), typed);

      const alert = screen.getByTestId('manager-pulse-seconds-error');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveTextContent(PULSE_RANGE_ERROR);
      expect(pulseField()).toHaveAttribute('aria-invalid', 'true');
      expect(pulseField()).toHaveAccessibleDescription(new RegExp(`${PULSE_RANGE_ERROR}`));
    });

    it('keeps Create disabled and sends nothing while the pulse is invalid, then enables it once corrected', async () => {
      const api = await renderManagerForm();
      await fillEverythingButTheManagerNumbers();
      await setNumber(pulseField(), '0');

      expect(submitButton()).toBeDisabled();
      await userEvent.click(submitButton());
      expect(api.createManagerSession).not.toHaveBeenCalled();

      await setNumber(pulseField(), '90');
      expect(submitButton()).toBeEnabled();
      await userEvent.click(submitButton());
      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ pulseSeconds: 90 }));
    });
  });

  describe('children cap', () => {
    it('shows its bounds next to the stepper', async () => {
      await renderManagerForm();

      expect(capField()).toHaveAccessibleDescription(/1 – 64/);
    });

    it('steps up and down one at a time and sends the stepped value', async () => {
      const api = await renderManagerForm();
      await fillEverythingButTheManagerNumbers();

      await userEvent.click(capStepper('Increase'));
      await userEvent.click(capStepper('Increase'));
      await userEvent.click(capStepper('Decrease'));
      await userEvent.click(submitButton());

      expect(capField()).toHaveValue(3);
      expect(api.createManagerSession).toHaveBeenCalledWith(expect.objectContaining({ childrenCap: 3 }));
    });

    it('disables the decrease button at 1, with no alert', async () => {
      await renderManagerForm();

      await userEvent.click(capStepper('Decrease'));

      expect(capField()).toHaveValue(1);
      expect(capStepper('Decrease')).toBeDisabled();
      expect(screen.queryByTestId('manager-children-cap-error')).toBeNull();
    });

    it('disables the increase button at 64 and says 64 is the daemon maximum', async () => {
      await renderManagerForm();

      await setNumber(capField(), '64');

      expect(capStepper('Increase')).toBeDisabled();
      expect(screen.getByTestId('manager-children-cap-maximum')).toHaveTextContent('64 is the daemon maximum');
      expect(capField()).toHaveAccessibleDescription(/64 is the daemon maximum/);
    });

    it('does not show the maximum note below 64', async () => {
      await renderManagerForm();

      expect(screen.queryByTestId('manager-children-cap-maximum')).toBeNull();
    });

    it('clamps a typed 65 back to the bound when stepping down, and a typed 0 when stepping up', async () => {
      await renderManagerForm();

      await setNumber(capField(), '65');
      await userEvent.click(capStepper('Decrease'));
      expect(capField()).toHaveValue(64);

      await setNumber(capField(), '0');
      await userEvent.click(capStepper('Increase'));
      expect(capField()).toHaveValue(1);
    });

    it.each([
      ['0', 'below the minimum'],
      ['65', 'above the maximum'],
      ['2.5', 'not a whole number'],
      ['', 'empty'],
    ])('says what is wrong and what to do when the cap is %s (%s)', async (typed) => {
      await renderManagerForm();

      await setNumber(capField(), typed);

      const alert = screen.getByTestId('manager-children-cap-error');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(alert).toHaveTextContent(CAP_RANGE_ERROR);
      expect(capField()).toHaveAttribute('aria-invalid', 'true');
      expect(capField()).toHaveAccessibleDescription(new RegExp(CAP_RANGE_ERROR));
    });

    it('keeps Create disabled and sends nothing while the cap is invalid', async () => {
      const api = await renderManagerForm();
      await fillEverythingButTheManagerNumbers();

      await setNumber(capField(), '65');

      expect(submitButton()).toBeDisabled();
      await userEvent.click(submitButton());
      expect(api.createManagerSession).not.toHaveBeenCalled();
    });
  });

  it('leaves Create enabled on a fresh form: the defaults are valid', async () => {
    await renderManagerForm();

    expect(submitButton()).toBeEnabled();
  });

  it('lists the New session "manual" permission mode with the design 1.2 wording', async () => {
    await renderManagerForm();

    expect(screen.getByRole('radio', { name: 'manual' })).toHaveAccessibleDescription('Asks before risky tools, except those you already allowed in your Claude settings.');
  });
});
