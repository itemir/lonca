const KEY = 'lonca.token';

// The link from the terminal carries the token once. Keep it out of the address bar and
// out of history from the very first moment. It's only kept once the server accepts it, so
// a stray link with a bad token can't log out a working browser.
const url = new URL(location.href);
let candidate = url.searchParams.get('token');
if (candidate !== null) {
  url.searchParams.delete('token');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export function accessToken(): string | null {
  return candidate ?? localStorage.getItem(KEY);
}

export function tokenAccepted(): void {
  if (candidate !== null) {
    localStorage.setItem(KEY, candidate);
    candidate = null;
  }
}

/** Returns true if there's another token left to try. */
export function tokenRejected(): boolean {
  if (candidate === null) return false;
  candidate = null;
  return localStorage.getItem(KEY) !== null;
}

export function socketUrl(path: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${path}?token=${encodeURIComponent(accessToken() ?? '')}`;
}
