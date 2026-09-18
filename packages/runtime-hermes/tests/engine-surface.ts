/**
 * Runs `tests/test_engine_surface.py` against the pinned engine environment.
 *
 * Those probes import engine modules directly, so they need an interpreter that
 * has the pinned engine installed — not the isolated environment
 * `bun run test:plugin` builds. The interpreter is found, in order, from
 * `MELETE_HERMES_PYTHON` (the interpreter itself), `MELETE_HERMES_VENV` (a
 * virtual environment holding it), or a `.hermes-venv` directory at the
 * repository root. pytest is layered on top with `uv run --with`, so the
 * environment itself is never written to.
 *
 * With no such interpreter the probes are not run, and the reason is printed.
 * The exit status stays zero: the probes are an opt-in surface, and the same
 * absence makes the test file skip itself.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PYTEST = 'pytest==9.1.1';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** Interpreter paths a virtual environment may hold, Windows first. */
function interpretersIn(venv: string): string[] {
  return [join(venv, 'Scripts', 'python.exe'), join(venv, 'bin', 'python')];
}

function resolveInterpreter(): string | null {
  const direct = process.env.MELETE_HERMES_PYTHON;
  if (direct) return existsSync(direct) ? direct : null;
  const venvs = [process.env.MELETE_HERMES_VENV, join(repoRoot, '.hermes-venv')];
  for (const venv of venvs) {
    if (!venv) continue;
    for (const candidate of interpretersIn(venv)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const interpreter = resolveInterpreter();
if (interpreter === null) {
  process.stdout.write(
    'The engine surface probes were NOT run: no interpreter with the pinned ' +
      'engine was found.\n' +
      '  Set MELETE_HERMES_PYTHON to that interpreter, or MELETE_HERMES_VENV ' +
      'to a virtual environment holding it,\n' +
      '  or place that environment at .hermes-venv in the repository root.\n',
  );
  process.exit(0);
}

const args = process.argv.slice(2);
const run = Bun.spawnSync(
  [
    'uv',
    'run',
    '--no-project',
    '--python',
    interpreter,
    '--with',
    PYTEST,
    'python',
    '-m',
    'pytest',
    'tests/test_engine_surface.py',
    '-q',
    ...args,
  ],
  { cwd: packageRoot, stdout: 'inherit', stderr: 'inherit' },
);
process.exit(run.exitCode ?? 1);
