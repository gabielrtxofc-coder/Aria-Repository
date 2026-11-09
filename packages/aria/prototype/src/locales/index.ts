/**
 * Locale dictionary for the Aria prototype.
 *
 * The prototype ships one locale. The dictionary still goes through the same
 * `t` seam a translated surface would use, so adopting a second locale is a new
 * file beside `en.ts` rather than an edit to every screen.
 */

import { en, type AriaLocaleKey } from './en.ts'

export { en }
export type { AriaLocaleKey }

/** Values a translator may substitute into a template. */
export type LocaleParams = Readonly<Record<string, string | number>>

/**
 * Substitute `{name}` placeholders in a template.
 * @param template - dictionary value containing zero or more placeholders.
 * @param params - values keyed by placeholder name.
 * @returns the template with every named placeholder replaced.
 */
export function formatLocale(template: string, params: LocaleParams): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Resolve a key to its text.
 * @param key - dictionary key.
 * @param params - optional placeholder values.
 * @returns the localized text.
 */
export function translate(key: AriaLocaleKey, params?: LocaleParams): string {
  const template: string = en[key]
  return params === undefined ? template : formatLocale(template, params)
}

/** The translate function every prototype component receives. */
export type Translate = typeof translate
