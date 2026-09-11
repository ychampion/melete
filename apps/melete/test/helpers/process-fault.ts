/** Spawn only a test-owned child and collect its abrupt-exit marker. */
export async function processFault(path: string, input: unknown, expectedCode: number) {
  const child = Bun.spawn({
    cmd: [process.execPath, path],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      FIREWORKS_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GOOGLE_API_KEY: '',
    },
  });
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== expectedCode)
      throw new Error(`Fault child exited ${code}: ${stderr.slice(-2000)} ${stdout.slice(-2000)}`);
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}
