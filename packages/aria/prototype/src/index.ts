/**
 * Aria visual prototype.
 *
 * Mounting `AriaPrototype` renders the complete interface: the shell, the six
 * screens, the detail drawers and the demonstration data. The package imports
 * the DSH theme tokens, the Aria token overlay and the reused ui-primitives
 * atoms; it registers no Cordis plugin and makes no network request.
 */

import '@deepseek-ai/dsh-aria-theme'
import '@deepseek-ai/dsh-aria-wordmark'
import './App.module.css'

export { AriaPrototype } from './App.tsx'
export { DEMO_WORKSPACE, DEMO_REFERENCE } from './fixtures.ts'
export { parseLocation, formatLocation, ROUTES } from './routes.ts'
export type { Location, RouteId } from './routes.ts'
export { translate } from './locales/index.ts'
export type { Translate } from './locales/index.ts'
export type * from './model.ts'
