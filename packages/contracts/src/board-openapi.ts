/**
 * The board routes in the OpenAPI document. Kept apart from `openapi.ts` so
 * the board grows in one place.
 */
import { z } from 'zod';
import { errorResponse } from './api.ts';
import {
  boardAnswerRequest,
  boardAnswerResponse,
  boardItemResponse,
  boardList,
  boardQuery,
  boardStreamFrame,
} from './board.ts';

const json = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});
const jsonResponse = <T extends z.ZodType>(description: string, schema: T) => ({
  description,
  ...json(schema),
});
const problem = (description: string) => jsonResponse(description, errorResponse);
const room = { path: z.object({ id: z.string().meta({ description: 'Room id' }) }) };
const item = {
  path: z.object({
    id: z.string().meta({ description: 'Room id' }),
    itemId: z.string().meta({ description: 'Board item id' }),
  }),
};
const notIn = problem('Not in this room, no such room, or no such item the caller may see');

export const boardPaths = () => ({
  '/board': {
    get: {
      tags: ['rooms'],
      summary: 'The board items of every room the signed-in person is in',
      description:
        'Each room contributes what the person may see there: everything for an owner, items for ' +
        'everyone and items assigned to them for a member, items for everyone for a guest. ' +
        '`mine=1` keeps the open and claimed items assigned to them.',
      requestParams: { query: boardQuery },
      responses: { '200': jsonResponse('Items', boardList) },
    },
  },
  '/rooms/{id}/board': {
    get: {
      tags: ['rooms'],
      summary: "A room's board, as the caller may see it",
      requestParams: room,
      responses: { '200': jsonResponse('Items', boardList), '404': notIn },
    },
  },
  '/rooms/{id}/board/events': {
    get: {
      tags: ['rooms'],
      summary: "A room board's live frames: each item as it changes",
      description:
        'With `Accept: text/event-stream`, a stream of frames; otherwise one page. Each frame ' +
        'carries `seq`; resume with `Last-Event-ID`. Only items the reader may see are sent, and ' +
        'the stream closes once the reader is no longer in the room.',
      requestParams: {
        path: z.object({ id: z.string() }),
        query: z.object({ after: z.string().optional() }),
        header: z.object({ 'Last-Event-ID': z.string().optional() }),
      },
      responses: {
        '200': {
          description: 'Frames',
          content: {
            'application/json': {
              schema: z.object({
                frames: z.array(boardStreamFrame),
                next_cursor: z.number().int().nonnegative(),
              }),
            },
            'text/event-stream': {
              schema: z.string(),
              example: 'id: 42\nevent: item\ndata: {"seq":42,"kind":"item"}\n\n',
            },
          },
        },
        '404': notIn,
      },
    },
  },
  '/rooms/{id}/board/{itemId}/claim': {
    post: {
      tags: ['rooms'],
      summary: 'Claim a task or an event',
      description: 'One claim stands. A second claim, at the same moment or later, gets 409.',
      requestParams: item,
      responses: {
        '200': jsonResponse('The claimed item', boardItemResponse),
        '403': problem('A guest, or the item is assigned to someone else'),
        '404': notIn,
        '409': problem('Someone already claimed it, or it is done'),
      },
    },
  },
  '/rooms/{id}/board/{itemId}/done': {
    post: {
      tags: ['rooms'],
      summary: 'Mark an item done',
      requestParams: item,
      responses: {
        '200': jsonResponse('The item', boardItemResponse),
        '403': problem('A guest, or someone else is on it'),
        '404': notIn,
      },
    },
  },
  '/rooms/{id}/board/{itemId}/answer': {
    post: {
      tags: ['rooms'],
      summary: 'Answer a question put to the caller',
      description:
        'The answer is posted in the room as the caller’s own message to the agent, in the thread ' +
        'the question was asked in, and starts a request of theirs. Only the person asked answers.',
      requestParams: item,
      requestBody: json(boardAnswerRequest),
      responses: {
        '200': jsonResponse('The answered item and the message', boardAnswerResponse),
        '403': problem('Someone other than the person asked'),
        '404': notIn,
        '409': problem('Not a question, or already answered'),
      },
    },
  },
});
