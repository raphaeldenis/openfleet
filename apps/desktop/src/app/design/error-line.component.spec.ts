import { render, screen } from '@testing-library/angular/zoneless';
import { describe, expect, it } from 'vitest';
import { ErrorLineComponent } from './error-line.component';

const renderErrorLine = (template: string) => render(template, { imports: [ErrorLineComponent] });

describe('ErrorLineComponent', () => {
  it('writes the sentence in the foreground colour', async () => {
    await renderErrorLine('<of-error-line data-testid="line">Could not save</of-error-line>');

    const line = screen.getByTestId('line');

    expect(line).toHaveTextContent('Could not save');
    expect(getComputedStyle(line).color).toBe('var(--fg)');
  });

  it('draws a hidden ✕ glyph in the error state colour', async () => {
    await renderErrorLine('<of-error-line data-testid="line">Could not save</of-error-line>');

    const glyph = screen.getByTestId('line').querySelector('[aria-hidden="true"]');

    expect(glyph).toHaveTextContent('✕');
    expect(getComputedStyle(glyph as Element).color).toBe('var(--state-error)');
  });

  it('omits the glyph when the sentence stands alone', async () => {
    await renderErrorLine('<of-error-line data-testid="line" [glyph]="false">Confirm first</of-error-line>');

    expect(screen.getByTestId('line').querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
