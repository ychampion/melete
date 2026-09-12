/**
 * Emit the execution and publish tools as the broker would serve them, so the
 * scaffolding probe measures the schemas that actually ship rather than a
 * hand-copied approximation that can drift from the manifests.
 *
 *   bun run .agents/probe/execution_tools.ts > execution_tools.json
 */
import { artifactsManifest } from '../../apps/melete/src/connectors/artifacts.ts';
import { execManifest } from '../../apps/melete/src/connectors/exec.ts';

const tools = [...execManifest.tools, ...artifactsManifest.tools].map((tool) => [
  tool.name,
  tool.description,
  tool.input_schema,
]);
process.stdout.write(JSON.stringify(tools, null, 2));
