/**
 * A hash router. `#/chat/c_01` becomes { path: '/chat/c_01', parts: ['chat', 'c_01'] }.
 * Navigation is a plain href, so every destination is a link a person can copy.
 */
import { useEffect, useState } from 'react';

export type Route = { path: string; parts: string[]; query: URLSearchParams };

/** The route a location's fragment names: `#/welcome?token=…` is /welcome with a query. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart && pathPart.length > 0 ? pathPart : '/';
  return {
    path,
    parts: path.split('/').filter(Boolean),
    query: new URLSearchParams(queryPart ?? ''),
  };
}

function parse(): Route {
  return parseHash(window.location.hash);
}

/**
 * A value a mailed or printed link carries in its query. Sign-in links mailed
 * before links took the `#/welcome?token=…` form put the token straight after
 * the `#`, as `#token=…`; those still open the sign-in screen with it.
 */
export function linkParam(route: Route, name: string): string | null {
  const value = route.query.get(name);
  if (value) return value;
  if (!route.path.startsWith(`${name}=`)) return null;
  return new URLSearchParams(route.path).get(name);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string) {
  window.location.hash = path.startsWith('#') ? path.slice(1) : path;
}

export const href = (path: string) => `#${path}`;
