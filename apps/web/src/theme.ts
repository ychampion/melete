/**
 * Appearance: light, dark, or follow the system. The choice is stamped on the
 * root as data-theme; "system" stamps nothing and lets prefers-color-scheme
 * decide, which is what tokens.css expects.
 */
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const KEY = 'melete.theme';

function read(): Theme {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage blocked: fall through to the system preference.
  }
  return 'system';
}

export function applyTheme(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function useTheme(): [Theme, (next: Theme) => void, boolean] {
  const [theme, setThemeState] = useState<Theme>(read);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    applyTheme(theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(theme === 'dark' || (theme === 'system' && media.matches));
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // A browser with storage blocked still gets a working session.
    }
  }, []);

  return [theme, setTheme, dark];
}
