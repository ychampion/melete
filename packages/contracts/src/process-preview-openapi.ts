/**
 * The routes for a person's side of background processes, in the OpenAPI
 * document. Kept apart from `openapi.ts` so this surface grows in one place.
 */
import { z } from 'zod';
import { errorResponse } from './api.ts';
import { processOutput, processPreview, processStopped } from './process-preview.ts';

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const jsonResponse = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  ...json(schema),
});
const problem = (description: string) => jsonResponse(description, errorResponse);
const processParam = {
  path: z.object({
    id: z.string().meta({ description: "Process id from the conversation's computer view" }),
  }),
};

export const processPreviewPaths = () => ({
  '/previews/{token}/': {
    get: {
      tags: ['sandbox'],
      summary: 'The page a previewed server answers at its root',
      description:
        'Forwarded to the port the process declared, at its computer\x27s own address, and ' +
        'nowhere else. No session is read and none is sent on: the token in the path is the ' +
        'whole authorisation, checked again on every request. Every response carries ' +
        '`Content-Security-Policy: sandbox ...`, so the page runs with an opaque origin. Only ' +
        'reads are forwarded, with no connection upgrade. A browser asking for it as a page ' +
        'of its own, rather than in a frame, is refused.',
      security: [],
      requestParams: {
        path: z.object({
          token: z.string().meta({ description: 'The preview token' }),
        }),
      },
      responses: {
        '200': {
          description: 'What the server answered',
          content: {
            'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) },
          },
        },
        '400': problem('A live connection was asked for'),
        '403': problem('Opened as a page of its own rather than framed'),
        '404': problem('An unknown, expired or ended preview'),
        '502': problem('The server did not answer, answered too much, or sent the page elsewhere'),
      },
    },
  },
  '/previews/{token}/{path}': {
    get: {
      tags: ['sandbox'],
      summary: 'A page or file from a previewed server',
      description:
        'Forwarded to the port the process declared, at its computer\x27s own address, and ' +
        'nowhere else. No session is read and none is sent on: the token in the path is the ' +
        'whole authorisation, checked again on every request. Every response carries ' +
        '`Content-Security-Policy: sandbox ...`, so the page runs with an opaque origin. Only ' +
        'reads are forwarded, with no connection upgrade. A browser asking for it as a page ' +
        'of its own, rather than in a frame, is refused.',
      security: [],
      requestParams: {
        path: z.object({
          token: z.string().meta({ description: 'The preview token' }),
          path: z.string().meta({ description: 'The path on the server' }),
        }),
      },
      responses: {
        '200': {
          description: 'What the server answered',
          content: {
            'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) },
          },
        },
        '400': problem('A live connection was asked for'),
        '403': problem('Opened as a page of its own rather than framed'),
        '404': problem('An unknown, expired or ended preview'),
        '502': problem('The server did not answer, answered too much, or sent the page elsewhere'),
      },
    },
  },
  '/sandbox/processes/{id}/previews': {
    post: {
      tags: ['sandbox'],
      summary: 'Open a preview of the server a background process runs',
      description:
        'Returns where the page the process serves on its declared port loads for this ' +
        'person. Only the person whose job started the process may open one, from a browser ' +
        'session, while the process runs and listens on that port. The preview belongs to ' +
        'that session and ends when it signs out, when the process stops, or after twelve ' +
        'hours. It is meant to be framed by Melete with ' +
        '`sandbox="allow-scripts allow-forms allow-downloads"`: the page runs with an opaque ' +
        'origin, holds no Melete session, and reaches nothing but that port of that computer. ' +
        'A computer with no network cannot be previewed.',
      requestParams: processParam,
      responses: {
        '200': jsonResponse('A preview', processPreview),
        '403': problem('Asked with an assistant token rather than a browser session'),
        '404': problem('No such process, or this person cannot watch its computer'),
        '409': problem('The process is not running, serves no port, or cannot be reached'),
      },
    },
  },
  '/sandbox/processes/{id}/output': {
    get: {
      tags: ['sandbox'],
      summary: 'The end of what a background process printed',
      requestParams: processParam,
      responses: {
        '200': jsonResponse('Its latest output', processOutput),
        '404': problem('No such process, or this person cannot watch its computer'),
      },
    },
  },
  '/sandbox/processes/{id}/stop': {
    post: {
      tags: ['sandbox'],
      summary: 'Stop a background process',
      description:
        'Sends TERM to the process and everything it started, then KILL after ten seconds. ' +
        'Only the person whose job started it may stop it.',
      requestParams: processParam,
      responses: {
        '200': jsonResponse('How it stands now', processStopped),
        '403': problem('Request origin refused'),
        '404': problem('No such process, or this person cannot watch its computer'),
      },
    },
  },
});
