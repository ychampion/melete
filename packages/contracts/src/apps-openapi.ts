/**
 * The Apps routes in the OpenAPI document. Kept apart from `openapi.ts` so
 * the apps surface grows in one place.
 */
import { z } from 'zod';
import { errorResponse } from './api.ts';
import {
  appCurrentRequest,
  appDeleted,
  appDetail,
  appGrantsRequest,
  appListResponse,
} from './apps.ts';

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const jsonResponse = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  ...json(schema),
});
const problem = (description: string) => jsonResponse(description, errorResponse);
const appParam = {
  path: z.object({ id: z.string().meta({ description: 'App id' }) }),
};

export const appsPaths = () => ({
  '/apps': {
    get: {
      tags: ['apps'],
      summary: 'The apps this person can open, newest change first',
      description:
        'Apps published by this person, and apps others shared with them by name or with ' +
        'everyone who has an account here. `role` says whether they may change it.',
      responses: { '200': jsonResponse('Apps', appListResponse) },
    },
  },
  '/apps/{id}': {
    get: {
      tags: ['apps'],
      summary: 'One app: its current files and data, and for managers its versions and grants',
      requestParams: appParam,
      responses: {
        '200': jsonResponse('App', appDetail),
        '404': problem('No such app, or this person cannot open it'),
      },
    },
    delete: {
      tags: ['apps'],
      summary: 'Delete an app with every version and grant',
      description:
        'Only the person who published the app can delete it. Its files are kept for a ' +
        'grace period while nothing else uses them, then removed.',
      requestParams: appParam,
      responses: {
        '200': jsonResponse('Deleted', appDeleted),
        '403': problem('Not the person who published it'),
        '404': problem('No such app, or this person cannot open it'),
      },
    },
  },
  '/apps/{id}/current': {
    post: {
      tags: ['apps'],
      summary: 'Choose which version of an app people see',
      description:
        'The change is immediate: the next time anyone opens the app, they get this version. ' +
        'The manager makes it from the Apps screen, so it is not asked about first.',
      requestParams: appParam,
      requestBody: json(appCurrentRequest),
      responses: {
        '200': jsonResponse('App', appDetail),
        '400': problem('Invalid request'),
        '403': problem('Not a manager of this app'),
        '404': problem('No such app, or that version is not one of its own'),
      },
    },
  },
  '/apps/{id}/grants': {
    put: {
      tags: ['apps'],
      summary: 'Replace the list of who can open an app',
      description:
        'The list given becomes the whole list. Any change ends every view opened under the ' +
        'old list. People are named by the email of their account on this installation.',
      requestParams: appParam,
      requestBody: json(appGrantsRequest),
      responses: {
        '200': jsonResponse('App', appDetail),
        '400': problem('Invalid request, or an email with no account here'),
        '403': problem('Not a manager of this app'),
        '404': problem('No such app, or this person cannot open it'),
      },
    },
  },
});
