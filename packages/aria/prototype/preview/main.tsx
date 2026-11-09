/**
 * Preview harness for the Aria prototype.
 *
 * This is the only file in the package that touches the DOM directly: it imports
 * the Aria token sheet and brand sheet, then mounts `AriaPrototype` on #root.
 * It is not part of the published `"."` export — the DSH host mounts the
 * component itself — and it exists so a reviewer can look at the interface
 * without starting the application server.
 */

import { createRoot } from 'react-dom/client'
import '@deepseek-ai/dsh-aria-theme/tokens.css'
import '@deepseek-ai/dsh-aria-wordmark/brand.css'
import { AriaPrototype } from '../src/index.ts'

const container = document.getElementById('root')
if (container === null) throw new Error('aria preview: #root is missing from index.html')

createRoot(container).render(<AriaPrototype />)
