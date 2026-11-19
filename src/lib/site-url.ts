/**
 * Public site origin used for assets that must load from an email client (the logo).
 * An email is opened outside the app, so the URL must be absolute, HTTPS and publicly reachable:
 * never a relative path, localhost, a private address or a file path.
 */
export const EMAIL_LOGO_PATH = '/images/quiron-logo.png';

/** The origin (`https://host`) of a public HTTPS URL, or null for anything else. */
export function httpsOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null; // relative paths, file paths and garbage do not parse as absolute URLs
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127|10|0)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.startsWith('[') || // IPv6 literals (loopback, link-local, ...)
    !host.includes('.'); // bare hostnames are never public
  return isPrivate ? null : url.origin;
}

/** Absolute HTTPS URL of the email logo for a configured site URL; null when none is usable. */
export function emailLogoUrl(siteUrl: string | null | undefined): string | null {
  const origin = httpsOrigin(siteUrl);
  return origin ? `${origin}${EMAIL_LOGO_PATH}` : null;
}

/**
 * The canonical public site URL: APP_URL when it is a usable public HTTPS URL, otherwise the
 * production domain Vercel exposes to every deployment (VERCEL_PROJECT_PRODUCTION_URL, host only).
 * Preview deployment URLs are behind Vercel authentication, so they are never used.
 */
export function publicSiteUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = httpsOrigin(env.APP_URL);
  if (configured) return configured;
  const production = env.VERCEL_PROJECT_PRODUCTION_URL;
  return production ? httpsOrigin(`https://${production.trim()}`) : null;
}
