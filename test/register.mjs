/**
 * Installs the .tsx hooks for `node --test`. Referenced by the test script as
 * `--import ./test/register.mjs`. See tsx-hooks.mjs for why it is needed.
 */
import { register } from 'node:module'
register('./tsx-hooks.mjs', import.meta.url)
