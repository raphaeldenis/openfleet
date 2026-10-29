import { expect, test, type Page } from '@playwright/test';
import { SEEDED_COLUMN, SEEDED_PROJECT, SEEDED_ROW } from '../../../scripts/e2e/e2eSeedFixture';
import { signInAsAdmin } from './support/daemon';

const EDITED_DETAILS = 'Edited against the real daemon';

async function openSeededRowDetails(page: Page) {
  await page.goto(`/tables?projectId=${SEEDED_PROJECT.id}`);
  await page.getByTestId(`grid-row-${SEEDED_ROW.id}`).focus();
  await page.keyboard.press('Enter');
  return page.getByRole('region', { name: 'Row details' });
}

test('saves a cell edit through the real daemon, finds it after a reload and in the row history', async ({ page }) => {
  await signInAsAdmin(page);
  const details = await openSeededRowDetails(page);
  await expect(details).toContainText(SEEDED_ROW.details);

  await details.getByRole('button', { name: `Edit ${SEEDED_COLUMN.displayName}` }).click();
  const dialog = page.getByRole('dialog', { name: new RegExp(`Edit ${SEEDED_COLUMN.displayName}`) });
  await dialog.getByLabel(SEEDED_COLUMN.displayName, { exact: true }).fill(EDITED_DETAILS);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(details).toContainText(EDITED_DETAILS);

  const reloadedDetails = await openSeededRowDetails(page);
  await expect(reloadedDetails).toContainText(EDITED_DETAILS);
  await expect(page.getByTestId('tables-history')).toContainText(`${SEEDED_COLUMN.displayName} ${SEEDED_ROW.details} → ${EDITED_DETAILS}`);
});
