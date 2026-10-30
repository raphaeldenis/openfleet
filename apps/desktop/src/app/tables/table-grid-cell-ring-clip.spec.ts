import { describe, expect, it } from 'vitest';
import { TableGridComponent } from './table-grid.component';

const SCOPING_ATTRIBUTES = String.raw`(?:\[[^\]]*\])*`;
const BUTTON_FOCUS_RULE = new RegExp(String.raw`(?:^|[\s}])button${SCOPING_ATTRIBUTES}:focus-visible\s*\{([^}]*)\}`);
const OUTLINE_OFFSET = /outline-offset\s*:\s*([^;}]*)/;
const CELL_RULE = new RegExp(String.raw`(?:^|[\s}])\.cell${SCOPING_ATTRIBUTES}\s*\{([^}]*)\}`);

function gridStyles(): string {
  const { styles } = (TableGridComponent as unknown as { ɵcmp: { styles: string[] } }).ɵcmp;
  return styles.join('\n');
}

function declarationsOf(rule: RegExp): string {
  return gridStyles().match(rule)?.[1] ?? '';
}

describe('table grid cell edit button focus ring', () => {
  it('keeps the cell clipping overflow that truncates long text with an ellipsis', () => {
    const cellDeclarations = declarationsOf(CELL_RULE);

    expect(cellDeclarations).toMatch(/overflow\s*:\s*hidden/);
    expect(cellDeclarations).toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  it('draws the ring inside the button so the clipping cell cannot cut it', () => {
    const outlineOffset = declarationsOf(BUTTON_FOCUS_RULE).match(OUTLINE_OFFSET)?.[1].trim() ?? '';

    expect(outlineOffset).toMatch(/^-\d*\.?\d+rem$/);
  });

  it('sizes the ring in rem', () => {
    const buttonFocusDeclarations = declarationsOf(BUTTON_FOCUS_RULE);

    expect(buttonFocusDeclarations).toMatch(/outline\s*:\s*0?\.125rem solid/);
    expect(buttonFocusDeclarations).not.toMatch(/px/);
  });
});
