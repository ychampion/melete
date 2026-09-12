/**
 * A hash router. `#/chat/c_01` becomes { path: '/chat/c_01', parts: ['chat', 'c_01'] }.
 * Navigation is a plain href, so every destination is a link a person can copy.
 */
import { useEffect, useState } from 'react';

export type Route = { path: string; parts: string[]; query: URLSearchParams };

function parse(): Route {
  const raw = window.location.hash.slice(1) || '/';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart && pathPart.length > 0 ? pathPart : '/';
  return {
    path,
    parts: path.split('/').filter(Boolean),
    query: new URLSearchParams(queryPart ?? ''),
  };
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
