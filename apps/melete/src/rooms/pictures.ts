/**
 * Whether a room's request can look at a photo. The model that reads a photo
 * is the model that does the request: either the request's own model reads
 * pictures, or the operator's vision model serves every call that carries
 * one, answering it itself (`gateway/index.ts`, `routeCandidates`). No model
 * ever describes a photo for another to read.
 *
 * Which model a room's request runs on is the installation's choice, or the
 * operator's default, under the room's own rules; the room's maker's settings
 * apply where any person's do. Nobody else in the room, the asker included,
 * brings their own.
 */
import type { ModelSettingsService } from '../gateway/model-settings.ts';
import type { ModelRouting } from '../gateway/routing.ts';

export const ROOM_READS_NO_PICTURES =
  "This room's model can't read photos. Pick a model that can in Settings, or post the photo without asking.";

export async function roomReadsPictures(
  settings: ModelSettingsService,
  routing: ModelRouting,
  spaceId: string,
): Promise<boolean> {
  const choice = await settings.routedChoice(routing, undefined, {
    spaceId,
    usageClass: 'interactive',
  });
  // A request that cannot start is told why when it would; this is not that.
  if (choice.vision || choice.refused) return true;
  // A model on the person's own machine or network keeps its calls: nothing is rerouted.
  if (await settings.servesLocally(choice.provider)) return false;
  const routes = await settings.attemptRoutes(routing, {
    provider: choice.provider,
    model: choice.model,
    usageClass: 'interactive',
  });
  return routes?.vision !== undefined;
}
