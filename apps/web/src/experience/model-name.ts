/**
 * A model's name as a person reads it, from the identifier its provider uses:
 * `accounts/fireworks/models/deepseek-v4p1-flash` reads "DeepSeek V4.1 Flash".
 * Show the identifier beside it where the exact value matters.
 */

/** Names whose usual spelling is not simple title case. */
const SPELLED: Record<string, string> = {
  deepseek: 'DeepSeek',
  gpt: 'GPT',
  glm: 'GLM',
  qwen: 'Qwen',
  qwq: 'QwQ',
  llama: 'Llama',
  mixtral: 'Mixtral',
  openai: 'OpenAI',
  oss: 'OSS',
  vl: 'VL',
  moe: 'MoE',
  it: 'IT',
};

const DATE_STAMP = /^(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/;

function word(token: string): string {
  const lower = token.toLowerCase();
  if (SPELLED[lower]) return SPELLED[lower];
  // Fireworks writes a version's dot as `p`: v4p1 is V4.1, 3p5 is 3.5.
  const version = /^(v?)(\d+)((?:p\d+)+)$/.exec(lower);
  if (version)
    return `${version[1] ? 'V' : ''}${version[2]}${(version[3] ?? '').replace(/p/g, '.')}`;
  if (/^v\d+(?:\.\d+)*$/.test(lower)) return `V${lower.slice(1)}`;
  // A parameter count: 8b, 70b, 1.5b, 22k.
  if (/^\d+(?:\.\d+)?[bkm]$/.test(lower)) return lower.toUpperCase();
  // OpenAI's reasoning models are written lower case: o3, o4-mini.
  if (/^\d/.test(token) || /^o\d+$/.test(lower)) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function modelDisplayName(id: string): string {
  const trimmed = id.trim();
  const last = trimmed.split('/').filter(Boolean).pop() ?? '';
  const tokens = last.split(/[-_:\s]+/).filter((token) => token && !DATE_STAMP.test(token));
  if (tokens.length === 0) return trimmed;
  const words: string[] = [];
  for (const token of tokens) {
    const previous = words[words.length - 1];
    // claude-sonnet-4-5 is version 4.5, not "4 5".
    if (previous !== undefined && /^\d+$/.test(token) && /^\d+$/.test(previous))
      words[words.length - 1] = `${previous}.${token}`;
    else if (previous === 'GPT' && /^\d/.test(token)) words[words.length - 1] = `GPT-${token}`;
    else words.push(word(token));
  }
  return words.join(' ');
}
