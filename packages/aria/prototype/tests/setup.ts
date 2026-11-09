/**
 * Test environment for the prototype specs.
 *
 * jsdom lacks two browser APIs the interface touches: `matchMedia`, which the
 * shell reads for the reduced-motion preference, and `scrollTo`, which the shell
 * calls when the route changes.
 */

import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList
}

window.scrollTo = () => {}

// jsdom has no ResizeObserver; the drawer observes its panel for the focus trap.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

afterEach(() => { cleanup() })
