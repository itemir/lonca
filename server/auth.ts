import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { DEV_MODE, DEV_PORT, HTTP_PORT } from './config.ts';
import { accessToken } from './store.ts';

// The server can start virtual machines and hand out shells, and anything running on this
// machine or any website open in a browser can reach localhost. Three checks close that:
// the Host header defeats DNS rebinding, the Origin header stops other sites from opening
// connections, and the token keeps out local processes.
//
// The token travels in a header and lives in the page's localStorage, never in a cookie.
// Browsers send cookies to every port on a host, so a server an agent runs on a published
// port would receive a cookie the moment the user opened it. localStorage is per-origin,
// which includes the port.

function allowedAuthorities(): Set<string> {
  const ports = DEV_MODE ? [HTTP_PORT, DEV_PORT] : [HTTP_PORT];
  return new Set(ports.flatMap((port) => [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]));
}

const authorities = allowedAuthorities();

function hostAllowed(host: string | undefined): boolean {
  return host !== undefined && authorities.has(host);
}

function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return authorities.has(new URL(origin).host);
  } catch {
    return false;
  }
}

function tokenMatches(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(accessToken());
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Applies to every request. The web app's static files hold no secrets, so they need nothing more. */
export function requireLocalRequest(req: Request, res: Response, next: NextFunction): void {
  if (!hostAllowed(req.headers.host)) {
    res.status(403).type('text/plain').send('Lonca only answers on localhost.');
    return;
  }
  if (!originAllowed(req.headers.origin)) {
    res.status(403).type('text/plain').send('Cross-site requests are not allowed.');
    return;
  }
  next();
}

export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && tokenMatches(header.slice('Bearer '.length))) {
    next();
    return;
  }
  res.status(401).json({ error: 'Open Lonca with the link printed in the terminal.' });
}

/** Parses a request URL that could be anything, since it comes before any checks. */
export function parseRequestUrl(url: string | undefined): URL | null {
  try {
    return new URL(url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

export function upgradeAllowed(req: IncomingMessage): boolean {
  if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) return false;
  return tokenMatches(parseRequestUrl(req.url)?.searchParams.get('token'));
}

// IPv6 addresses aren't valid in a policy; 'self' covers a page opened on one.
const SOCKET_ORIGINS = [...authorities].filter((authority) => !authority.startsWith('[')).map((authority) => `ws://${authority}`).join(' ');

/**
 * The page must never load inside a frame: an agent's page on a published port counts as
 * the same site, and could overlay a frame to trick the user into clicking its buttons.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    // React's style props and the terminal both set inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://github.com https://avatars.githubusercontent.com",
    "font-src 'self'",
    `connect-src 'self' ${SOCKET_ORIGINS}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
}

export function launchUrl(): string {
  return `http://localhost:${HTTP_PORT}/?token=${accessToken()}`;
}
