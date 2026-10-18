/**
 * `bun run names:check` fails when the web app spells "Melete" where a person
 * reads it: in JSX text, or in an attribute that is shown or read aloud
 * (`title`, `placeholder`, `alt`, `label`, `aria-*`, and the `sub`, `hint`
 * and `text` of the app's own components). The app reads its own
 * name and its assistant's from the installation (`useInstance()`,
 * `instanceName()`, `assistantName()` in apps/web/src/experience/instance.ts),
 * so an installation that names itself never shows another name. It runs as
 * part of `bun run lint`.
 *
 * Comments, code names, imports and strings outside JSX are not checked here.
 * A few places name the software itself rather than the installation; they
 * are listed in ALLOWED with the reason.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const NAME = /\bMelete\b/;

/** Attributes whose words a person sees or hears, the app's own components' among them. */
const READ_ATTRIBUTE =
  /^(title|placeholder|alt|label|aria-[a-z-]+|sub|hint|text|desc|what|message)$/;

/**
 * Text that names the software, not the installation, by file and the words
 * that may appear there.
 */
export const ALLOWED: readonly { file: string; text: string; why: string }[] = [
  {
    file: 'apps/web/src/screens/Devices.tsx',
    text: 'from a copy of Melete with Bun installed',
    why: 'the software a computer runs to connect',
  },
  {
    file: 'apps/web/src/design/Sheet.tsx',
    text: 'Melete components',
    why: 'the development-only component sheet',
  },
];

export type Finding = { file: string; line: number; text: string };

const allowed = (file: string, text: string) =>
  ALLOWED.some((entry) => entry.file === file && text.includes(entry.text));

/** Every literal "Melete" a person would read in one TSX source. */
export function visibleNames(file: string, source: string): Finding[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Finding[] = [];
  const report = (node: ts.Node, text: string) => {
    if (!NAME.test(text) || allowed(file, text)) return;
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    found.push({ file, line: line + 1, text: text.trim().replace(/\s+/g, ' ') });
  };
  const literalText = (node: ts.Node | undefined): string | null => {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node))
      return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
    if (ts.isJsxExpression(node)) return literalText(node.expression);
    if (ts.isConditionalExpression(node))
      return [literalText(node.whenTrue), literalText(node.whenFalse)].join(' ');
    if (ts.isBinaryExpression(node))
      return [literalText(node.left), literalText(node.right)].join(' ');
    if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
    return null;
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) report(node, node.text);
    else if (ts.isJsxExpression(node) && node.parent && !ts.isJsxAttribute(node.parent)) {
      const text = literalText(node.expression);
      if (text) report(node, text);
    } else if (ts.isJsxAttribute(node) && READ_ATTRIBUTE.test(node.name.getText(tree))) {
      const text = literalText(node.initializer);
      if (text) report(node, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(path);
  }
  return out;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const findings = sources(join(root, 'apps/web/src')).flatMap((path) =>
    visibleNames(relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8')),
  );
  for (const finding of findings)
    process.stderr.write(
      `${finding.file}:${finding.line}: "Melete" in visible text: ${finding.text}\n`,
    );
  if (findings.length) {
    process.stderr.write(
      'names:check failed. Use instanceName() or assistantName() from apps/web/src/experience/instance.ts.\n',
    );
    process.exit(1);
  }
  process.stdout.write('names:check passed\n');
}
