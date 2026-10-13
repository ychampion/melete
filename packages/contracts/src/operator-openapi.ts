/**
 * The operator console's routes in the OpenAPI document. Kept apart from
 * `openapi.ts` so this surface grows in one place. Every route answers the
 * installation's owner alone, from a browser session: 401 without a session
 * (or one a disabled or deleted account held), 403 `guests_use_rooms` to a
 * guest and 403 `owner_required` to anyone else.
 */
import { z } from 'zod';
import { errorResponse } from './api.ts';
import {
  operatorAudit,
  operatorCapsRequest,
  operatorInviteRequest,
  operatorInviteResponse,
  operatorOverview,
  operatorPeople,
  operatorPersonResponse,
  operatorResetResponse,
} from './operator.ts';
import { accountRemoval, accountRemovalPreview, deleteAccountRequest } from './principals.ts';

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const jsonResponse = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  ...json(schema),
});
const problem = (description: string) => jsonResponse(description, errorResponse);
/** A function, so each route's parameter is its own schema in the published document. */
const personParam = () => ({
  path: z.object({ id: z.string().meta({ description: 'Account id' }) }),
});
/** The refusals every operator route shares. */
const refusals = {
  '401': problem('No session, or the session ended'),
  '403': problem('Not the owner of this installation, a guest, or not a browser session'),
};

export const operatorPaths = () => ({
  '/operator/overview': {
    get: {
      tags: ['operator'],
      summary: 'The installation at a glance, for its owner',
      description:
        'Spending this month and today against the installation’s caps, how many people ' +
        'have accounts and how many were active in the last week, agent runs and computers ' +
        'going against their limits, when the newest backup was taken, free disk against ' +
        'its floor, the health checks and the version. Read-only.',
      responses: { '200': jsonResponse('Overview', operatorOverview), ...refusals },
    },
  },
  '/operator/people': {
    get: {
      tags: ['operator'],
      summary: 'Everyone with an account here, with this month’s spending and their caps',
      responses: { '200': jsonResponse('People', operatorPeople), ...refusals },
    },
    post: {
      tags: ['operator'],
      summary: 'Invite someone: a new account and a one-time link to choose a password',
      description:
        'The link is always returned, to pass on by hand, and also emailed when account mail ' +
        'and a web address are set. It works once and expires in 7 days; opening it signs the ' +
        'person straight in once they choose a password.',
      requestBody: json(operatorInviteRequest),
      responses: {
        '201': jsonResponse('Invited', operatorInviteResponse),
        '400': problem('Not an email address'),
        ...refusals,
        '409': problem('Someone already has an account with that email'),
      },
    },
  },
  '/operator/people/{id}/disable': {
    post: {
      tags: ['operator'],
      summary: 'Stop someone signing in, and sign them out everywhere',
      description:
        'Ends their sessions, sign-in and reset links, connected apps, notifications and ' +
        'paired computers. Their routines and data are kept. The owner can’t be disabled.',
      requestParams: personParam(),
      responses: {
        '200': jsonResponse('Disabled', operatorPersonResponse),
        ...refusals,
        '404': problem('No such account, or it is being deleted'),
        '409': problem('The owner’s own account'),
      },
    },
  },
  '/operator/people/{id}/enable': {
    post: {
      tags: ['operator'],
      summary: 'Let a disabled account sign in again',
      requestParams: personParam(),
      responses: {
        '200': jsonResponse('Enabled', operatorPersonResponse),
        ...refusals,
        '404': problem('No such account, or it is being deleted'),
        '409': problem('The owner’s own account'),
      },
    },
  },
  '/operator/people/{id}/password-reset': {
    post: {
      tags: ['operator'],
      summary: 'A one-time link to choose a password: a new invite, or a reset',
      description:
        'Someone who never chose a password gets their invite again (7 days). Anyone else ' +
        'gets a reset link (60 minutes); using it signs them out everywhere. The link is ' +
        'always returned, and also emailed when account mail and a web address are set.',
      requestParams: personParam(),
      responses: {
        '200': jsonResponse('Link', operatorResetResponse),
        ...refusals,
        '404': problem('No such account, or it is being deleted'),
        '409': problem('The account is disabled'),
      },
    },
  },
  '/operator/people/{id}/caps': {
    put: {
      tags: ['operator'],
      summary: 'Set or clear someone’s own spending caps',
      description:
        'All four, each in dollars or null for the installation’s per-person cap. Each has to ' +
        'be more than $0, in whole cents, and at most the installation’s own cap for the ' +
        'period; a day’s cap at most the month’s, and background work at most what the ' +
        'person may spend in all.',
      requestParams: personParam(),
      requestBody: json(operatorCapsRequest),
      responses: {
        '200': jsonResponse('Caps set', operatorPersonResponse),
        '400': problem('A cap outside the installation’s limits (`caps_out_of_range`)'),
        ...refusals,
        '404': problem('No such account, or it is being deleted'),
      },
    },
  },
  '/operator/people/{id}/removal/preview': {
    get: {
      tags: ['operator'],
      summary: 'What deleting someone’s account takes with it',
      requestParams: personParam(),
      responses: {
        '200': jsonResponse('Preview', z.object({ preview: accountRemovalPreview })),
        ...refusals,
        '404': problem('No such account'),
      },
    },
  },
  '/operator/people/{id}': {
    delete: {
      tags: ['operator'],
      summary: 'Delete someone’s account, its email typed to confirm',
      description: 'The account deletion every account has, asked by the installation’s owner.',
      requestParams: personParam(),
      requestBody: json(deleteAccountRequest),
      responses: {
        '202': jsonResponse('Deletion started', z.object({ removal: accountRemoval })),
        '400': problem('The email does not match the account'),
        ...refusals,
        '404': problem('No such account, or it is being deleted'),
        '409': problem('The owner’s own account, or a space the browser worker uses'),
      },
    },
  },
  '/operator/audit': {
    get: {
      tags: ['operator'],
      summary: 'The newest 100 changes made to people’s accounts, newest first',
      description:
        'Who did what to whom, and when: from the operator console or the operator’s ' +
        'command on the host. No link or code is ever kept.',
      responses: { '200': jsonResponse('Changes', operatorAudit), ...refusals },
    },
  },
});
