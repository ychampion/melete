/**
 * Reads that overlap answer in any order. An answer is applied unless a newer
 * read's answer already was, so an older one never undoes a newer one, and a
 * slow answer still lands while the next read is on its way.
 */
export function latestOnly() {
  let asked = 0;
  let applied = 0;
  return <T>(read: Promise<T>, apply: (value: T) => void): void => {
    const mine = ++asked;
    void read.then((value) => {
      if (mine < applied) return;
      applied = mine;
      apply(value);
    });
  };
}
