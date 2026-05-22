/**
 * Self-contained website verifier for the partner-network module.
 *
 * Functionally equivalent to the verifier in the main LeadBridge UsersService,
 * but duplicated here on purpose: keeping it inside the module means the whole
 * Partner Network feature can be extracted as a standalone product without
 * dragging UsersService along.
 *
 * What it does:
 *   - Normalize a user-entered URL ("myco.com" → "https://myco.com").
 *   - Refuse internal/private hosts (SSRF guard).
 *   - Fetch the page with a timeout + size ceiling.
 *   - Parse <title>, meta description, and a likely phone from the <head>.
 *   - Retry with the "www." prefix on apex DNS failure (Wix/Squarespace etc).
 */

import axios from 'axios';

export interface VerifyWebsiteResult {
  reachable: boolean;
  normalizedUrl: string;
  metadata?: {
    title?: string;
    description?: string;
    phone?: string;
  };
  errorCode?:
    | 'invalid_url'
    | 'private_host'
    | 'dns_not_found'
    | 'connection_refused'
    | 'timeout'
    | 'http_error'
    | 'unreachable';
  errorMessage?: string;
}

export function normalizeWebsiteUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = String(input).trim();
  if (raw.length === 0) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try {
    const u = new URL(raw);
    if (!u.hostname || !u.hostname.includes('.')) return null;
    if (isPrivateHost(u.hostname.toLowerCase())) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '::1' || host.startsWith('fe80:')) return true;
  return false;
}

export async function verifyWebsite(input: string): Promise<VerifyWebsiteResult> {
  const normalized = normalizeWebsiteUrl(input);
  if (!normalized) {
    return {
      reachable: false,
      normalizedUrl: (input ?? '').trim(),
      errorCode: 'invalid_url',
      errorMessage: "That doesn't look like a valid website URL.",
    };
  }
  try {
    const u = new URL(normalized);
    if (isPrivateHost(u.hostname.toLowerCase())) {
      return {
        reachable: false,
        normalizedUrl: normalized,
        errorCode: 'private_host',
        errorMessage: 'Internal addresses are not allowed.',
      };
    }
  } catch {
    return { reachable: false, normalizedUrl: normalized, errorCode: 'invalid_url' };
  }

  let result = await tryFetchWebsite(normalized);
  if (!result.reachable && shouldRetryWithWww(result, normalized)) {
    try {
      const u = new URL(normalized);
      const wwwUrl = `${u.protocol}//www.${u.hostname}${u.pathname}${u.search}`;
      const wwwResult = await tryFetchWebsite(wwwUrl);
      if (wwwResult.reachable) return wwwResult;
    } catch { /* fall through */ }
  }
  return result;
}

async function tryFetchWebsite(url: string): Promise<VerifyWebsiteResult> {
  try {
    const response = await axios.get(url, {
      timeout: 6000,
      maxRedirects: 3,
      maxContentLength: 5 * 1024 * 1024,
      responseType: 'text',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PartnerNetworkWebsiteCheck/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      validateStatus: (s) => s < 400,
    });
    const html: string = typeof response.data === 'string' ? response.data : '';
    const metadata = extractWebsiteMetadata(html);
    const finalUrl: string = (response.request?.res?.responseUrl as string) || url;
    return { reachable: true, normalizedUrl: finalUrl, metadata };
  } catch (err: any) {
    const code = err.code || '';
    const status = err.response?.status;
    const msg = err.message || '';
    // Oversize body still means reachable; we just skip metadata parsing.
    if (/maxContentLength/i.test(msg)) {
      return { reachable: true, normalizedUrl: url, metadata: {} };
    }
    let errorCode: VerifyWebsiteResult['errorCode'] = 'unreachable';
    let errorMessage = "We couldn't load this site.";
    if (code === 'ECONNABORTED' || /timeout/i.test(msg)) {
      errorCode = 'timeout';
      errorMessage = 'The site took too long to respond.';
    } else if (code === 'ENOTFOUND' || /enotfound|getaddrinfo/i.test(msg)) {
      errorCode = 'dns_not_found';
      errorMessage = "We couldn't find that domain.";
    } else if (code === 'ECONNREFUSED') {
      errorCode = 'connection_refused';
      errorMessage = 'The site refused the connection.';
    } else if (typeof status === 'number') {
      errorCode = 'http_error';
      errorMessage = `The site returned an error (HTTP ${status}).`;
    }
    return { reachable: false, normalizedUrl: url, errorCode, errorMessage };
  }
}

function shouldRetryWithWww(result: VerifyWebsiteResult, originalUrl: string): boolean {
  if (!result.errorCode) return false;
  if (
    result.errorCode !== 'dns_not_found' &&
    result.errorCode !== 'connection_refused' &&
    result.errorCode !== 'unreachable' &&
    result.errorCode !== 'timeout'
  ) return false;
  try {
    return !new URL(originalUrl).hostname.startsWith('www.');
  } catch {
    return false;
  }
}

function extractWebsiteMetadata(html: string): VerifyWebsiteResult['metadata'] {
  if (!html) return {};
  const title = firstMatch(html, /<title[^>]*>([\s\S]{1,500}?)<\/title>/i);
  const description =
    metaContent(html, 'description') ||
    metaContent(html, 'og:description', 'property') ||
    undefined;
  const phone = firstMatch(
    html,
    /(\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/,
    0,
  );
  return {
    title: trimText(title),
    description: trimText(description),
    phone: phone ? phone.trim() : undefined,
  };
}

function firstMatch(html: string, re: RegExp, group = 1): string | undefined {
  const m = html.match(re);
  if (!m) return undefined;
  return (m[group] ?? '').replace(/\s+/g, ' ').trim() || undefined;
}

function metaContent(html: string, name: string, attr: 'name' | 'property' = 'name'): string | undefined {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reAttrFirst = new RegExp(
    `<meta[^>]+${attr}=["']${esc}["'][^>]*content=["']([^"']{1,500})["']`,
    'i',
  );
  const reContentFirst = new RegExp(
    `<meta[^>]+content=["']([^"']{1,500})["'][^>]*${attr}=["']${esc}["']`,
    'i',
  );
  return firstMatch(html, reAttrFirst) || firstMatch(html, reContentFirst);
}

function trimText(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length === 0 ? undefined : cleaned.slice(0, 280);
}
