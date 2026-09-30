/**
 * A chat title from its first message: the first sentence, cut on a word
 * boundary. A period inside an address or a number does not end the sentence.
 */
export function shortTitle(text: string, limit = 42): string {
  const sentence = text.replace(/[.!?](?:\s.*)?$/s, '').trim();
  if (sentence.length <= limit) return sentence;
  const cut = sentence.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
