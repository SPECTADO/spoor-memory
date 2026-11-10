declare const __WEB_VERSION__: string | undefined

/** What the server and the CLI report when they cannot read their own version; never a real release. */
export const UNKNOWN_VERSION = '0.0.0'

/**
 * The web UI's version, from packages/web/package.json at build time (vite `define` in vite.config.ts).
 * A bundler that does not apply that `define` gets `UNKNOWN_VERSION` instead of a ReferenceError.
 */
export const WEB_VERSION: string = typeof __WEB_VERSION__ === 'string' ? __WEB_VERSION__ : UNKNOWN_VERSION

/** A version worth showing: present and not the `0.0.0` fallback. */
export const isKnownVersion = (v: string | undefined): v is string => !!v && v !== UNKNOWN_VERSION

/** True when both versions are known and differ: the browser runs a web build the server no longer serves. */
export const versionsDiffer = (web: string | undefined, server: string | undefined): boolean =>
  isKnownVersion(web) && isKnownVersion(server) && web !== server
