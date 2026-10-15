/**
 * This installation's terms, privacy notice and support, as its operator set
 * them. Each shows only when it is set, so an installation with none shows
 * nothing at all.
 */
import { useEffect, useState } from 'react';
import { adapter } from '../experience/adapter.ts';

export type InstallLink = { label: string; href: string };

type Settings = { terms_url?: string; privacy_url?: string; support_url?: string };

/** Only a web page, or a mail address for support, is ever made a link. */
const safe = (value: string | undefined, schemes: readonly string[]): string | null => {
  if (!value) return null;
  try {
    return schemes.includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
};

/** The links that are set, in the order they are shown. */
export function installLinks(settings: Settings | null | undefined): InstallLink[] {
  const links: InstallLink[] = [];
  const terms = safe(settings?.terms_url, ['https:']);
  const privacy = safe(settings?.privacy_url, ['https:']);
  const support = safe(settings?.support_url, ['https:', 'mailto:']);
  if (terms) links.push({ label: 'Terms', href: terms });
  if (privacy) links.push({ label: 'Privacy', href: privacy });
  if (support) links.push({ label: 'Help and support', href: support });
  return links;
}

// Asked once per page load: the operator's settings do not change while it is
// open. An answer that did not come is not kept, so the next page that shows
// the links asks again.
let asked: Promise<InstallLink[]> | null = null;
export const ask = () => {
  if (asked) return asked;
  const asking = adapter.setupStatus().then(
    (result) => {
      if (result.data === null && asked === asking) asked = null;
      return installLinks(result.data);
    },
    () => {
      if (asked === asking) asked = null;
      return [];
    },
  );
  asked = asking;
  return asking;
};

export function InstallLinksRow({ links }: { links: InstallLink[] }) {
  if (links.length === 0) return null;
  return (
    <nav
      aria-label="About this service"
      className="row"
      style={{ gap: 16, flexWrap: 'wrap', justifyContent: 'center', fontSize: 12 }}
    >
      {links.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--muted)', textDecoration: 'underline' }}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

/** The links, fetched once; nothing while they load or when none is set. */
export function InstallLinks() {
  const [links, setLinks] = useState<InstallLink[]>([]);
  useEffect(() => {
    let live = true;
    void ask().then((found) => {
      if (live) setLinks(found);
    });
    return () => {
      live = false;
    };
  }, []);
  return <InstallLinksRow links={links} />;
}
