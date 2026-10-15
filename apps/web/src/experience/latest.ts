/**
 * Reads that overlap answer in any order. Only the newest read's answer is
 * applied; one that comes back after a newer one was asked for is dropped.
 */
export function latestOnly() {
  let asked = 0;
  return <T>(read: Promise<T>, apply: (value: T) => void): void => {
    const mine = ++asked;
    void read.then((value) => {
      if (mine === asked) apply(value);
    });
  };
}
