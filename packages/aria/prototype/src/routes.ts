/**
 * The prototype's information architecture.
 *
 * Six screens, five in the workspace and one under system settings. The router
 * keeps the active route in component state and mirrors it into the URL
 * fragment, so a reviewer can link to a screen and reload without losing place;
 * it registers no application route and touches no host navigation.
 */

/** Screen identifiers, in navigation order. */
export const ROUTES = ['overview', 'missions', 'agents', 'knowledge', 'activity', 'settings'] as const

/** One screen of the prototype. */
export type RouteId = typeof ROUTES[number]

/** Query carried by a route that targets a specific record. */
export interface RouteQuery {
  /** Mission to open in the drawer. */
  readonly mission?: string | undefined
  /** Agent to open in the drawer. */
  readonly agent?: string | undefined
}

/** The current location: a screen plus an optional record. */
export interface Location {
  readonly route: RouteId
  readonly query: RouteQuery
}

/** The default location. */
export const DEFAULT_LOCATION: Location = { route: 'overview', query: {} }

/**
 * Parse a location from a URL fragment.
 * @param hash - a fragment such as `#/missions?mission=mis-q4-supply` or `#missions`.
 * @returns the parsed location, falling back to the default screen.
 */
export function parseLocation(hash: string): Location {
  const raw = hash.replace(/^#\/?/, '')
  if (raw === '') return DEFAULT_LOCATION
  const [path = '', search = ''] = raw.split('?')
  const route = (ROUTES as readonly string[]).includes(path) ? path as RouteId : DEFAULT_LOCATION.route
  const params = new URLSearchParams(search)
  const mission = params.get('mission')
  const agent = params.get('agent')
  return {
    route,
    query: {
      ...(mission === null ? {} : { mission }),
      ...(agent === null ? {} : { agent }),
    },
  }
}

/**
 * Serialize a location to a URL fragment.
 * @param location - the location to encode.
 * @returns the fragment, including the leading `#`.
 */
export function formatLocation(location: Location): string {
  const params = new URLSearchParams()
  if (location.query.mission !== undefined) params.set('mission', location.query.mission)
  if (location.query.agent !== undefined) params.set('agent', location.query.agent)
  const search = params.toString()
  return `#/${location.route}${search === '' ? '' : `?${search}`}`
}

/**
 * Compare two locations by their serialized form.
 * @param a - first location.
 * @param b - second location.
 * @returns whether both address the same screen and record.
 */
export function sameLocation(a: Location, b: Location): boolean {
  return formatLocation(a) === formatLocation(b)
}
