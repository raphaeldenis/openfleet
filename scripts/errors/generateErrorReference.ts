import { writeFileSync } from 'node:fs';
import { REFERENCE_PATH } from './referencePath.js';
import { renderErrorReference } from './renderErrorReference.js';

writeFileSync(REFERENCE_PATH, renderErrorReference());
console.log(`wrote ${REFERENCE_PATH}`);
