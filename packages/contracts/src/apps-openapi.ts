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
  appView,
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
  '/apps/{id}/views': {
    post: {
      tags: ['apps'],
      summary: 'Open a view of an app for the person asking',
      description:
        "Returns where the app's current version loads for this person, for the next 15 " +
        'minutes. The page is meant to be framed by Melete with ' +
        '`sandbox="allow-scripts allow-forms allow-downloads"`. A change to who may open the ' +
        'app, or to its version, ends the view at once.',
      requestParams: appParam,
      responses: {
        '200': jsonResponse('A view', appView),
        '404': problem('No such app, or this person cannot open it'),
      },
    },
  },
  '/apps/view/{token}/{path}': {
    get: {
      tags: ['apps'],
      summary: 'One file of an app, as its view loads it',
      description:
        "Raw bytes, typed from the version's manifest. No session is read: the token in the " +
        'path is the whole authorisation, and it is checked again on every request against ' +
        "the app's viewers and current version. Every response carries " +
        '`Content-Security-Policy: sandbox ...`, so the file runs with an opaque origin and ' +
        'can load only its own files. A browser asking for one as a page of its own, rather ' +
        'than in a frame, is refused.',
      security: [],
      requestParams: {
        path: z.object({
          token: z.string().meta({ description: 'The view token' }),
          path: z.string().meta({ description: "A file path in the version's manifest" }),
        }),
      },
      responses: {
        '200': {
          description: 'The file',
          content: {
            'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) },
          },
        },
        '403': problem('Opened as a page of its own rather than framed'),
        '404': problem('An unknown, expired or ended view, or a path the version does not hold'),
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
