/** The release this image is built from. Changing it is a decision, not a bump. */
export const HERMES_PINNED_TAG = 'v2026.9.7';

/**
 * The commit the tag resolves to, recorded so a running container can say
 * exactly what it is. The image writes the same value to
 * `/opt/hermes/.melete-hermes-commit` at build time, and the two are expected
 * to agree; if they ever do not, the image was built from a moved tag.
 */
export const HERMES_PINNED_COMMIT = '2237be355906fbe6065ce1815711eee52b2d646e';

export const HERMES_REPOSITORY = 'https://github.com/NousResearch/hermes-agent';
export const RUNTIME_VERSION = `hermes@${HERMES_PINNED_TAG}+melete-observers.3`;
