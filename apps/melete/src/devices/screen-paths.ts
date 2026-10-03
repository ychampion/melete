/**
 * Where an earlier version kept a paired computer's screenshot inside a job's
 * workspace, relative to it. Nothing may open such a file any more: the files
 * tools refuse it, the sandbox sync never carries it and removes any copy a
 * sandbox still holds, and the service moves each one out (screens.ts).
 */
export const LEGACY_SCREEN_PATH = /^device\/screenshot-act_[A-Za-z0-9]{1,64}\.png$/;
