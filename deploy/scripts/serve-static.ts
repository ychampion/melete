/**
 * Serves the reference client's built bundle.
 *
 * Twelve lines instead of a dependency, because a self-hosted client that has
 * to reach a package registry before it can start is not self-hosted. Unknown
 * paths fall back to index.html: the client routes on the hash, but a deep link
 * that arrives as a path should still load the app rather than 404.
 */
const root = new URL('./dist/', `file://${process.cwd()}/`);
const port = Number(process.env.PORT ?? 3000);

const index = Bun.file(new URL('index.html', root));

Bun.serve({
  port,
  idleTimeout: 60,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    // Reject anything that tries to climb out of dist before touching the disk.
    const relative = pathname.replace(/^\/+/, '');
    if (relative.includes('..')) return new Response('Not found', { status: 404 });

    if (relative.length > 0) {
      const file = Bun.file(new URL(relative, root));
      if (await file.exists()) return new Response(file);
    }
    return new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});

process.stdout.write(`melete web client listening on :${port}\n`);
