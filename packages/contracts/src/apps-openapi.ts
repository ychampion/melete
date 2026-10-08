/**
 * The Apps routes in the OpenAPI document. Kept apart from `openapi.ts` so
 * the apps surface grows in one place.
 */
import { z } from 'zod';
import { errorResponse } from './api.ts';
import {
  appCurrentRequest,
  appDataReleaseRequest,
  appDataUpdates,
  appDataValue,
  appDeleted,
  appDetail,
  appGrantsRequest,
  appListResponse,
  appSubmissionAccepted,
  appSubmissionDeleted,
  appSubmissionList,
  appSubmissionMine,
  appSubmissionRequest,
  appSubmissionsDeleted,
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
        "Returns where the app's current version loads for this person. The view belongs to " +
        'the browser session that asked, and lasts until it signs out, or twelve hours at most. ' +
        'The page is meant to be framed by Melete with ' +
        '`sandbox="allow-scripts allow-forms allow-downloads"`. A change to who may open the ' +
        'app, or to its version, ends the view on its next file request. Only a browser ' +
        'session can open one.',
      requestParams: appParam,
      responses: {
        '200': jsonResponse('A view', appView),
        '403': problem('Asked with an assistant token rather than a browser session'),
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
  '/apps/{id}/data/{name}': {
    get: {
      tags: ['apps'],
      summary: "One of an app's data, for the person viewing it",
      description:
        "The newest version of the file the app's current version names under `name`, read " +
        "from the publisher's conversation in the app's own space. When the publisher reviews " +
        'updates, the newest version they let through. A JSON file is returned parsed, any ' +
        'other text as a string. The app reads it through the page around it, with the ' +
        "viewer's session; the app itself holds no session.",
      requestParams: {
        path: z.object({
          id: z.string().meta({ description: 'App id' }),
          name: z.string().meta({ description: "A data name the app's version declares" }),
        }),
      },
      responses: {
        '200': jsonResponse('The data', appDataValue),
        '404': problem('No such app or data name, or this person cannot open the app'),
        '409': problem('The file is not readable as data: too large, not text, or not JSON'),
      },
    },
  },
  '/apps/{id}/data-updates': {
    get: {
      tags: ['apps'],
      summary: 'New data versions waiting for the publisher to review',
      description:
        'Only for data the publisher chose to review. Each update says what changed: for ' +
        'JSON, the top-level keys added, removed and changed, and the size before and after.',
      requestParams: appParam,
      responses: {
        '200': jsonResponse('Waiting updates', appDataUpdates),
        '403': problem('Not the publisher or the space owner'),
        '404': problem('No such app, or this person cannot open it'),
      },
    },
    post: {
      tags: ['apps'],
      summary: 'Let one new data version through to viewers',
      description:
        'Viewers see that version from their next read. The version must be the newest one ' +
        'written; an older one is refused, so what is let through is what was reviewed.',
      requestParams: appParam,
      requestBody: json(appDataReleaseRequest),
      responses: {
        '200': jsonResponse('Updates still waiting', appDataUpdates),
        '403': problem('Not the publisher or the space owner'),
        '404': problem('No such app or data name, or this person cannot open it'),
        '409': problem('A newer version was written, or the file changed, since it was shown'),
      },
    },
  },
  '/apps/{id}/submissions': {
    post: {
      tags: ['apps'],
      summary: 'Send a response from an app',
      description:
        "Stored with the viewer's account, for a collection the app's current version " +
        'declares. A record is at most the size the collection declares (16 KiB at most). ' +
        'One person may send one app 30 responses a minute, and an app keeps 500 from any ' +
        'one person and 10,000 in all.',
      requestParams: appParam,
      requestBody: json(appSubmissionRequest),
      responses: {
        '200': jsonResponse('Stored', appSubmissionAccepted),
        '400': problem('Invalid request, or a collection the app does not declare'),
        '404': problem('No such app, or this person cannot open it'),
        '413': problem('The record is larger than the collection allows'),
        '429': problem('Too many responses in the last minute, or the app holds its most'),
      },
    },
    get: {
      tags: ['apps'],
      summary: "An app's responses, newest first",
      requestParams: {
        path: z.object({ id: z.string().meta({ description: 'App id' }) }),
        query: z.object({
          collection: z.string().optional().meta({ description: 'Only this collection' }),
          before: z
            .string()
            .optional()
            .meta({ description: 'Responses older than this one, from `next_before`' }),
        }),
      },
      responses: {
        '200': jsonResponse('Responses', appSubmissionList),
        '403': problem('Not a manager of this app'),
        '404': problem('No such app, or this person cannot open it'),
      },
    },
    delete: {
      tags: ['apps'],
      summary: 'Delete every response one person sent an app',
      description: 'Their contents are removed; the app keeps no copy.',
      requestParams: {
        path: z.object({ id: z.string().meta({ description: 'App id' }) }),
        query: z.object({
          from: z.string().meta({ description: 'The account whose responses are deleted' }),
        }),
      },
      responses: {
        '200': jsonResponse('Deleted', appSubmissionsDeleted),
        '400': problem('No account named'),
        '403': problem('Not a manager of this app'),
        '404': problem('No such app, or this person cannot open it'),
      },
    },
  },
  '/apps/{id}/submissions/mine': {
    get: {
      tags: ['apps'],
      summary: 'The newest record the viewer sent in one collection',
      description:
        "What an app kept for this viewer, such as a tracker's ticks, read back when it opens. " +
        "Only the viewer's own records; null when they sent none in that collection.",
      requestParams: {
        path: z.object({ id: z.string().meta({ description: 'App id' }) }),
        query: z.object({
          collection: z.string().meta({ description: 'A collection the app declares' }),
        }),
      },
      responses: {
        '200': jsonResponse('The record, or null', appSubmissionMine),
        '400': problem('No collection, or one the app does not declare'),
        '404': problem('No such app, or this person cannot open it'),
      },
    },
  },
  '/apps/{id}/submissions/{submission_id}': {
    delete: {
      tags: ['apps'],
      summary: 'Delete one response',
      description: 'Its contents are removed; the app keeps no copy.',
      requestParams: {
        path: z.object({
          id: z.string().meta({ description: 'App id' }),
          submission_id: z.string().meta({ description: 'Response id' }),
        }),
      },
      responses: {
        '200': jsonResponse('Deleted', appSubmissionDeleted),
        '403': problem('Not a manager of this app'),
        '404': problem('No such app or response, or this person cannot open the app'),
      },
    },
  },
});
