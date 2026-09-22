/**
 * Generated from packages/contracts/openapi.json by `bun run client:generate`.
 * Do not edit by hand: the sync test compares this file against a fresh run.
 */

export interface paths {
    "/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The action ledger */
        get: {
            parameters: {
                query?: {
                    effect_class?: components["schemas"]["EffectClass"];
                    job_id?: string;
                    limit?: number;
                    status?: components["schemas"]["ActionStatus"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Actions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            actions: components["schemas"]["Action"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/actions/{actionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one action with its receipt and reconciliation record */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Action id */
                    actionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Action */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema292"];
                    };
                };
                /** @description No such action */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/actions/{actionId}/execution/settle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Settle an in-cell command using the capability of its dispatching attempt */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Action id */
                    actionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        record: {
                            capture_limited?: boolean;
                            captured_bytes?: number;
                            command: string;
                            cwd: string;
                            duration_ms: number;
                            exit_code: number | null;
                            /** @enum {string} */
                            language: "shell" | "python";
                            output_bytes: number;
                            output_digest: string;
                            /** @default null */
                            output_path?: string | null;
                            /** @default null */
                            signal?: string | null;
                            /** @default false */
                            timed_out?: boolean;
                            total_bytes?: number;
                            /** @default false */
                            truncated?: boolean;
                        };
                    } | {
                        error: string;
                    };
                };
            };
            responses: {
                /** @description Recorded result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema292"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/actions/{actionId}/execution/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Claim an admitted in-cell command once using its attempt capability */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Action id */
                    actionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Dispatch claim */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            execute: boolean;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/actions/{actionId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Settle an action Melete could not confirm
         * @description Used when verify cannot decide. The owner says what really happened; the answer is recorded as a reconciliation, and the action is never re-dispatched.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Action id */
                    actionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        note?: string;
                        /** @enum {string} */
                        resolution: "succeeded" | "failed" | "unresolved";
                    };
                };
            };
            responses: {
                /** @description Resolved */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema292"];
                    };
                };
                /** @description Action is not awaiting reconciliation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /agents
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            agents: components["schemas"]["__schema163"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        /**
         * POST /agents
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["__schema15"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema174"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * PATCH /agents/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["__schema15"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema174"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/agents/templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /agents/templates
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            templates: {
                                agent: {
                                    allowed_connection_ids: components["schemas"]["__schema171"];
                                    asks_before_acting: components["schemas"]["__schema172"];
                                    colour: components["schemas"]["__schema166"];
                                    eye_colour: components["schemas"]["__schema168"];
                                    face_image?: components["schemas"]["__schema173"];
                                    name: components["schemas"]["__schema164"];
                                    role: components["schemas"]["__schema165"];
                                    standing_instruction: components["schemas"]["__schema170"];
                                    surface: components["schemas"]["__schema167"];
                                    tone: components["schemas"]["__schema169"];
                                };
                                id: components["schemas"]["__schema142"];
                                title: components["schemas"]["__schema143"];
                            }[];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/approvals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Approvals waiting on the owner */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Approvals */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            approvals: {
                                action_id: string;
                                approval_id: string;
                                canonical_payload: components["schemas"]["__schema212"];
                                connection_id: string;
                                effect_class: components["schemas"]["EffectClass"];
                                expires_at: components["schemas"]["__schema95"] | null;
                                job_id: string;
                                job_revision: number;
                                kind: string;
                                /** @default [] */
                                origin_warnings: {
                                    description: string;
                                    field: string;
                                    handle: string | null;
                                    origin_trust: components["schemas"]["__schema223"];
                                }[];
                                payload_hash: components["schemas"]["__schema269"];
                                requested_at: components["schemas"]["__schema95"];
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/approvals/{approvalId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve or deny one action
         * @description The decision binds to the payload hash the person was shown. Editing the draft creates a new action, so an approval can never be spent on different content.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Approval id */
                    approvalId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        decision: "approved" | "denied";
                        note?: string;
                        payload_hash: string;
                    };
                };
            };
            responses: {
                /** @description Decided */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            action_id: string;
                            approval_id: string;
                            decided_at: components["schemas"]["__schema95"];
                            /** @enum {string} */
                            decision: "approved" | "denied";
                            payload_hash: components["schemas"]["__schema269"];
                        };
                    };
                };
                /** @description The payload changed since this approval was requested */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/artifacts/{id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Retrieve an artifact in the authenticated space
         * @description Returns the recorded bytes only while their hash matches the artifact receipt. Audio can be played directly; a single byte range can be requested for seeking.
         */
        get: {
            parameters: {
                query?: never;
                header?: {
                    Range?: string;
                };
                path: {
                    /** @description Artifact id from the action receipt */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Artifact bytes */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/octet-stream": string;
                        "audio/wav": string;
                    };
                };
                /** @description Requested byte range */
                206: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/octet-stream": string;
                        "audio/wav": string;
                    };
                };
                /** @description A session is required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No matching artifact in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Requested range is outside the artifact */
                416: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/attempts/{attemptId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one attempt, including the provider and model actually used */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Attempt id */
                    attemptId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Attempt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            attempt: components["schemas"]["Attempt"];
                        };
                    };
                };
                /** @description No such attempt */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/automations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /automations
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            automations: components["schemas"]["__schema181"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        /**
         * POST /automations
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        agent_id: components["schemas"]["__schema11"];
                        at: string;
                        instruction: components["schemas"]["__schema10"];
                        title: components["schemas"]["__schema10"];
                        weekdays: components["schemas"]["__schema19"][];
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema182"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/automations/{id}/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /automations/{id}/test
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema162"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/automations/morning-brief": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /automations/morning-brief
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        agent_id: components["schemas"]["__schema11"];
                        at: string;
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema182"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /browser/sessions/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema183"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sessions/{id}/control": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /browser/sessions/{id}/control
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        control: "take_control" | "resume" | "stop";
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema183"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sessions/{id}/handback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Return browser control to automation
         * @description Requires the owner session and same-origin protection. Increments the control epoch and requires a fresh observation. The job stays parked until owner input.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Browser session id returned by browser.observe */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Automation requires fresh observation */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BrowserControlResponse"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sessions/{id}/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open a live view of a browser session the person controls
         * @description Requires the owner session, same-origin protection and human control. The live id is held in memory and bound to this principal, session, control epoch and address. One view per session: a second opener is refused while the first may still return.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Browser session id returned by browser.observe */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The live view is open */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["LiveOpen"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The live view could not open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sessions/{id}/live/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close the live view
         * @description Ends the view. Control stays with the person until they hand it back, and a view can be opened again.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Browser session id returned by browser.observe */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["LiveClose"];
                };
            };
            responses: {
                /** @description The live view is closed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["LiveClosed"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The live view was already closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sessions/{id}/live/frames": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Follow one live view as Server-Sent Events
         * @description One event per live message: a JPEG frame, where the page is, a notice, or the end of the view. Only frames carry an id. Nothing is buffered, so a reconnect with `Last-Event-ID` replays nothing and is repainted from the page as it is now.
         */
        get: {
            parameters: {
                query: {
                    /** @description Frame sequence to resume after, for clients without Last-Event-ID */
                    after?: components["schemas"]["__schema67"];
                    /** @description The live id this view was opened with */
                    live_id: components["schemas"]["__schema66"];
                };
                header?: never;
                path: {
                    /** @description Browser session id returned by browser.observe */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The live event stream */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/event-stream": string;
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sessions/{id}/live/input": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send a person's input to the live page
         * @description Page-level mouse, wheel, key, text and touch events only, never a browser protocol method, script or selector. Every event is checked against the control epoch immediately before it reaches the page.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Browser session id returned by browser.observe */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        ack_through: number;
                        events: components["schemas"]["__schema68"][];
                        live_id: components["schemas"]["__schema66"];
                    };
                };
            };
            responses: {
                /** @description Events accepted in order */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["LiveInputResponse"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Input above the rate cap; the view closes */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sessions/{id}/live/scope": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Allow one more site for this takeover
         * @description The person allows a host they navigated to. It holds for this takeover only and is never persisted.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Browser session id returned by browser.observe */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["LiveScope"];
                };
            };
            responses: {
                /** @description The sites this takeover may reach */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["LiveScopeResponse"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The host was refused or the scope is full */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sessions/{id}/takeover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Take human control of a browser session
         * @description Requires the owner session and same-origin protection. The controller increments its epoch before the service parks the job. Already planned inputs are refused.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Browser session id returned by browser.observe */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Human control fenced against automation */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BrowserControlResponse"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the sites this space's browser is signed in to
         * @description One record per registrable domain whose cookies the space's browser profile holds, with when it was last used. The owner of the space alone may read this.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Signed-in sites */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BrowserSiteList"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Not the owner of this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/browser/sites/{domain}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Sign out of one site
         * @description The worker closes the browser, removes that domain's cookies and its origins' storage from the profile, and the record goes with them. The owner of the space alone may do this.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Registrable domain as listed */
                    domain: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The site is forgotten */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BrowserSiteForgotten"];
                    };
                };
                /** @description Not a registrable domain */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Not the owner of this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The browser could not be cleared */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/connection-kinds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the kinds of connection that can be installed and the fields each needs */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Kinds */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            kinds: components["schemas"]["ConnectionKind"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List connections (never includes secrets) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connections */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            connections: components["schemas"]["Connection"][];
                        };
                    };
                };
            };
        };
        put?: never;
        /**
         * Install a mail, CalDAV, calendar feed or HTTP MCP connection without restarting
         * @description The request carries exactly one configuration block. Secrets are sealed on arrival and never returned. The new connection is tested once; the result is in `check`, and a connection that failed its test stays out of every catalog until a later test passes.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        caldav?: {
                            calendar_url?: components["schemas"]["__schema63"];
                            server_url?: components["schemas"]["__schema65"];
                            username: components["schemas"]["__schema64"];
                        };
                        credentials?: {
                            [key: string]: string;
                        };
                        ics?: {
                            /** Format: uri */
                            url: string;
                        };
                        label: string;
                        mail?: {
                            /** Format: email */
                            from?: string;
                            imap: {
                                host: string;
                                port: number;
                                secure: boolean;
                            };
                            inbox?: string;
                            sent?: string;
                            smtp: {
                                host: string;
                                port: number;
                                secure: boolean;
                            };
                            username: string;
                        };
                        mcp?: {
                            allowed_scopes: components["schemas"]["__schema61"][];
                            /** @constant */
                            audience: "owner";
                            id: string;
                            tools: components["schemas"]["__schema62"][];
                            /** Format: uri */
                            url: string;
                        };
                        /** @enum {string} */
                        provider: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp";
                        /** @default [] */
                        scopes?: string[];
                        space_id?: string;
                    };
                };
            };
            responses: {
                /** @description Created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema304"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description MCP installation name already exists */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/connections/{connectionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one connection */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Connection id */
                    connectionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connection */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema304"];
                    };
                };
                /** @description No such connection */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/connections/{connectionId}/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Test a connection now
         * @description Asks the connector whether its destination answers. The result is a fixed code and sentence; it never carries a transport message, an address or a credential.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Connection id */
                    connectionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connection and check */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            check: components["schemas"]["ConnectionCheck"];
                            connection: components["schemas"]["Connection"];
                        };
                    };
                };
                /** @description Space owner required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/connections/{id}/lifecycle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Switch or revoke credentials and fence previous context generations */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Connection id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expected_generation: number;
                        /** @constant */
                        kind: "revoke";
                    } | {
                        expected_generation: number;
                        /** @constant */
                        kind: "switch";
                        secret_ref: string;
                    };
                };
            };
            responses: {
                /** @description New generation */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            connection_id: string;
                            generation: number;
                            policy_generation: number;
                            status: string;
                        };
                    };
                };
                /** @description Generation changed */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /conversations
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            conversations: components["schemas"]["__schema141"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        /**
         * POST /conversations
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        agent_id: components["schemas"]["__schema11"];
                        plan_id?: components["schemas"]["__schema11"];
                        title: components["schemas"]["__schema10"];
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema148"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /conversations/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema148"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/agent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * PATCH /conversations/{id}/agent
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["__schema12"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema148"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/conversations/{id}/cards": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /conversations/{id}/cards
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            cards: components["schemas"]["__schema151"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/drafts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /conversations/{id}/drafts
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            drafts: components["schemas"]["__schema157"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /conversations/{id}/events
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                    since?: number;
                };
                header?: {
                    "Last-Event-ID"?: string;
                };
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            events: {
                                conversation_id: components["schemas"]["__schema142"];
                                created_at: components["schemas"]["__schema146"];
                                item: ({
                                    text: string;
                                    /** @constant */
                                    type: "say";
                                } | {
                                    label: components["schemas"]["__schema143"];
                                    meta: string;
                                    sources: {
                                        app: components["schemas"]["__schema143"];
                                        connection_id: components["schemas"]["__schema142"];
                                        /** @enum {string} */
                                        kind: "event" | "message" | "draft" | "file" | "page" | "task";
                                        title: components["schemas"]["__schema143"];
                                        url?: components["schemas"]["__schema150"];
                                    }[];
                                    /** @constant */
                                    type: "action";
                                } | {
                                    text: components["schemas"]["__schema143"];
                                    /** @constant */
                                    type: "note";
                                } | {
                                    apps: components["schemas"]["__schema143"][];
                                    elapsed_ms: components["schemas"]["__schema149"];
                                    source_count: components["schemas"]["__schema149"];
                                    summary: components["schemas"]["__schema143"];
                                    /** @constant */
                                    type: "done";
                                }) | {
                                    text: string;
                                    /** @constant */
                                    type: "text_delta";
                                } | {
                                    card: components["schemas"]["__schema151"];
                                    /** @constant */
                                    type: "card";
                                } | {
                                    receipt: components["schemas"]["__schema154"];
                                    /** @constant */
                                    type: "receipt";
                                } | {
                                    permission: components["schemas"]["__schema155"];
                                    /** @constant */
                                    type: "permission";
                                } | {
                                    question: components["schemas"]["__schema158"];
                                    /** @constant */
                                    type: "question";
                                } | {
                                    composer: components["schemas"]["__schema145"];
                                    status: components["schemas"]["__schema144"];
                                    /** @constant */
                                    type: "status";
                                };
                                seq: components["schemas"]["__schema149"];
                                turn_id: components["schemas"]["__schema142"] | null;
                            }[];
                            has_more: boolean;
                            next_cursor: components["schemas"]["__schema149"];
                        } | components["schemas"]["__schema147"];
                        /**
                         * @example id: 42
                         *     event: say
                         *     data: {"seq":42}
                         */
                        "text/event-stream": string;
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /conversations/{id}/messages
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            turns: {
                                agent_id: components["schemas"]["__schema142"];
                                answer: string;
                                conversation_id: components["schemas"]["__schema142"];
                                created_at: components["schemas"]["__schema146"];
                                delivery: ("sending" | "queued_offline" | "failed_retry") | null;
                                id: components["schemas"]["__schema142"];
                                status: components["schemas"]["__schema144"];
                                text: string;
                            }[];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        /**
         * POST /conversations/{id}/messages
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        corrects?: components["schemas"]["__schema13"];
                        text: string;
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            receipt: {
                                id: components["schemas"]["__schema142"];
                                received_at: components["schemas"]["__schema146"];
                                /** @enum {string} */
                                status: "accepted" | "failed_retry";
                            };
                            turn_id: components["schemas"]["__schema142"];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /conversations/{id}/pause
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema148"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/receipts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /conversations/{id}/receipts
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            receipts: components["schemas"]["__schema154"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /conversations/{id}/resume
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema148"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /conversations/{id}/stop
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema148"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/drafts/{id}/send": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /drafts/{id}/send
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            draft: components["schemas"]["__schema157"];
                            permission: components["schemas"]["__schema155"] | null;
                            receipt: components["schemas"]["__schema154"] | null;
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/episodes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List unexpired episode evidence in one owned space */
        get: {
            parameters: {
                query: {
                    space_id: components["schemas"]["__schema0"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Episodes */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            episodes: components["schemas"]["__schema90"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/episodes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove episode evidence and dependent procedures */
        delete: {
            parameters: {
                query: {
                    space_id: components["schemas"]["__schema0"];
                };
                header?: never;
                path: {
                    /** @description Episode id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            deleted: true;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/episodes/{id}/propose": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Generate one bounded candidate from corrected evidence */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Episode id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema7"];
                };
            };
            responses: {
                /** @description Candidate */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema96"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The global feed that drives the inbox */
        get: {
            parameters: {
                query?: {
                    after?: components["schemas"]["__schema58"];
                    limit?: components["schemas"]["__schema59"];
                    types?: components["schemas"]["__schema60"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Events */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema263"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/experience/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /experience/connections
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            connections: {
                                /** @enum {string} */
                                access: "read_only" | "draft_only" | "asks_before_acting";
                                app: components["schemas"]["__schema143"];
                                builtin?: boolean;
                                id: components["schemas"]["__schema142"];
                                label: components["schemas"]["__schema143"];
                                /** @enum {string} */
                                status: "available" | "connecting" | "connected" | "error";
                            }[];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/experience/live-data": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /experience/live-data
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            source_connection: components["schemas"]["__schema142"];
                            title: components["schemas"]["__schema143"];
                            updated_at: components["schemas"]["__schema146"];
                            value: components["schemas"]["__schema143"];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/experience/now-playing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /experience/now-playing
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            artist: components["schemas"]["__schema143"];
                            image?: components["schemas"]["__schema150"];
                            playing: boolean;
                            source_connection: components["schemas"]["__schema142"];
                            title: components["schemas"]["__schema143"];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Liveness and dependency check */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Service is up */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            database: "ok" | "unreachable" | "not_configured";
                            runtime_adapter?: string;
                            runtime_supervisor?: ("process" | "docker") | null;
                            /** @enum {string} */
                            status: "ok" | "degraded";
                            time: components["schemas"]["__schema95"];
                            version: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/home": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /home
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            date: components["schemas"]["__schema143"];
                            greeting: components["schemas"]["__schema143"];
                            open_task_count: components["schemas"]["__schema149"];
                            tasks: components["schemas"]["__schema179"][];
                            time_zone: components["schemas"]["__schema143"];
                            upcoming: {
                                connection_id: components["schemas"]["__schema142"];
                                ends_at: components["schemas"]["__schema146"];
                                id: components["schemas"]["__schema142"];
                                starts_at: components["schemas"]["__schema146"];
                                title: components["schemas"]["__schema143"];
                                url?: components["schemas"]["__schema150"];
                            }[] | components["schemas"]["__schema147"];
                            within_day_hours: boolean;
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/events/deliver": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Offer one connection event to the triggers that watch it
         * @description Recorded once per dedup_key; delivering the same key again returns the first sequence number with duplicate set.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        connection_id: string;
                        cursor: string;
                        dedup_key: string;
                        event_name: string;
                        payload: components["schemas"]["__schema30"];
                    };
                };
            };
            responses: {
                /** @description Recorded */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            duplicate: boolean;
                            seq: number;
                        };
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The connection is not active */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List jobs */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                    space_id?: string;
                    state?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Jobs */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            jobs: components["schemas"]["Job"][];
                        };
                    };
                };
            };
        };
        put?: never;
        /**
         * Delegate a responsibility
         * @description The same admission as POST /responsibilities.
         */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description The submission id. The same key with the same input returns the first answer; with different input it is refused with 409. Left out, the service chooses one, returned in the receipt. */
                    "Idempotency-Key"?: components["schemas"]["__schema20"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema21"];
                };
            };
            responses: {
                /** @description A retried submission whose first status was not recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description Accepted, or the same key and input submitted again */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"] | components["schemas"]["__schema114"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"] | components["schemas"]["__schema114"];
                    };
                };
                /** @description No such space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/input": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Submit an input once and receive its durable receipt */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description The submission id. The same key with the same input returns the first answer; with different input it is refused with 409. Left out, the service chooses one, returned in the receipt. */
                    "Idempotency-Key"?: components["schemas"]["__schema20"];
                };
                path: {
                    /** @description Job ID */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema32"];
                };
            };
            responses: {
                /** @description Accepted, or the same key and input submitted again */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"] | components["schemas"]["__schema114"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"] | components["schemas"]["__schema114"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/interventions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record and apply an owner correction or demonstration */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        idempotency_key: string;
                        /** @enum {string} */
                        kind: "correction" | "demonstration" | "takeover";
                        /**
                         * @default unspecified
                         * @enum {string}
                         */
                        signal?: "typed_ordering" | "text_ordering" | "preserve_structure" | "unspecified";
                        text: string;
                    };
                };
            };
            responses: {
                /** @description Intervention episode */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            episode: components["schemas"]["__schema90"];
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/learning-scope": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Register procedure scope before a job attempt begins */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema1"];
                };
            };
            responses: {
                /** @description Scope */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            createdAt: components["schemas"]["__schema95"];
                            inputRefs: string[];
                            jobId: string;
                            scope: components["schemas"]["__schema92"];
                            spaceId: string;
                            templateId: string;
                        };
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Register a durable timer, remote reference or local process */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        due_at?: components["schemas"]["__schema28"];
                        /** @enum {string} */
                        kind: "timer" | "remote_task" | "local_process";
                        operation_key: components["schemas"]["__schema20"];
                        remote_ref?: string;
                        trigger_id?: string;
                    };
                };
            };
            responses: {
                /** @description Registered */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema214"];
                    };
                };
                /** @description Operation key conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark results read and restore the normal checking frequency */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Read */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema185"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/repairs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What was repaired on this responsibility, and what stopped safely
         * @description One entry per action that met a typed connector fault: the classes it met, the decisions the repair policy took, and where it came to rest. `completed` is the only disposition that means the effect happened; every other one is a safe stop and `safe_stop` is true. A schema-drift mapping appears as the proposal it is, with the test it had to pass before anything could use it.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Repairs */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            job_id: string;
                            repairs: {
                                action_id: string;
                                /** @default [] */
                                candidates: {
                                    action_id: string;
                                    connection_id: string;
                                    created_at: components["schemas"]["__schema95"];
                                    /** @default null */
                                    evaluation: {
                                        detail: string;
                                        evaluated_at: components["schemas"]["__schema95"];
                                        passed: boolean;
                                    } | null;
                                    fault_kind: components["schemas"]["__schema274"];
                                    id: string;
                                    job_id: string;
                                    kind: string;
                                    /** @default null */
                                    observed_schema: components["schemas"]["__schema212"] | null;
                                    proposed_mapping: {
                                        [key: string]: string;
                                    };
                                    safe: boolean;
                                    /** @enum {string} */
                                    state: "candidate" | "evaluated" | "applied" | "rejected";
                                    test: {
                                        expected: components["schemas"]["__schema212"];
                                        input: components["schemas"]["__schema212"];
                                        name: string;
                                        operation: string;
                                        /** @default [] */
                                        preserves: {
                                            path: string;
                                            value: string;
                                        }[];
                                    };
                                    updated_at: components["schemas"]["__schema95"];
                                }[];
                                /** @default {} */
                                counters: components["schemas"]["__schema272"];
                                /** @default null */
                                disposition: components["schemas"]["__schema271"] | null;
                                effect_class: components["schemas"]["EffectClass"];
                                /** @default null */
                                intent_key: components["schemas"]["__schema270"] | null;
                                job_id: string;
                                kind: string;
                                payload_hash: components["schemas"]["__schema269"];
                                /** @default null */
                                retry_after_at: components["schemas"]["__schema95"] | null;
                                safe_stop: boolean;
                                status: components["schemas"]["ActionStatus"];
                                /** @default [] */
                                trace: components["schemas"]["__schema273"];
                            }[];
                        };
                    };
                };
                /** @description No such responsibility */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/responsibility": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read visible responsibility status and attention */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Responsibility */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema185"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/scheduling": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Choose scheduling class, importance and unread threshold */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        importance?: components["schemas"]["__schema26"];
                        scheduling_class?: components["schemas"]["__schema25"];
                        unread_threshold?: components["schemas"]["__schema27"];
                    };
                };
            };
            responses: {
                /** @description Updated responsibility */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema185"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/snapshot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Current job and external-effect truth at one event cursor */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Snapshot */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema211"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{id}/triggers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Wake a job on a schedule, a connection event, or a watched condition */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        cron: string;
                        /** @constant */
                        kind: "schedule";
                        timezone: string;
                    } | {
                        connection_id: string;
                        event_name: string;
                        /** @constant */
                        kind: "event";
                        /** @default 300 */
                        poll_seconds?: number;
                    } | {
                        connection_id: string;
                        event_name: string;
                        /** @constant */
                        kind: "watch";
                        /** @default 300 */
                        poll_seconds?: number;
                        predicate: {
                            all: components["schemas"]["__schema57"][];
                        };
                    };
                };
            };
            responses: {
                /** @description Created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            trigger: {
                                created_at: components["schemas"]["__schema95"];
                                cursor: string | null;
                                enabled: boolean;
                                id: string;
                                job_id: string;
                                /** @enum {string} */
                                kind: "schedule" | "event" | "watch";
                                spec: {
                                    cron: string;
                                    /** @constant */
                                    kind: "schedule";
                                    timezone: string;
                                } | {
                                    connection_id: string;
                                    event_name: string;
                                    /** @constant */
                                    kind: "event";
                                    /** @default 300 */
                                    poll_seconds: number;
                                } | {
                                    connection_id: string;
                                    event_name: string;
                                    /** @constant */
                                    kind: "watch";
                                    /** @default 300 */
                                    poll_seconds: number;
                                    predicate: {
                                        all: components["schemas"]["__schema248"][];
                                    };
                                };
                            };
                        };
                    };
                };
                /** @description Invalid schedule, pattern or connection */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The job has finished */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one job */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Job */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema247"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}/attempts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the attempts of a job */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Attempts */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            attempts: components["schemas"]["Attempt"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel a job
         * @description Sets the job to cancelled and bumps the lease epoch. Actions already admitted may still finish; their disposition is recorded honestly and an unknown action is never hidden.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        reason?: string;
                    };
                };
            };
            responses: {
                /** @description Cancelled */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema247"];
                    };
                };
                /** @description Job is already finished */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Replay and follow one job event stream
         * @description Returns JSON when Accept is application/json and a Server-Sent Events stream when it is text/event-stream. Both start after the `after` cursor; `Last-Event-ID` overrides it.
         */
        get: {
            parameters: {
                query?: {
                    after?: components["schemas"]["__schema58"];
                    limit?: components["schemas"]["__schema59"];
                    types?: components["schemas"]["__schema60"];
                };
                header?: never;
                path: {
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Events */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema263"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Answer a question the job is waiting on
         * @description The same admission as POST /jobs/{id}/input.
         */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description The submission id. The same key with the same input returns the first answer; with different input it is refused with 409. Left out, the service chooses one, returned in the receipt. */
                    "Idempotency-Key"?: components["schemas"]["__schema20"];
                };
                path: {
                    /** @description Job id */
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema32"];
                };
            };
            responses: {
                /** @description Accepted, or the same key and input submitted again */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"] | components["schemas"]["__schema114"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"] | components["schemas"]["__schema114"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}/reactions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Every reaction on one job stream, for a client rendering a transcript */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Reactions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema250"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/knowledge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the records of one space
         * @description The catalog of the space the caller is bound to. A space id may be repeated as a query argument and must match; it never selects a different space.
         */
        get: {
            parameters: {
                query?: {
                    space_id?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Records */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            records: {
                                id: string;
                                path: string;
                                status: components["schemas"]["__schema328"];
                                tags: string[];
                                title: string;
                                type: components["schemas"]["__schema327"];
                                updated: string;
                            }[];
                        };
                    };
                };
                /** @description Wrong space */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/knowledge/{recordId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one record with its provenance */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Knowledge record id */
                    recordId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Record */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema329"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Retract or delete a record */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Knowledge record id */
                    recordId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @default false */
                        hard_delete?: boolean;
                        reason: string;
                    };
                };
            };
            responses: {
                /** @description Record */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema329"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/knowledge/{recordId}/edit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Ingest an owner edit as a protected correction */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Claim id */
                    recordId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        body: string;
                        expected_revision: components["schemas"]["__schema34"];
                        frontmatter: components["schemas"]["KnowledgeFrontmatter"];
                        idempotency_key: components["schemas"]["__schema33"];
                    };
                };
            };
            responses: {
                /** @description Protected revision */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema232"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/knowledge/proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List pending memory proposal diffs */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Proposals */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            proposals: components["schemas"]["__schema244"][];
                        };
                    };
                };
            };
        };
        put?: never;
        /**
         * Propose a knowledge write
         * @description The only write path an agent has. The proposal is validated and rendered as a diff the owner applies or discards; applying is a git commit.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        body: string;
                        frontmatter: components["schemas"]["KnowledgeFrontmatter"];
                        path: string;
                        rationale: string;
                        space: string;
                    };
                };
            };
            responses: {
                /** @description Proposal */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            diff: string;
                            path: string;
                            proposal_id: string;
                        };
                    };
                };
                /** @description The record failed lint */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/knowledge/proposals/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Discard a pending proposal */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Proposal id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Discarded proposal */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema244"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/knowledge/proposals/{id}/apply": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Validate and apply an owner-reviewed memory proposal */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Proposal id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Applied proposal */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema244"];
                    };
                };
                /** @description Proposal is stale */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/knowledge/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search one space
         * @description Retrieval is scoped to exactly one space by the handle the caller holds, not by a filter argument. Retracted records are never returned.
         */
        get: {
            parameters: {
                query: {
                    include_retracted?: boolean;
                    limit?: number;
                    q: string;
                    space_id: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Hits */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            hits: {
                                excerpt: string;
                                id: string;
                                path: string;
                                score: number;
                                status: components["schemas"]["__schema328"];
                                title: string;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ledger/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One item, its company, and the message text its quotes index into */
        get: {
            parameters: {
                query?: {
                    /** @description Narrows the lookup to one space */
                    space_id?: components["schemas"]["__schema75"];
                };
                header?: never;
                path: {
                    /** @description Ledger item id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Item and evidence */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            company: components["schemas"]["__schema365"];
                            item: components["schemas"]["__schema368"];
                            message: {
                                from: string;
                                id: string;
                                received_at: string;
                                subject: string;
                                text: string;
                            } | null;
                        };
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Drop an item, or mark it settled */
        patch: {
            parameters: {
                query?: {
                    space_id?: string;
                };
                header?: never;
                path: {
                    /** @description Ledger item id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "dropped" | "settled";
                    };
                };
            };
            responses: {
                /** @description The item as it now stands */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema368"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/ledger/{id}/handle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start the job that handles this item
         * @description Creates the job that runs the item’s playbook. Any message it sends goes through the existing approval path; this route starts the work, it does not send.
         */
        post: {
            parameters: {
                query?: {
                    space_id?: string;
                };
                header?: never;
                path: {
                    /** @description Ledger item id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Already being handled, by the job named here */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            job_id: string;
                        };
                    };
                };
                /** @description The job now handling it */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            job_id: string;
                        };
                    };
                };
                /** @description Nothing ships yet that handles this kind of item on its own */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Already finished, or no longer quotable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Handling is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign in with an email and a password
         * @description Sets a new melete_session cookie and the melete_device cookie. Attempts are limited per client address, per account and per known device; an unknown email gets the same 401 as a wrong password.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema56"];
                };
            };
            responses: {
                /** @description Signed in */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema245"];
                    };
                };
                /** @description An email and a password of 8 to 1024 characters are required */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The email or the password is wrong */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The request came from another origin */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Too many sign-in attempts */
                429: {
                    headers: {
                        /** @description Seconds to wait before the next attempt */
                        "Retry-After": string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No database is configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The account this session belongs to */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The signed-in account */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema245"];
                    };
                };
                /** @description No session, or the session has expired */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/attribution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Report payload values that came from an uncited delivered item
         * @description The check the broker runs before admitting a write_external or spend: any recipient, date, amount or identifier in the payload that appears in a delivered item whose handle is not in the manifest is reported.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        delivered: components["schemas"]["__schema38"][];
                        payload: components["schemas"]["__schema30"];
                        uses: components["schemas"]["__schema37"];
                    };
                };
            };
            responses: {
                /** @description Attribution findings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            attributed: boolean;
                            findings: components["schemas"]["__schema239"][];
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/claims": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Inspect current claims and their support */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Claims */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            claims: {
                                audience: components["schemas"]["__schema221"];
                                current: components["schemas"]["__schema232"];
                                domain_key: components["schemas"]["__schema219"];
                                head_revision: components["schemas"]["__schema220"];
                                hidden: components["schemas"]["__schema236"];
                                id: components["schemas"]["__schema225"];
                                key: components["schemas"]["__schema235"];
                                space_id: components["schemas"]["__schema234"];
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/claims/{id}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Inspect dated claim revisions and their support */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Claim id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Claim history */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            claim: {
                                audience: components["schemas"]["__schema221"];
                                domain_key: components["schemas"]["__schema219"];
                                head_revision: components["schemas"]["__schema220"];
                                hidden: components["schemas"]["__schema236"];
                                id: components["schemas"]["__schema225"];
                                key: components["schemas"]["__schema235"];
                                space_id: components["schemas"]["__schema234"];
                            };
                            revisions: components["schemas"]["__schema232"][];
                        };
                    };
                };
                /** @description No such claim */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/contradictions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List keys with more than one candidate head */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Contradictions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            contradictions: {
                                alternative: components["schemas"]["__schema226"];
                                /** @enum {string} */
                                audience: "private" | "space" | "public";
                                claim_id: string;
                                head: components["schemas"]["__schema226"];
                                id: components["schemas"]["__schema237"];
                                key: components["schemas"]["__schema227"];
                                question_id: components["schemas"]["__schema237"] | null;
                                recorded_at: components["schemas"]["__schema95"];
                                space_id: string;
                                /** @enum {string} */
                                state: "open" | "resolved";
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/corrections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Immediately publish a protected owner correction */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        claim_id: components["schemas"]["__schema35"];
                        content: string;
                        expected_revision: components["schemas"]["__schema34"];
                        idempotency_key: components["schemas"]["__schema33"];
                        text: string;
                        valid_from: components["schemas"]["__schema28"];
                        /** @default null */
                        valid_until?: components["schemas"]["__schema28"] | null;
                    };
                };
            };
            responses: {
                /** @description Protected revision */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema232"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/forget": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Suppress memory use and automatic reconstruction from covered evidence */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        all?: true;
                        claim_id?: components["schemas"]["__schema35"];
                    };
                };
            };
            responses: {
                /** @description Restriction and cleanup state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema233"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/items": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/items
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["__schema175"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        /**
         * POST /memory/items
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        key: components["schemas"]["__schema16"];
                        statement?: string;
                        value: string;
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            item: components["schemas"]["__schema175"];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/items/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * DELETE /memory/items/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema162"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /**
         * PATCH /memory/items/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        value: string;
                        version: components["schemas"]["__schema11"];
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema162"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/memory/items/{id}/why": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/items/{id}/why
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            output: string | null;
                            reasons: components["schemas"]["__schema143"][];
                            used_at: components["schemas"]["__schema146"] | null;
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/jobs/{id}/repair-briefs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the repair briefs a correction wrote on a responsibility */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Job id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Repair briefs */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            repair_briefs: {
                                affected: components["schemas"]["__schema243"][];
                                changed_handle: components["schemas"]["__schema226"];
                                created_at: components["schemas"]["__schema95"];
                                id: components["schemas"]["__schema237"];
                                job_id: string;
                                key: components["schemas"]["__schema227"] | null;
                                new_value: components["schemas"]["__schema242"];
                                old_value: components["schemas"]["__schema242"];
                                replacement_handle: components["schemas"]["__schema226"] | null;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/outputs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Declare which recalled revisions an output used
         * @description A draft, a plan step or a proposed action names the handles it used. A correction then invalidates exactly the outputs that cited the superseded revision, and an output with an empty manifest is recorded as unattributed and keeps the conservative rule.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @default null */
                        attempt_id?: string | null;
                        job_id: string;
                        /** @enum {string} */
                        kind: "artifact" | "plan_step" | "action";
                        /** @default null */
                        location?: string | null;
                        output_id: components["schemas"]["__schema36"];
                        output_version: components["schemas"]["__schema36"];
                        uses: components["schemas"]["__schema37"];
                    };
                };
            };
            responses: {
                /** @description Recorded attribution */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            attributed: boolean;
                            output_id: components["schemas"]["__schema237"];
                            output_version: components["schemas"]["__schema237"];
                            unknown_handles: components["schemas"]["__schema238"][];
                        };
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/questions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List queued owner questions about contradicted keys */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Questions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            questions: {
                                because: components["schemas"]["__schema226"][];
                                created_at: components["schemas"]["__schema95"];
                                id: components["schemas"]["__schema237"];
                                if_ignored: string;
                                key: components["schemas"]["__schema227"];
                                question: string;
                                space_id: string;
                                /** @enum {string} */
                                state: "queued" | "answered" | "withdrawn";
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/recall": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Recall current or historical evidence in the authenticated audience */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        at?: components["schemas"]["__schema28"];
                        job_id?: string;
                        /** @default 10 */
                        limit?: components["schemas"]["__schema34"];
                        /** @default 2000 */
                        max_tokens?: components["schemas"]["__schema34"];
                        /**
                         * @default current
                         * @enum {string}
                         */
                        mode?: "current" | "historical";
                        /**
                         * @default ordinary
                         * @enum {string}
                         */
                        path?: "ordinary" | "investigative";
                        query: string;
                    };
                };
            };
            responses: {
                /** @description Recall and coverage */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            coverage: {
                                authoritative_revision: components["schemas"]["__schema222"];
                                indexed_revision: components["schemas"]["__schema222"];
                                /** @enum {string} */
                                reason: "ready" | "index_lag" | "budget" | "timeout" | "index_failure" | "restore_pending" | "public_compartment";
                                supplemented: components["schemas"]["__schema222"];
                                truncated: boolean;
                            };
                            /** @default [] */
                            disputed_keys: components["schemas"]["__schema227"][];
                            index_generation: components["schemas"]["__schema222"] | null;
                            items: {
                                claim_id: components["schemas"]["__schema225"];
                                content: string;
                                /** @default false */
                                disputed: boolean;
                                domain_key: components["schemas"]["__schema219"];
                                excerpts: string[];
                                factual_status: components["schemas"]["__schema229"];
                                handle: components["schemas"]["__schema226"];
                                /** @default null */
                                key: components["schemas"]["__schema227"] | null;
                                kind: components["schemas"]["__schema228"];
                                /** @default inferred */
                                origin_trust: components["schemas"]["__schema223"];
                                recorded_at: components["schemas"]["__schema95"];
                                revision: components["schemas"]["__schema220"];
                                sources: components["schemas"]["__schema231"][];
                                status: components["schemas"]["__schema230"];
                                superseded_at: components["schemas"]["__schema95"] | null;
                                valid_from: components["schemas"]["__schema95"];
                                valid_until: components["schemas"]["__schema95"] | null;
                            }[];
                            recipe: components["schemas"]["__schema219"];
                            snapshot: components["schemas"]["__schema224"] | null;
                            /** @enum {string} */
                            status: "complete" | "degraded" | "unavailable";
                            token_budget: {
                                /** @constant */
                                counter: "utf8-bytes-upper-bound-v1";
                                limit: components["schemas"]["__schema220"];
                                used: components["schemas"]["__schema222"];
                            };
                        };
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/rejections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List extraction proposals rejected by structural validation, with reasons */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Rejected proposals */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            rejected: {
                                detail: string;
                                index: number;
                                key: string | null;
                                /** @enum {string} */
                                reason: "key_not_in_registry" | "span_not_verbatim" | "span_outside_segment" | "value_not_in_evidence" | "date_not_parseable" | "value_not_well_formed" | "confidence_is_not_a_status" | "checked_status_requires_tier0";
                                recorded_at: components["schemas"]["__schema95"];
                                work_id: components["schemas"]["__schema237"];
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Persist authenticated evidence and durable extraction work */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /**
                         * @default owner
                         * @enum {string}
                         */
                        author?: "owner" | "external";
                        event_at: components["schemas"]["__schema28"];
                        source_identity: components["schemas"]["__schema33"];
                        /** @enum {string} */
                        source_type: "message" | "document" | "observation" | "receipt" | "assistant";
                        source_version: components["schemas"]["__schema33"];
                        stream: components["schemas"]["__schema33"];
                        text: string;
                        time_zone?: string;
                    };
                };
            };
            responses: {
                /** @description Committed stream sequence */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            committed_sequence: components["schemas"]["__schema220"];
                            duplicate: boolean;
                            source: components["schemas"]["__schema217"];
                        };
                    };
                };
                /** @description Invalid evidence */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/sources/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Inspect accessible source evidence with suppressed spans masked */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Source id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Source evidence */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            source: components["schemas"]["__schema217"];
                            text: string;
                        };
                    };
                };
                /** @description No accessible source */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Delete an imported source and invalidate its descendants */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Source id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Restriction and cleanup state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema233"];
                    };
                };
                /** @description No such source */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/trust": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve the origin trust of each field of a canonical payload */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        handles: components["schemas"]["__schema37"];
                        payload: components["schemas"]["__schema30"];
                    };
                };
            };
            responses: {
                /** @description Per-field origin */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            actionable: boolean;
                            fields: components["schemas"]["__schema240"][];
                            minimum_trust: components["schemas"]["__schema223"];
                            unresolved: components["schemas"]["__schema241"][];
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/messages/{messageId}/reactions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The reactions drawn on one message */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Message id: the event seq */
                    messageId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Reactions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema250"];
                    };
                };
            };
        };
        put?: never;
        /**
         * React to a message with one emoji
         * @description A message is an event, and its id is that event seq. The reaction is persisted and streamed like any other event, and a client draws it on the message bubble rather than as a row of its own. A thumbs-down from a person counts the result it lands on as two unread ones; a thumbs-up clears the unread streak. Reacting twice with the same emoji records one reaction.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Message id: the event seq */
                    messageId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        emoji: string;
                    };
                };
            };
            responses: {
                /** @description Recorded */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            reaction: components["schemas"]["__schema249"];
                        };
                    };
                };
                /** @description No such message */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description That event is not a message */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-providers/{provider}/sign-in": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one provider’s sign-in state */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: components["schemas"]["__schema76"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Sign-in state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema370"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Start signing the installation in to a model provider
         * @description A device sign-in answers with a code to enter at the provider’s verification page. A browser sign-in answers with an address to open; the provider then sends the browser to `redirect_uri`, and that whole address is passed to complete. A newer start for the same provider replaces an unfinished one; either expires after fifteen minutes.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: components["schemas"]["__schema76"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description `device` shows a code to enter at the provider; `browser` returns an address to open, after which the address the browser was sent back to is pasted into complete. Left out, the provider’s first method. */
                        method?: components["schemas"]["__schema77"];
                    };
                };
            };
            responses: {
                /** @description Started */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            expires_at: components["schemas"]["__schema95"];
                            /** @description Seconds between completion checks */
                            interval: number;
                            /** @constant */
                            method: "device";
                            sign_in_id: string;
                            user_code: string;
                            /** Format: uri */
                            verification_url: string;
                        } | {
                            /** Format: uri */
                            authorize_url: string;
                            expires_at: components["schemas"]["__schema95"];
                            /** @constant */
                            method: "browser";
                            /** Format: uri */
                            redirect_uri: string;
                            sign_in_id: string;
                        };
                    };
                };
                /** @description Invalid request, or a method this provider does not offer */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The provider could not be reached or refused the request */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        /** Sign out: remove the sealed tokens and ask the provider to revoke them */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: components["schemas"]["__schema76"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Signed out */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema370"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-providers/{provider}/sign-in/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish a sign-in
         * @description A browser sign-in is finished once, with the address the browser was sent back to. A device sign-in is checked with the provider at most once per `interval` and answers 202 until the code has been entered.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: components["schemas"]["__schema76"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description For a browser sign-in: the whole address the provider sent the browser back to. Its state must match the sign-in it completes. */
                        callback_url?: components["schemas"]["__schema78"];
                        sign_in_id: string;
                    };
                };
            };
            responses: {
                /** @description Signed in */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema370"];
                    };
                };
                /** @description The code has not been entered yet */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            interval: number;
                            /** @constant */
                            state: "pending";
                        };
                    };
                };
                /** @description The address is not the one sent, or its state does not match */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No unfinished sign-in by that id */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The provider could not be reached or refused the code */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-providers/sign-in": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the model providers the owner can sign in to, and each one’s state */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Sign-in states */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            providers: components["schemas"]["__schema370"][];
                        };
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set, so nothing can be sealed */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the pending notification outbox */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Pending deliveries */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            notifications: components["schemas"]["__schema216"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notifications/{id}/attempt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record a notification delivery attempt */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Notification ID */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Delivery attempt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema216"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notifications/{id}/delivered": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Acknowledge delivery of the exact notification content */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Notification ID */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        content_hash: string;
                    };
                };
            };
            responses: {
                /** @description Delivered notification */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema216"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List durable background operations and their recovery dispositions */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Operations */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            operations: components["schemas"]["__schema214"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/operations/{id}/claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Claim ready operation work */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Operation id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        version: components["schemas"]["__schema29"];
                    };
                };
            };
            responses: {
                /** @description Claimed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema214"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/operations/{id}/rearm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rearm a currently owned live operation */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Operation id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        due_at: components["schemas"]["__schema28"];
                        version: components["schemas"]["__schema29"];
                    };
                };
            };
            responses: {
                /** @description Registered */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema214"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/operations/{id}/settle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Persist an operation result */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Operation id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        result: components["schemas"]["__schema30"];
                        version: components["schemas"]["__schema29"];
                    };
                };
            };
            responses: {
                /** @description Settled */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema214"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/permissions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /permissions
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            permissions: components["schemas"]["__schema155"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/permissions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /permissions/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @constant */
                        option: "allow_once";
                        version: components["schemas"]["__schema11"];
                    } | {
                        bounds: {
                            count_cap: number;
                            expires_at: components["schemas"]["__schema14"];
                            reconsent_after_days: number;
                        };
                        /** @constant */
                        option: "always";
                        version: components["schemas"]["__schema11"];
                    } | {
                        /** @constant */
                        option: "deny";
                        version: components["schemas"]["__schema11"];
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            option: "allow_once" | "always" | "deny";
                            rule: components["schemas"]["__schema161"] | null;
                            /** @constant */
                            status: "ok";
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /plans
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            plans: components["schemas"]["__schema176"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        /**
         * POST /plans
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        category: components["schemas"]["__schema10"];
                        milestones: components["schemas"]["__schema17"][];
                        title: components["schemas"]["__schema10"];
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema177"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/plans/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /plans/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema177"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/plans/{id}/conversation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /plans/{id}/conversation
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["__schema12"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema148"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/plans/{id}/milestones/{milestoneId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * PATCH /plans/{id}/milestones/{milestoneId}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    milestoneId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        done: boolean;
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema177"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/plans/{id}/share": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /plans/{id}/share
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema147"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/principals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Provision an additional account as the setup owner */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: email */
                        email: string;
                        password: string;
                    };
                };
            };
            responses: {
                /** @description Principal created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            principal: {
                                created_at: components["schemas"]["__schema95"];
                                /** Format: email */
                                email: string;
                                id: string;
                            };
                        };
                    };
                };
                /** @description Setup owner required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Email already registered */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/procedures": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List scoped procedures including qualified rejection history */
        get: {
            parameters: {
                query: {
                    space_id: components["schemas"]["__schema0"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Procedures */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            procedures: components["schemas"]["__schema97"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/procedures/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Inspect procedure history and evaluation costs */
        get: {
            parameters: {
                query: {
                    space_id: components["schemas"]["__schema0"];
                };
                header?: never;
                path: {
                    /** @description Procedure id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Procedure evidence summary */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema113"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/procedures/{id}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Activate after a private canary with explicit private or shared-space delivery */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Procedure id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /**
                         * @default private
                         * @enum {string}
                         */
                        scope?: "private" | "space";
                        space_id: components["schemas"]["__schema8"];
                    };
                };
            };
            responses: {
                /** @description Active procedure */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema96"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/procedures/{id}/canary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Enable a passing procedure in its origin space */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Procedure id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema7"];
                };
            };
            responses: {
                /** @description Canary procedure */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema96"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/procedures/{id}/evaluate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Run bounded validation and then sealed final evaluation */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Procedure id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema7"];
                };
            };
            responses: {
                /** @description Evaluation result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema113"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/procedures/{id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Keep a candidate as rejected history with an owner reason */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Procedure id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema9"];
                };
            };
            responses: {
                /** @description Rejected history */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema96"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/procedures/{id}/rollback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revert delivery of a canary or active procedure */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Procedure id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema9"];
                };
            };
            responses: {
                /** @description Reverted procedure */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema96"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/procedures/{id}/trial": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Try a procedure privately after approving its exact definition */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Procedure id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        definition_hash: string;
                        space_id: components["schemas"]["__schema8"];
                    };
                };
            };
            responses: {
                /** @description Procedure on owner trial */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema96"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /profile
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema178"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * PATCH /profile
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        day_hours: {
                            end: string;
                            start: string;
                        };
                        name: string;
                        time_zone: string;
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema178"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/questions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the one owner question queue across every responsibility
         * @description One entry per responsibility, ordered by what blocks an external effect, then the nearest deadline, then the oldest. Each entry carries why it is being asked and what happens if it is ignored.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Open questions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            questions: components["schemas"]["__schema210"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/questions/{id}/answer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Answer one question and wake the responsibility that asked it */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Question id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        choice?: string;
                        text: string;
                    };
                };
            };
            responses: {
                /** @description Answer delivered as input */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error?: components["schemas"]["__schema115"];
                            job: components["schemas"]["__schema185"] | null;
                            question: components["schemas"]["__schema210"];
                            receipt: components["schemas"]["__schema207"] | null;
                        };
                    };
                };
                /** @description The question is no longer open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/quick-answers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /quick-answers
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            questions: components["schemas"]["__schema158"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/quick-answers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /quick-answers/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        option_id: components["schemas"]["__schema11"];
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema162"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/receipts/{id}/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /receipts/{id}/undo
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            receipt: components["schemas"]["__schema154"];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/removals/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A removal, including one whose space is gone
         * @description Answered only to the person who asked for the removal.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Removal id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Removal and its account */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            removal: components["schemas"]["SpaceRemoval"];
                            report: components["schemas"]["SpaceRemovalReport"];
                        };
                    };
                };
                /** @description Removal not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/reply-obligations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List replies still owed to the owner */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outstanding reply obligations */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            obligations: components["schemas"]["__schema215"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/reply-obligations/{id}/acknowledge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Acknowledge acceptance without claiming reply delivery */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Reply obligation ID */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Acknowledged obligation */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema215"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/responsibilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Accept a responsibility with scheduling and attention preferences */
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description The submission id. The same key with the same input returns the first answer; with different input it is refused with 409. Left out, the service chooses one, returned in the receipt. */
                    "Idempotency-Key"?: components["schemas"]["__schema20"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema21"];
                };
            };
            responses: {
                /** @description A retried submission whose first status was not recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description Accepted, or the same key and input submitted again */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"] | components["schemas"]["__schema114"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"] | components["schemas"]["__schema114"];
                    };
                };
                /** @description No such space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema184"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /rules
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            rules: components["schemas"]["__schema161"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rules/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * DELETE /rules/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema162"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /search
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query: {
                    q: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            results: {
                                conversation_id: components["schemas"]["__schema142"] | null;
                                id: components["schemas"]["__schema142"];
                                /** @enum {string} */
                                kind: "conversation" | "plan" | "task" | "event" | "connection" | "action";
                                meta: string;
                                title: components["schemas"]["__schema143"];
                            }[];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/setup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create the owner, their personal space and a session, once
         * @description Sets the melete_session cookie, and the melete_device cookie that marks this browser as known for sign-in limits. Once an owner exists the answer is 409 before anything is parsed.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema56"];
                };
            };
            responses: {
                /** @description The owner, signed in */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema245"];
                    };
                };
                /** @description An email and a password of 8 to 1024 characters are required */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The request came from another origin */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The owner is already set up */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Too many setup attempts from this address */
                429: {
                    headers: {
                        /** @description Seconds to wait before the next attempt */
                        "Retry-After": string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No database is configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/signin/apple": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /signin/apple
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema147"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/signin/google": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /signin/google
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema147"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/signin/magic-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /signin/magic-link
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: email */
                        email: string;
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema162"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/signin/magic-link/consume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /signin/magic-link/consume
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        token: string;
                    };
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema162"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/signout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /signout
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema162"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List built-in and space skills */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Skills */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            skills: {
                                enabled: boolean;
                                frontmatter: {
                                    audience?: ("private" | "space" | "public") | string;
                                    description: string;
                                    /** @default 400 */
                                    max_tokens: number;
                                    name: string;
                                    /** @default [] */
                                    tools: string[];
                                    triggers: components["schemas"]["__schema344"][];
                                };
                                id: string;
                                path: string;
                                space_id: string | null;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/snapshot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Current state for an explicit event-stream resync */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Snapshot */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema211"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List spaces */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Spaces */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema246"];
                    };
                };
            };
        };
        put?: never;
        /** Create a space */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema246"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove a space, or empty a personal one
         * @description The name must be typed exactly as it is shown. The space is closed at once, in this request; everything in it is then cleared in the background, and the removal is complete only after a final count finds nothing left. A personal space keeps its id and is emptied. Asking again while a removal runs returns that removal.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Space id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        confirm_name: string;
                    };
                };
            };
            responses: {
                /** @description Removal started */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            removal: components["schemas"]["SpaceRemoval"];
                        };
                    };
                };
                /** @description The name does not match the space */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description Space owner required, or no such space */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description The browser worker uses this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/{id}/memberships": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Grant membership or regrant with a fresh generation */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Shared space id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        principal_id: string;
                    };
                };
            };
            responses: {
                /** @description Membership */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            membership: components["schemas"]["__schema122"];
                        };
                    };
                };
                /** @description Space owner required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/{id}/memberships/{principalId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke membership, advance context generation and fence work */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    principalId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Membership revoked */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            membership: components["schemas"]["__schema122"];
                            policy_generation: number;
                        };
                    };
                };
                /** @description Space owner required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/{id}/policy-generation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Advance policy and restart attempts with fresh context */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Space id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expected_generation: number;
                    };
                };
            };
            responses: {
                /** @description Policy generation */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            policy_generation: number;
                            space_id: string;
                        };
                    };
                };
                /** @description Generation changed */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/{id}/removal": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** How far the removal of a space has got */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Space id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Removal and its account so far */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            removal: components["schemas"]["SpaceRemoval"];
                            report: components["schemas"]["SpaceRemovalReport"];
                        };
                    };
                };
                /** @description This space is not being removed, or not by the person asking */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/{id}/removal/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** What removing a space clears, what it does not reach, and the name to type */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Space id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Preview */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            preview: components["schemas"]["SpaceRemovalPreview"];
                        };
                    };
                };
                /** @description Space owner required, or no such space */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/{spaceId}/companies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Every company in this person’s life, with the ledger behind each figure */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Space id */
                    spaceId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The company map */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            companies: components["schemas"]["__schema365"][];
                            currency: components["schemas"]["__schema367"];
                            items: components["schemas"]["__schema368"][];
                            totals: {
                                data_holders: number;
                                monthly_spend_minor: components["schemas"]["__schema366"];
                                owed_to_you_minor: components["schemas"]["__schema366"];
                                price_rises: number;
                                promises_in_force: number;
                                promises_lapsed: number;
                                renewals_next_30d: number;
                                trials_ending: number;
                            };
                        };
                    };
                };
                /** @description This space is not accessible to the signed-in account */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/{spaceId}/companies/scan": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Read the connected mailbox and rebuild the company map
         * @description Idempotent while a scan is running: a second request returns the scan already under way rather than reading the mailbox twice.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Space id */
                    spaceId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A scan was already running */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            scan_id: string;
                            /** @constant */
                            status: "running";
                        };
                    };
                };
                /** @description Scan started */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            scan_id: string;
                            /** @constant */
                            status: "running";
                        };
                    };
                };
                /** @description This space is not accessible to the signed-in account */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No mailbox is connected to this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/{spaceId}/companies/scan/{scanId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** How far one scan has got */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Scan id */
                    scanId: string;
                    /** @description Space id */
                    spaceId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Scan progress */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error?: string;
                            items_found: number;
                            messages_seen: number;
                            /** @enum {string} */
                            status: "running" | "done" | "failed";
                        };
                    };
                };
                /** @description This space is not accessible to the signed-in account */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
                /** @description No such scan in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema114"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/spaces/shared": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a shared space owned by the authenticated principal */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Shared space created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            space: components["schemas"]["Space"];
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/submissions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Look up a durable submission receipt after losing a reply */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Client idempotency key or server ULID */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Acceptance, rejection, or unknown durability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            receipt: components["schemas"]["__schema207"];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /tasks
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            tasks: components["schemas"]["__schema179"][];
                        } | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        put?: never;
        /**
         * POST /tasks
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["__schema18"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema180"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tasks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * DELETE /tasks/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema162"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /**
         * PATCH /tasks/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["__schema18"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema180"] | components["schemas"]["__schema147"];
                    };
                };
            };
        };
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        __schema0: string;
        __schema1: {
            input_refs?: components["schemas"]["__schema4"];
            scope: components["schemas"]["__schema2"];
            template_id: components["schemas"]["__schema3"];
        };
        __schema2: {
            app: components["schemas"]["__schema3"];
            app_version: components["schemas"]["__schema3"];
            /** @constant */
            audience: "private";
            /** @constant */
            role: "owner";
            task_family: components["schemas"]["__schema3"];
        };
        __schema3: string;
        /** @default [] */
        __schema4: components["schemas"]["__schema5"][];
        __schema5: components["schemas"]["__schema6"] | string;
        __schema6: string;
        __schema7: {
            space_id: components["schemas"]["__schema8"];
        };
        __schema8: string;
        __schema9: {
            reason: string;
            space_id: components["schemas"]["__schema8"];
        };
        __schema10: string;
        __schema11: string;
        __schema12: {
            agent_id: components["schemas"]["__schema11"];
        };
        __schema13: string;
        /** Format: date-time */
        __schema14: string;
        __schema15: {
            allowed_connection_ids: components["schemas"]["__schema11"][];
            asks_before_acting: boolean;
            colour: string;
            eye_colour: string;
            /** Format: uri */
            face_image?: string;
            name: string;
            role: string;
            standing_instruction: string;
            /** @enum {string} */
            surface: "rounded" | "blob" | "diamond" | "octagon" | "gear";
            tone: string;
        };
        __schema16: string;
        __schema17: {
            assignee: {
                /** @constant */
                kind: "person";
            } | {
                agent_id: components["schemas"]["__schema11"];
                /** @constant */
                kind: "agent";
            };
            schedule_at?: components["schemas"]["__schema14"];
            title: components["schemas"]["__schema10"];
        };
        __schema18: {
            /** @default false */
            done?: boolean;
            due_at: components["schemas"]["__schema14"] | null;
            title: components["schemas"]["__schema10"];
        };
        __schema19: number;
        __schema20: string;
        __schema21: {
            budget?: {
                max_actions?: number;
                max_attempts?: number;
                max_input_tokens?: number;
                max_output_tokens?: number;
                max_turns?: number;
                max_usd_est?: number;
                max_wall_ms?: number;
            };
            constraints?: {
                /** @default [] */
                allowed_domains?: string[];
                /**
                 * @default {
                 *       "kind": "none"
                 *     }
                 */
                deliverable?: {
                    /** @constant */
                    kind: "none";
                } | {
                    /** @constant */
                    kind: "artifact";
                    path_glob: string;
                } | {
                    connection_id: string;
                    /** @constant */
                    kind: "message_sent";
                } | {
                    /** @constant */
                    kind: "answer";
                };
                notes?: string;
                /** @default false */
                public_compartment?: boolean;
            };
            /** @default routine */
            importance?: components["schemas"]["__schema23"];
            learning?: components["schemas"]["__schema1"];
            objective: string;
            /** @default interactive */
            scheduling_class?: components["schemas"]["__schema22"];
            space_id: string;
            title: string;
            /** @default 3 */
            unread_threshold?: components["schemas"]["__schema24"];
        };
        /** @enum {string} */
        __schema22: "interactive" | "background" | "quiet";
        /** @enum {string} */
        __schema23: "routine" | "important";
        __schema24: number;
        __schema25: components["schemas"]["__schema22"];
        __schema26: components["schemas"]["__schema23"];
        __schema27: components["schemas"]["__schema24"];
        /** Format: date-time */
        __schema28: string;
        __schema29: number;
        __schema30: {
            [key: string]: components["schemas"]["__schema31"];
        };
        __schema31: (string | number | boolean | null) | components["schemas"]["__schema31"][] | {
            [key: string]: components["schemas"]["__schema31"];
        };
        __schema32: {
            corrects?: components["schemas"]["__schema13"];
            text: string;
        };
        __schema33: string;
        __schema34: number;
        __schema35: string;
        __schema36: string;
        __schema37: components["schemas"]["__schema5"][];
        __schema38: {
            content: string;
            /** @default [] */
            excerpts?: components["schemas"]["__schema39"][];
            handle: components["schemas"]["__schema6"];
            /** @default null */
            key?: components["schemas"]["__schema16"] | null;
        };
        __schema39: string;
        __schema40: string;
        __schema41: string;
        __schema42: string;
        /** @enum {string} */
        __schema43: "private" | "space" | "public";
        /** @enum {string} */
        __schema44: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema45: "active" | "superseded" | "retracted" | "disputed";
        /** @enum {string} */
        __schema46: "high" | "medium" | "low";
        /** @enum {string} */
        __schema47: "user" | "agent" | "document" | "tool";
        __schema48: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote?: string;
            ref: string;
            /** @default null */
            sha256?: string | null;
        };
        /** Format: date */
        __schema49: string;
        /** @default null */
        __schema50: components["schemas"]["__schema49"] | null;
        /** @default [] */
        __schema51: components["schemas"]["__schema40"][];
        /** @default null */
        __schema52: components["schemas"]["__schema40"] | null;
        /** @default [] */
        __schema53: string[];
        /** @default [] */
        __schema54: components["schemas"]["__schema40"][];
        /** @constant */
        __schema55: 1;
        __schema56: {
            /** Format: email */
            email: string;
            password: string;
        };
        __schema57: {
            field: string;
            /** @enum {string} */
            op: "eq" | "contains" | "matches" | "lt" | "gt" | "changed";
            /** @default null */
            value?: string | number | boolean | null;
        };
        /** @default 0 */
        __schema58: number;
        /** @default 200 */
        __schema59: number;
        __schema60: ("job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error")[];
        __schema61: string;
        __schema62: {
            alias: string;
            /** @default write_external */
            effect_class?: components["schemas"]["EffectClass"];
            name: string;
            required_scopes: components["schemas"]["__schema61"][];
        };
        /** Format: uri */
        __schema63: string;
        __schema64: string;
        /** Format: uri */
        __schema65: string;
        __schema66: string;
        __schema67: string;
        __schema68: {
            button: 0 | 1 | 2;
            clicks: 1 | 2 | 3;
            /** @enum {string} */
            k: "move" | "down" | "up";
            mods: components["schemas"]["__schema71"];
            x: components["schemas"]["__schema69"];
            y: components["schemas"]["__schema70"];
        } | {
            dx: components["schemas"]["__schema72"];
            dy: components["schemas"]["__schema72"];
            /** @constant */
            k: "wheel";
            mods: components["schemas"]["__schema71"];
            x: components["schemas"]["__schema69"];
            y: components["schemas"]["__schema70"];
        } | {
            code: string;
            down: boolean;
            /** @constant */
            k: "key";
            key: string;
            mods: components["schemas"]["__schema71"];
            text?: string;
            vk: number;
        } | {
            /** @constant */
            k: "text";
            text: string;
        } | {
            /** @constant */
            k: "touch";
            /** @enum {string} */
            phase: "start" | "move" | "end";
            points: components["schemas"]["__schema73"][];
        };
        __schema69: number;
        __schema70: number;
        __schema71: number;
        __schema72: number;
        __schema73: {
            id: number;
            x: components["schemas"]["__schema69"];
            y: components["schemas"]["__schema70"];
        };
        __schema74: string;
        __schema75: string;
        /** @enum {string} */
        __schema76: "chatgpt" | "openai-compatible";
        /** @enum {string} */
        __schema77: "device" | "browser";
        __schema78: string;
        __schema79: string;
        __schema80: number;
        __schema81: string;
        __schema82: string;
        /** @enum {string} */
        __schema83: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema84: string | null;
        __schema85: {
            captured_at: components["schemas"]["__schema28"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema86: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema87: string | null;
        __schema88: {
            compression_count?: number;
            in_place?: boolean;
            used_fallback?: boolean;
        };
        __schema89: string;
        __schema90: {
            actor: string;
            artifacts: components["schemas"]["__schema94"][];
            correctiveJobId?: string | null;
            createdAt: components["schemas"]["__schema95"];
            expiresAt: components["schemas"]["__schema95"];
            failureClass: string | null;
            generationStartedAt: components["schemas"]["__schema95"] | null;
            generationState: string;
            id: components["schemas"]["__schema91"];
            inputDigest: string;
            inputRefs: string[];
            intervention: {
                /** @enum {string} */
                kind: "correction" | "demonstration" | "takeover";
                /**
                 * @default unspecified
                 * @enum {string}
                 */
                signal: "typed_ordering" | "text_ordering" | "preserve_structure" | "unspecified";
                text: string;
            } | null;
            jobId: string;
            judgement: string;
            receipts: components["schemas"]["__schema94"][];
            restricted: boolean;
            scope: components["schemas"]["__schema92"];
            segmentKey: string;
            spaceId: string;
            templateId: string;
            versions: {
                attempt_id: string;
                model_actual: string | null;
                model_requested: string;
                provider: string;
                runtime: string;
                skills: {
                    name: string;
                    version: string;
                }[];
                tools: {
                    name: string;
                    version: string;
                }[];
            }[];
        };
        __schema91: string;
        __schema92: {
            app: components["schemas"]["__schema93"];
            app_version: components["schemas"]["__schema93"];
            /** @constant */
            audience: "private";
            /** @constant */
            role: "owner";
            task_family: components["schemas"]["__schema93"];
        };
        __schema93: string;
        __schema94: {
            [key: string]: unknown;
        };
        /** Format: date-time */
        __schema95: string;
        __schema96: {
            candidate: components["schemas"]["__schema97"];
        };
        __schema97: {
            body: string;
            bodyHash: string;
            canarySpaceId: string | null;
            /** @default {} */
            caseTemplates: {
                final_pool?: components["schemas"]["__schema112"][];
                validation?: components["schemas"]["__schema111"][];
            };
            change: components["schemas"]["__schema94"];
            /** @default [] */
            checks: ({
                kind: components["schemas"]["__schema101"];
                max?: components["schemas"]["__schema103"];
                min?: components["schemas"]["__schema102"];
            } | {
                kind: components["schemas"]["__schema104"];
                max?: components["schemas"]["__schema106"];
                min?: components["schemas"]["__schema105"];
            } | {
                kind: components["schemas"]["__schema107"];
                max?: components["schemas"]["__schema109"];
                min?: components["schemas"]["__schema108"];
            } | {
                /** @constant */
                kind: "required_phrase";
                phrase: components["schemas"]["__schema110"];
            } | {
                /** @constant */
                kind: "forbidden_phrase";
                phrase: components["schemas"]["__schema110"];
            } | {
                /** @enum {string} */
                form: "bullets" | "numbered" | "paragraphs" | "table" | "json";
                /** @constant */
                kind: "output_format";
            } | {
                headings: components["schemas"]["__schema110"][];
                /** @constant */
                kind: "required_sections";
                /** @default true */
                ordered: boolean;
            } | {
                /** @enum {string} */
                direction: "ascending" | "descending";
                key: components["schemas"]["__schema110"];
                /** @constant */
                kind: "records_sorted";
                /** @default true */
                preserve_rows: boolean;
                /** @enum {string} */
                type: "number" | "text" | "date";
            } | {
                /** @constant */
                kind: "records_expected_order";
            } | {
                action_kind: components["schemas"]["__schema110"];
                /** @constant */
                kind: "action_kind_absent";
            } | {
                action_kind: components["schemas"]["__schema110"];
                /** @constant */
                kind: "action_kind_max";
                max: number;
            } | {
                action_kind: components["schemas"]["__schema110"];
                /** @constant */
                kind: "action_kind_present";
                /** @default 1 */
                min: number;
            })[];
            compatibleModels: string[];
            createdAt: components["schemas"]["__schema95"];
            /** @default null */
            discrimination: {
                corrected_failed: number | null;
                detail: string;
                empty_failed: number;
                junk_failed: number;
                prior_failed: number | null;
                /** @enum {string} */
                status: "passed" | "failed" | "none";
            } | null;
            episodeId: components["schemas"]["__schema91"];
            /** @default [] */
            evidence: components["schemas"]["__schema100"][];
            id: components["schemas"]["__schema98"];
            knownRisk: string;
            predictedBenefit: string;
            /**
             * @default {
             *       "scope": "private",
             *       "principal_id": null
             *     }
             */
            promotion: {
                approved_at?: components["schemas"]["__schema95"];
                /** @enum {string} */
                basis?: "evaluation" | "owner_trial";
                definition_hash?: string;
                /** @default null */
                principal_id: string | null;
                /**
                 * @default private
                 * @enum {string}
                 */
                scope: "private" | "space";
            };
            rejectionReason: string | null;
            scope: components["schemas"]["__schema92"];
            selectedEvaluationId: string | null;
            spaceId: string;
            state: components["schemas"]["__schema99"];
            tests: string[];
            /** @default [] */
            triggers: {
                evidence: components["schemas"]["__schema100"];
                phrase: string;
            }[];
            version: number;
        };
        __schema98: string;
        /** @enum {string} */
        __schema99: "candidate" | "evaluated" | "enabled_canary" | "active" | "superseded" | "reverted";
        __schema100: {
            end: number;
            /** @constant */
            fallback?: "verbatim";
            quote: string;
            /** @enum {string} */
            source: "intervention" | "objective";
            start: number;
        };
        /** @constant */
        __schema101: "word_count";
        __schema102: number;
        __schema103: number;
        /** @constant */
        __schema104: "char_count";
        __schema105: number;
        __schema106: number;
        /** @constant */
        __schema107: "line_count";
        __schema108: number;
        __schema109: number;
        __schema110: string;
        __schema111: string;
        __schema112: string;
        __schema113: {
            candidate: components["schemas"]["__schema97"];
            evaluations: {
                budget: components["schemas"]["__schema94"];
                createdAt: components["schemas"]["__schema95"];
                id: string;
                passed: boolean;
                phase: string;
                selectedAt: components["schemas"]["__schema95"] | null;
            }[];
            history: {
                actor: string;
                candidateId: components["schemas"]["__schema98"];
                createdAt: components["schemas"]["__schema95"];
                fromState: string | null;
                id: string;
                reason: string;
                toState: components["schemas"]["__schema99"];
            }[];
        };
        __schema114: {
            error: components["schemas"]["__schema115"];
        };
        __schema115: {
            code: string;
            detail?: {
                [key: string]: unknown;
            };
            message: string;
        };
        __schema116: string;
        __schema117: string;
        /** @enum {string} */
        __schema118: "personal" | "shared";
        /** @enum {string} */
        __schema119: "owner" | "space";
        __schema120: string | null;
        __schema121: string;
        __schema122: {
            generation: number;
            principal_id: string;
            revoked_at: components["schemas"]["__schema95"] | null;
            /** @enum {string} */
            role: "owner" | "member";
            space_id: string;
        };
        __schema123: string;
        __schema124: string;
        __schema125: string;
        /** @enum {string} */
        __schema126: "removed" | "emptied";
        /** @enum {string} */
        __schema127: "pending" | "running" | "blocked" | "complete";
        /** @enum {string} */
        __schema128: "fence" | "sessions" | "journal" | "sandboxes" | "browser" | "runtime" | "files" | "operational" | "principals" | "memory" | "verify" | "space";
        __schema129: {
            /** @default {} */
            cleared: {
                [key: string]: number;
            };
            /** @default {} */
            omitted: {
                [key: string]: "not_applicable" | "capability_absent";
            };
            /** @default [] */
            paths: string[];
            /** @default {} */
            providers: {
                [key: string]: number;
            };
            /** @default {} */
            tables: {
                [key: string]: number;
            };
        };
        __schema130: string | null;
        __schema131: components["schemas"]["__schema95"] | null;
        __schema132: string;
        __schema133: string;
        __schema134: {
            artifacts: number;
            companies: number;
            connections: number;
            jobs: number;
            knowledge_files: number;
            ledger_items: number;
            memory_claims: number;
            sandboxes: number;
            signed_in_sites: number;
        };
        __schema135: {
            label: string;
            provider: string;
        }[];
        __schema136: string[];
        __schema137: string;
        __schema138: string;
        __schema139: string[];
        __schema140: string[];
        __schema141: {
            agent_id: components["schemas"]["__schema142"];
            composer: components["schemas"]["__schema145"];
            created_at: components["schemas"]["__schema146"];
            id: components["schemas"]["__schema142"];
            plan_id: components["schemas"]["__schema142"] | null;
            status: components["schemas"]["__schema144"];
            title: components["schemas"]["__schema143"];
            updated_at: components["schemas"]["__schema146"];
        };
        __schema142: string;
        __schema143: string;
        /** @enum {string} */
        __schema144: "idle" | "queued" | "working" | "streaming" | "needs_you" | "paused" | "done" | "failed" | "stopped";
        /** @enum {string} */
        __schema145: "send" | "pause" | "resume" | "stop";
        /** Format: date-time */
        __schema146: string;
        __schema147: {
            reason: components["schemas"]["__schema143"];
            /** @constant */
            status: "not_available";
        };
        __schema148: {
            conversation: components["schemas"]["__schema141"];
        };
        __schema149: number;
        /** Format: uri */
        __schema150: string;
        __schema151: {
            facts: components["schemas"]["__schema152"][];
            id: components["schemas"]["__schema142"];
            image?: components["schemas"]["__schema150"];
            meta: string;
            primary_action: components["schemas"]["__schema153"] | null;
            secondary_actions: components["schemas"]["__schema153"][];
            source_connection: components["schemas"]["__schema142"] | null;
            title: components["schemas"]["__schema143"];
        };
        __schema152: {
            label: components["schemas"]["__schema143"];
            value: components["schemas"]["__schema143"];
        };
        __schema153: {
            handle: components["schemas"]["__schema142"];
            /** @enum {string} */
            kind: "open" | "download" | "send" | "undo";
            label: components["schemas"]["__schema143"];
            url?: components["schemas"]["__schema150"];
        };
        __schema154: {
            id: components["schemas"]["__schema142"];
            undo?: {
                handle: components["schemas"]["__schema142"];
                valid_until: components["schemas"]["__schema146"];
            };
            what: components["schemas"]["__schema143"];
            when: components["schemas"]["__schema146"];
            where: components["schemas"]["__schema143"];
        };
        __schema155: {
            conversation_id: components["schemas"]["__schema142"];
            draft?: components["schemas"]["__schema157"];
            id: components["schemas"]["__schema142"];
            options: components["schemas"]["__schema156"][];
            preview: components["schemas"]["__schema151"] | null;
            version: components["schemas"]["__schema142"];
            what: components["schemas"]["__schema143"];
            why: components["schemas"]["__schema143"][];
        };
        /** @enum {string} */
        __schema156: "allow_once" | "always" | "deny";
        __schema157: {
            bcc?: components["schemas"]["__schema143"][];
            body: string;
            cc?: components["schemas"]["__schema143"][];
            /** @enum {string} */
            channel: "email" | "message";
            connection_id: components["schemas"]["__schema142"];
            id: components["schemas"]["__schema142"];
            recipient: components["schemas"]["__schema143"];
            /** @enum {string} */
            status: "draft" | "awaiting_permission" | "sent" | "discarded";
            subject?: string;
        };
        __schema158: {
            conversation_id: components["schemas"]["__schema142"] | null;
            id: components["schemas"]["__schema142"];
            if_ignored: components["schemas"]["__schema143"];
            options: components["schemas"]["__schema159"];
            text: components["schemas"]["__schema143"];
            why: components["schemas"]["__schema143"][];
        };
        __schema159: components["schemas"]["__schema160"][];
        __schema160: {
            id: components["schemas"]["__schema142"];
            label: components["schemas"]["__schema143"];
        };
        __schema161: {
            bounds: {
                count_cap: number;
                expires_at: components["schemas"]["__schema146"];
                reconsent_after_days: number;
            };
            connection_id: components["schemas"]["__schema142"];
            created_at: components["schemas"]["__schema146"];
            id: components["schemas"]["__schema142"];
            /** @enum {string} */
            kind: "send_message" | "create_event" | "change_event" | "delete_event" | "save_file" | "restore_file" | "discard_draft";
            recipient_class: components["schemas"]["__schema143"];
            text: components["schemas"]["__schema143"];
            used: components["schemas"]["__schema149"];
        };
        __schema162: {
            /** @constant */
            status: "ok";
        };
        __schema163: {
            allowed_connection_ids: components["schemas"]["__schema171"];
            asks_before_acting: components["schemas"]["__schema172"];
            colour: components["schemas"]["__schema166"];
            eye_colour: components["schemas"]["__schema168"];
            face_image?: components["schemas"]["__schema173"];
            id: components["schemas"]["__schema142"];
            name: components["schemas"]["__schema164"];
            role: components["schemas"]["__schema165"];
            space_id: components["schemas"]["__schema142"];
            standing_instruction: components["schemas"]["__schema170"];
            surface: components["schemas"]["__schema167"];
            tone: components["schemas"]["__schema169"];
            usage: {
                conversations: components["schemas"]["__schema149"];
                last_used: components["schemas"]["__schema146"] | null;
            };
        };
        __schema164: string;
        __schema165: string;
        __schema166: string;
        /** @enum {string} */
        __schema167: "rounded" | "blob" | "diamond" | "octagon" | "gear";
        __schema168: string;
        __schema169: string;
        __schema170: string;
        __schema171: components["schemas"]["__schema142"][];
        __schema172: boolean;
        __schema173: components["schemas"]["__schema150"];
        __schema174: {
            agent: components["schemas"]["__schema163"];
        };
        __schema175: {
            created: components["schemas"]["__schema146"];
            editable: boolean;
            id: components["schemas"]["__schema142"];
            key: components["schemas"]["__schema143"];
            last_used: components["schemas"]["__schema146"] | null;
            /** @enum {string} */
            source: "onboarding" | "conversation" | "inferred";
            value: string;
            version: components["schemas"]["__schema142"];
        };
        __schema176: {
            category: components["schemas"]["__schema143"];
            conversation_ids: components["schemas"]["__schema142"][];
            file_ids: components["schemas"]["__schema142"][];
            id: components["schemas"]["__schema142"];
            milestones: {
                assignee: {
                    /** @constant */
                    kind: "person";
                } | {
                    agent_id: components["schemas"]["__schema142"];
                    /** @constant */
                    kind: "agent";
                };
                done: boolean;
                id: components["schemas"]["__schema142"];
                schedule_at?: components["schemas"]["__schema146"];
                status: components["schemas"]["__schema144"];
                title: components["schemas"]["__schema143"];
            }[];
            next_step: components["schemas"]["__schema143"] | null;
            progress_percent: number;
            title: components["schemas"]["__schema143"];
            updated_at: components["schemas"]["__schema146"];
        };
        __schema177: {
            plan: components["schemas"]["__schema176"];
        };
        __schema178: {
            profile: {
                day_hours: {
                    end: string;
                    start: string;
                };
                name: string;
                time_zone: string;
            };
        };
        __schema179: {
            created_at: components["schemas"]["__schema146"];
            /** @default false */
            done: boolean;
            due_at: components["schemas"]["__schema146"] | null;
            id: components["schemas"]["__schema142"];
            title: components["schemas"]["__schema143"];
            updated_at: components["schemas"]["__schema146"];
        };
        __schema180: {
            task: components["schemas"]["__schema179"];
        };
        __schema181: {
            enabled: boolean;
            id: components["schemas"]["__schema142"];
            runs: {
                finished_at: components["schemas"]["__schema146"] | null;
                id: components["schemas"]["__schema142"];
                started_at: components["schemas"]["__schema146"];
                status: components["schemas"]["__schema144"];
            }[];
            schedule: components["schemas"]["__schema143"];
            title: components["schemas"]["__schema143"];
        };
        __schema182: {
            automation: components["schemas"]["__schema181"];
        };
        __schema183: {
            session: {
                id: components["schemas"]["__schema142"];
                preview_frame: components["schemas"]["__schema150"] | null;
                /** @enum {string} */
                status: "working" | "needs_you" | "done" | "stopped";
                task_label: components["schemas"]["__schema143"];
                url: components["schemas"]["__schema150"];
            };
        };
        __schema184: {
            error?: components["schemas"]["__schema115"];
            job: components["schemas"]["__schema185"] | null;
            receipt: components["schemas"]["__schema207"];
        };
        __schema185: {
            /** @enum {string} */
            attention_status: "normal" | "frequency_reduced" | "needs_attention";
            budget: components["schemas"]["__schema196"];
            cadence_multiplier: number;
            constraints: components["schemas"]["__schema191"];
            created_at: components["schemas"]["__schema95"];
            created_by: components["schemas"]["__schema197"];
            /** @default [] */
            deferred_questions: {
                because: components["schemas"]["__schema201"];
                blocks_external_effect: components["schemas"]["__schema204"];
                created_at: components["schemas"]["__schema95"];
                deadline_at: components["schemas"]["__schema205"];
                if_ignored: components["schemas"]["__schema203"];
                options?: components["schemas"]["__schema206"];
                text: components["schemas"]["__schema200"];
            }[];
            id: components["schemas"]["__schema186"];
            /** @enum {string} */
            importance: "routine" | "important";
            lease_epoch: components["schemas"]["__schema193"];
            next_wake_at: components["schemas"]["__schema194"];
            objective: components["schemas"]["__schema190"];
            principal_id?: components["schemas"]["__schema188"];
            revision: components["schemas"]["__schema192"];
            /** @enum {string} */
            scheduling_class: "interactive" | "background" | "quiet";
            space_id: components["schemas"]["__schema187"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema198"];
            substrate_disposition: components["schemas"]["__schema199"];
            title: components["schemas"]["__schema189"];
            unread_results: number;
            unread_threshold: number;
            updated_at: components["schemas"]["__schema95"];
            visible_status: components["schemas"]["JobState"] | ("frequency_reduced" | "needs_attention");
            wait: components["schemas"]["__schema195"];
        };
        __schema186: string;
        __schema187: string;
        __schema188: string | null;
        __schema189: string;
        __schema190: string;
        __schema191: {
            /** @default [] */
            allowed_domains: string[];
            /**
             * @default {
             *       "kind": "none"
             *     }
             */
            deliverable: {
                /** @constant */
                kind: "none";
            } | {
                /** @constant */
                kind: "artifact";
                path_glob: string;
            } | {
                connection_id: string;
                /** @constant */
                kind: "message_sent";
            } | {
                /** @constant */
                kind: "answer";
            };
            notes?: string;
            /** @default false */
            public_compartment: boolean;
        };
        __schema192: number;
        __schema193: number;
        __schema194: components["schemas"]["__schema95"] | null;
        __schema195: {
            /** @constant */
            kind: "none";
        } | {
            /** @constant */
            kind: "user_input";
            question: string;
        } | {
            action_ids: string[];
            /** @constant */
            kind: "approval";
        } | {
            /** @constant */
            kind: "timer";
            wake_at: components["schemas"]["__schema95"];
        } | {
            deadline_at: components["schemas"]["__schema95"] | null;
            /** @constant */
            kind: "event";
            trigger_id: string;
        };
        __schema196: {
            max_actions: number;
            max_attempts: number;
            max_input_tokens?: number;
            max_output_tokens: number;
            max_turns: number;
            max_usd_est: number;
            max_wall_ms: number;
        };
        /** @enum {string} */
        __schema197: "owner" | "trigger" | "system";
        __schema198: number;
        /** @enum {string} */
        __schema199: "remote_recoverable" | "timer_or_event" | "local_process_interrupted" | "external_uncertain";
        __schema200: string;
        __schema201: components["schemas"]["__schema202"][];
        __schema202: string;
        __schema203: string;
        /** @default false */
        __schema204: boolean;
        /** @default null */
        __schema205: components["schemas"]["__schema95"] | null;
        __schema206: components["schemas"]["__schema159"];
        __schema207: {
            event_cursor: number | null;
            input_digest: components["schemas"]["__schema209"] | null;
            job_id: string | null;
            job_revision: number | null;
            /** @enum {string} */
            state: "accepted" | "rejected" | "unknown_durability";
            submission_id: components["schemas"]["__schema208"];
        };
        __schema208: string;
        __schema209: string;
        __schema210: {
            answer: string | null;
            answered_at: components["schemas"]["__schema95"] | null;
            attempt_id: string | null;
            because: components["schemas"]["__schema201"];
            blocks_external_effect: components["schemas"]["__schema204"];
            created_at: components["schemas"]["__schema95"];
            deadline_at: components["schemas"]["__schema205"];
            id: string;
            if_ignored: components["schemas"]["__schema203"];
            job_id: string | null;
            job_title: string | null;
            key: string | null;
            options?: components["schemas"]["__schema206"];
            /** @enum {string} */
            source: "job" | "memory";
            space_id: string | null;
            /** @enum {string} */
            state: "open" | "answered" | "withdrawn";
            text: components["schemas"]["__schema200"];
        };
        __schema211: {
            actions: {
                dispatched_at: components["schemas"]["__schema95"] | null;
                id: string;
                job_id: string;
                receipt: components["schemas"]["__schema212"] | null;
                status: string;
            }[];
            cursor: number;
            epoch: number | null;
            jobs: components["schemas"]["__schema185"][];
        };
        __schema212: {
            [key: string]: components["schemas"]["__schema213"];
        };
        __schema213: (string | number | boolean | null) | components["schemas"]["__schema213"][] | {
            [key: string]: components["schemas"]["__schema213"];
        };
        __schema214: {
            due_at: components["schemas"]["__schema95"];
            id: string;
            job_id: string;
            /** @enum {string} */
            kind: "timer" | "remote_task" | "local_process";
            operation_key: components["schemas"]["__schema208"];
            remote_ref: string | null;
            result: components["schemas"]["__schema212"] | null;
            /** @enum {string} */
            state: "registered" | "ready" | "claimed" | "settled" | "interrupted" | "unknown";
            substrate_disposition: components["schemas"]["__schema199"];
            version: number;
        };
        __schema215: {
            acknowledged_at: components["schemas"]["__schema95"] | null;
            coalesce_key: string;
            created_at: components["schemas"]["__schema95"];
            fulfilled_at: components["schemas"]["__schema95"] | null;
            id: string;
            job_id: string | null;
            /** @enum {string} */
            kind: "direct" | "quiet";
            message: string | null;
            /** @enum {string} */
            state: "owed" | "acknowledged" | "fulfilled" | "needs_retransmission";
            submission_id: components["schemas"]["__schema208"];
        };
        __schema216: {
            attempted_at: components["schemas"]["__schema95"] | null;
            because: components["schemas"]["__schema202"][];
            coalesce_key: string;
            content: {
                attempt_id: string;
                job_id: string;
                /** @enum {string} */
                kind: "answer" | "question" | "status";
                text: string;
            } | null;
            content_hash: components["schemas"]["__schema209"];
            created_at: components["schemas"]["__schema95"];
            delivered_at: components["schemas"]["__schema95"] | null;
            delivery_attempt: number;
            delivery_key: string;
            id: string;
            if_ignored: components["schemas"]["__schema203"];
            obligation_ids: string[];
            /** @enum {string} */
            state: "pending" | "attempted" | "delivered" | "superseded";
        };
        __schema217: {
            audience: components["schemas"]["__schema221"];
            /**
             * @default owner
             * @enum {string}
             */
            author: "owner" | "external";
            content_ref: string | null;
            eligibility_generation: components["schemas"]["__schema222"];
            event_at: components["schemas"]["__schema95"];
            ingested_at: components["schemas"]["__schema95"];
            origin_trust: components["schemas"]["__schema223"];
            owner_id: string;
            publisher: components["schemas"]["__schema219"];
            source_id: components["schemas"]["__schema218"];
            source_identity: components["schemas"]["__schema219"];
            /** @enum {string} */
            source_type: "message" | "document" | "observation" | "receipt" | "assistant" | "owner_edit";
            source_version: components["schemas"]["__schema219"];
            space_id: string;
            /** @enum {string} */
            state: "active" | "suppressed" | "deleted" | "revoked";
            stream: components["schemas"]["__schema219"];
            stream_sequence: components["schemas"]["__schema220"];
        };
        __schema218: string;
        __schema219: string;
        __schema220: number;
        /** @enum {string} */
        __schema221: "private" | "space" | "public";
        __schema222: number;
        /** @enum {string} */
        __schema223: "owner" | "verified_connector" | "external_content" | "inferred" | "unknown";
        __schema224: {
            access_generation: components["schemas"]["__schema222"];
            data_revision: components["schemas"]["__schema222"];
            eligibility_generation: components["schemas"]["__schema222"];
            policy_generation: components["schemas"]["__schema222"];
            restore_ready: boolean;
            space_id: string;
        };
        __schema225: string;
        __schema226: string;
        __schema227: string;
        /** @enum {string} */
        __schema228: "user_statement" | "document_assertion" | "checked_fact" | "inferred" | "preference" | "exception" | "historical";
        /** @enum {string} */
        __schema229: "attributed" | "checked" | "tentative" | "disputed";
        /** @enum {string} */
        __schema230: "active" | "superseded" | "historical" | "retracted" | "disputed";
        __schema231: {
            end: components["schemas"]["__schema220"];
            source_id: components["schemas"]["__schema218"];
            source_version: components["schemas"]["__schema219"];
            start: components["schemas"]["__schema222"];
        };
        __schema232: {
            claim_id: components["schemas"]["__schema225"];
            content: string | null;
            data_revision: components["schemas"]["__schema220"];
            factual_status: components["schemas"]["__schema229"];
            kind: components["schemas"]["__schema228"];
            /** @default inferred */
            origin_trust: components["schemas"]["__schema223"];
            protected: boolean;
            recorded_at: components["schemas"]["__schema95"];
            revision: components["schemas"]["__schema220"];
            sources: components["schemas"]["__schema231"][];
            status: components["schemas"]["__schema230"];
            superseded_at: components["schemas"]["__schema95"] | null;
            valid_from: components["schemas"]["__schema95"];
            valid_until: components["schemas"]["__schema95"] | null;
        };
        __schema233: {
            /** @enum {string} */
            cleanup: "pending" | "complete";
            generation: components["schemas"]["__schema224"];
        };
        __schema234: string;
        /** @default null */
        __schema235: components["schemas"]["__schema227"] | null;
        __schema236: boolean;
        __schema237: string;
        __schema238: string;
        __schema239: {
            field: string;
            handle: components["schemas"]["__schema226"];
            key: components["schemas"]["__schema227"] | null;
            /** @enum {string} */
            kind: "recipient" | "date" | "amount" | "identifier";
            value: string;
        };
        __schema240: {
            description: string;
            field: string;
            handle: (components["schemas"]["__schema226"] | string) | null;
            origin_trust: components["schemas"]["__schema223"];
            value: string;
        };
        __schema241: string;
        __schema242: string;
        __schema243: {
            /** @enum {string} */
            kind: "artifact" | "plan_step" | "action";
            location: string | null;
            output_id: components["schemas"]["__schema237"];
            output_version: components["schemas"]["__schema237"];
        };
        __schema244: {
            diff: string;
            id: components["schemas"]["__schema219"];
            path: string;
            /** @enum {string} */
            status: "pending" | "applied" | "discarded";
        };
        __schema245: {
            owner: {
                created_at: components["schemas"]["__schema95"];
                /** Format: email */
                email: string;
                id: string;
            };
        };
        __schema246: {
            spaces: components["schemas"]["Space"][];
        };
        __schema247: {
            job: components["schemas"]["Job"];
        };
        __schema248: {
            field: string;
            /** @enum {string} */
            op: "eq" | "contains" | "matches" | "lt" | "gt" | "changed";
            /** @default null */
            value: string | number | boolean | null;
        };
        __schema249: {
            /** @enum {string} */
            by: "person" | "assistant";
            created_at: components["schemas"]["__schema95"];
            emoji: string;
            job_id: string | null;
            message_id: string;
            seq: number;
        };
        __schema250: {
            reactions: components["schemas"]["__schema249"][];
        };
        __schema251: string;
        __schema252: string;
        __schema253: number;
        __schema254: string;
        __schema255: string;
        __schema256: string;
        __schema257: string | null;
        __schema258: {
            /** @default 0 */
            cached_input_tokens: number;
            /** @default 0 */
            input_tokens: number;
            /** @default 0 */
            output_tokens: number;
            /** @default 0 */
            requests: number;
            /** @default 0 */
            usd_est: number;
        };
        __schema259: components["schemas"]["__schema95"] | null;
        __schema260: ("completed" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "failed" | "budget_exhausted" | "fenced" | "unknown_check") | null;
        __schema261: components["schemas"]["__schema212"] | null;
        __schema262: string | null;
        __schema263: {
            events: components["schemas"]["Event"][];
            has_more: boolean;
            next_cursor: number;
        };
        __schema264: number;
        __schema265: string | null;
        __schema266: string | null;
        /** @enum {string} */
        __schema267: "job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error";
        __schema268: string;
        __schema269: string;
        __schema270: string;
        /** @enum {string} */
        __schema271: "completed" | "parked_until_retry" | "needs_reconciliation" | "needs_reconnect" | "needs_input" | "repair_exhausted";
        __schema272: {
            [key: string]: number;
        };
        __schema273: {
            at: components["schemas"]["__schema95"];
            attempt: number;
            /** @default null */
            candidate_id: string | null;
            /** @enum {string} */
            decision: "verified_completion" | "retry_with_backoff" | "park_until_retry_after" | "refresh_credential_once" | "stop_connection_revoked" | "rediscover_schema" | "record_repair_candidate" | "apply_safe_mapping" | "change_route" | "reconcile_by_verify" | "revise_and_revalidate" | "stop_needs_input" | "escalate_diagnosis";
            /** @default null */
            delay_ms: number | null;
            detail: string;
            /** @default null */
            fault_kind: components["schemas"]["__schema274"] | null;
            payload_hash: components["schemas"]["__schema269"];
            /** @default null */
            retry_after: components["schemas"]["__schema95"] | null;
            /** @default null */
            route: string | null;
        }[];
        /** @enum {string} */
        __schema274: "transient_before_dispatch" | "rate_limited" | "expired_credential" | "revoked_credential" | "schema_drift" | "unsupported_route" | "uncertain_outcome" | "bad_output" | "unclassified";
        __schema275: string;
        __schema276: string;
        __schema277: string;
        __schema278: string;
        __schema279: string;
        /** @default null */
        __schema280: components["schemas"]["__schema270"] | null;
        __schema281: string | null;
        __schema282: string | null;
        __schema283: string;
        __schema284: components["schemas"]["__schema95"] | null;
        __schema285: components["schemas"]["__schema212"] | null;
        __schema286: components["schemas"]["__schema95"] | null;
        __schema287: components["schemas"]["__schema212"] | null;
        /** @default [] */
        __schema288: components["schemas"]["__schema273"];
        /** @default {} */
        __schema289: components["schemas"]["__schema272"];
        /** @default null */
        __schema290: components["schemas"]["__schema271"] | null;
        /** @default null */
        __schema291: components["schemas"]["__schema95"] | null;
        __schema292: {
            action: components["schemas"]["Action"];
        };
        __schema293: string;
        __schema294: string;
        /** @enum {string} */
        __schema295: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp";
        __schema296: string;
        __schema297: string[];
        /** @enum {string} */
        __schema298: "active" | "disabled" | "error" | "revoked";
        /** @enum {string} */
        __schema299: "unknown" | "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema300: "available" | "connecting" | "connected" | "error";
        __schema301: number;
        __schema302: boolean;
        __schema303: components["schemas"]["__schema95"] | null;
        __schema304: {
            check?: components["schemas"]["ConnectionCheck"];
            connection: components["schemas"]["Connection"];
        };
        /** @enum {string} */
        __schema305: "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema306: "ok" | "degraded" | "unavailable" | "credential_refused" | "not_running" | "revoked";
        __schema307: string;
        __schema308: string;
        /** @enum {string} */
        __schema309: "mail" | "caldav" | "ics" | "mcp";
        __schema310: string;
        __schema311: string;
        __schema312: {
            path: string;
            value: components["schemas"]["__schema313"];
        }[];
        __schema313: string | number | boolean;
        __schema314: components["schemas"]["ConnectionFormField"][];
        __schema315: string;
        __schema316: string;
        __schema317: string;
        __schema318: boolean;
        __schema319: boolean;
        __schema320: string;
        __schema321: components["schemas"]["__schema313"];
        __schema322: {
            label: string;
            value: string;
        }[];
        __schema323: components["schemas"]["__schema324"] | "list";
        /** @enum {string} */
        __schema324: "text" | "email" | "url" | "number" | "password" | "checkbox" | "select" | "string_list";
        __schema325: {
            default?: components["schemas"]["__schema321"];
            help?: components["schemas"]["__schema317"];
            input: components["schemas"]["__schema324"];
            label: components["schemas"]["__schema316"];
            options?: components["schemas"]["__schema322"];
            path: components["schemas"]["__schema315"];
            placeholder?: components["schemas"]["__schema320"];
            required: components["schemas"]["__schema318"];
            secret: components["schemas"]["__schema319"];
        }[];
        __schema326: {
            asks_first: boolean;
            default: boolean;
            effect_class: components["schemas"]["EffectClass"];
            label: string;
            scope: string;
        }[];
        /** @enum {string} */
        __schema327: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema328: "active" | "superseded" | "retracted" | "disputed";
        __schema329: {
            body: string;
            frontmatter: components["schemas"]["KnowledgeFrontmatterOutput"];
            id: string;
            path: string;
        };
        __schema330: string;
        __schema331: string;
        __schema332: string;
        /** @enum {string} */
        __schema333: "private" | "space" | "public";
        /** @enum {string} */
        __schema334: "high" | "medium" | "low";
        /** @enum {string} */
        __schema335: "user" | "agent" | "document" | "tool";
        __schema336: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote: string;
            ref: string;
            /** @default null */
            sha256: string | null;
        };
        /** Format: date */
        __schema337: string;
        /** @default null */
        __schema338: components["schemas"]["__schema337"] | null;
        /** @default [] */
        __schema339: components["schemas"]["__schema330"][];
        /** @default null */
        __schema340: components["schemas"]["__schema330"] | null;
        /** @default [] */
        __schema341: string[];
        /** @default [] */
        __schema342: components["schemas"]["__schema330"][];
        /** @constant */
        __schema343: 1;
        __schema344: string;
        __schema345: string;
        __schema346: number;
        /** @enum {string} */
        __schema347: "automation" | "human";
        /** @constant */
        __schema348: true;
        __schema349: components["schemas"]["BrowserSite"][];
        __schema350: string;
        __schema351: string;
        __schema352: string;
        __schema353: string;
        /** @constant */
        __schema354: true;
        __schema355: string;
        __schema356: number;
        __schema357: {
            /** @constant */
            height: 768;
            /** @constant */
            width: 1024;
        };
        __schema358: components["schemas"]["__schema359"][];
        __schema359: string;
        __schema360: string;
        __schema361: number;
        __schema362: components["schemas"]["__schema363"][];
        __schema363: string;
        /** @constant */
        __schema364: true;
        __schema365: {
            /** @default null */
            currency: components["schemas"]["__schema367"] | null;
            domain: string;
            first_seen_at: components["schemas"]["__schema95"];
            id: string;
            last_seen_at: components["schemas"]["__schema95"];
            message_count: number;
            /** @default null */
            monthly_spend_minor: components["schemas"]["__schema366"] | null;
            name: string;
            space_id: string;
        };
        __schema366: number;
        __schema367: string;
        __schema368: {
            /** @default null */
            amount_minor: components["schemas"]["__schema366"] | null;
            company_id: string;
            confidence: components["schemas"]["__schema334"];
            /** @default null */
            currency: components["schemas"]["__schema367"] | null;
            /** @enum {string} */
            direction: "owed_to_you" | "you_pay" | "you_owe" | "info";
            /** @default null */
            due_at: components["schemas"]["__schema95"] | null;
            evidence: components["schemas"]["__schema369"][];
            id: string;
            /** @default null */
            job_id: string | null;
            /** @enum {string} */
            kind: "refund_owed" | "wrong_charge" | "subscription" | "price_rise" | "renewal" | "trial_ending" | "invoice_unpaid" | "compensation" | "warranty" | "deposit" | "data_held" | "promise";
            principal_id: string;
            space_id: string;
            /** @enum {string} */
            status: "found" | "handling" | "waiting" | "settled" | "dropped";
            /** @default null */
            suggested_playbook: string | null;
            summary: string;
        };
        __schema369: {
            end: number;
            message_id: string;
            quote: string;
            start: number;
        };
        __schema370: {
            /** @description The signed-in account, when the provider names one */
            account: components["schemas"]["__schema371"] | null;
            /** @description When the current access token expires. The gateway refreshes before then. */
            expires_at: components["schemas"]["__schema95"] | null;
            /** @description The provider as the person knows it, for a "Sign in with" button */
            label: string;
            /** @description What happened and what to do, in plain words, whenever the person has something to do; null when signed in or signed out. */
            message: components["schemas"]["__schema373"] | null;
            methods: ("device" | "browser")[];
            /** @enum {string} */
            provider: "chatgpt" | "openai-compatible";
            /** @description Why a new sign-in is needed */
            reason: components["schemas"]["__schema372"] | null;
            /**
             * @description `sign_in_required` means the provider refused a refresh; model calls to it are refused with `provider_sign_in_required` until the owner signs in again.
             * @enum {string}
             */
            state: "signed_out" | "pending" | "signed_in" | "sign_in_required";
        };
        __schema371: string;
        /** @enum {string} */
        __schema372: "refresh_expired" | "refresh_reused" | "refresh_revoked" | "refresh_refused" | "access_expired";
        __schema373: string;
        __schema374: string;
        __schema375: number;
        __schema376: string;
        __schema377: string;
        /** @enum {string} */
        __schema378: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema379: string | null;
        __schema380: {
            captured_at: components["schemas"]["__schema95"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema381: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema382: string | null;
        __schema383: {
            compression_count?: number;
            in_place?: boolean;
            used_fallback?: boolean;
        };
        __schema384: string;
        Action: {
            attempt_id: components["schemas"]["__schema277"];
            authorization_ref: components["schemas"]["__schema281"];
            budget_reservation: components["schemas"]["__schema282"];
            canonical_payload: components["schemas"]["__schema212"];
            connection_id: components["schemas"]["__schema278"];
            created_at: components["schemas"]["__schema95"];
            dispatched_at: components["schemas"]["__schema284"];
            effect_class: components["schemas"]["EffectClass"];
            id: components["schemas"]["__schema275"];
            idempotency_key: components["schemas"]["__schema283"];
            intent_key: components["schemas"]["__schema280"];
            job_id: components["schemas"]["__schema276"];
            kind: components["schemas"]["__schema279"];
            payload_hash: components["schemas"]["__schema269"];
            receipt: components["schemas"]["__schema285"];
            reconciliation: components["schemas"]["__schema287"];
            repair_counters: components["schemas"]["__schema289"];
            repair_disposition: components["schemas"]["__schema290"];
            repair_trace: components["schemas"]["__schema288"];
            resolved_at: components["schemas"]["__schema286"];
            retry_after_at: components["schemas"]["__schema291"];
            status: components["schemas"]["ActionStatus"];
        };
        /** @enum {string} */
        ActionStatus: "proposed" | "needs_approval" | "approved" | "denied" | "admitted" | "dispatched" | "succeeded" | "failed" | "unknown" | "unresolved";
        Attempt: {
            context_snapshot_ref: components["schemas"]["__schema262"];
            ended_at: components["schemas"]["__schema259"];
            epoch: components["schemas"]["__schema253"];
            id: components["schemas"]["__schema251"];
            job_id: components["schemas"]["__schema252"];
            model: components["schemas"]["__schema256"];
            model_actual: components["schemas"]["__schema257"];
            outcome: components["schemas"]["__schema260"];
            outcome_detail: components["schemas"]["__schema261"];
            provider: components["schemas"]["__schema255"];
            runtime_version: components["schemas"]["__schema254"];
            started_at: components["schemas"]["__schema95"];
            usage: components["schemas"]["__schema258"];
        };
        BrowserControlResponse: {
            control: components["schemas"]["__schema347"];
            control_epoch: components["schemas"]["__schema346"];
            fresh_observation_required: components["schemas"]["__schema348"];
            session_id: components["schemas"]["__schema345"];
        };
        BrowserSite: {
            domain: components["schemas"]["__schema350"];
            label: components["schemas"]["__schema351"];
            last_used: components["schemas"]["__schema352"];
        };
        BrowserSiteForgotten: {
            domain: components["schemas"]["__schema353"];
            forgotten: components["schemas"]["__schema354"];
        };
        BrowserSiteList: {
            sites: components["schemas"]["__schema349"];
        };
        Connection: {
            builtin?: components["schemas"]["__schema302"];
            created_at: components["schemas"]["__schema95"];
            generation?: components["schemas"]["__schema301"];
            health: components["schemas"]["__schema299"];
            id: components["schemas"]["__schema293"];
            label: components["schemas"]["__schema296"];
            last_checked_at: components["schemas"]["__schema303"];
            provider: components["schemas"]["__schema295"];
            scopes: components["schemas"]["__schema297"];
            setup_state?: components["schemas"]["__schema300"];
            space_id: components["schemas"]["__schema294"];
            status: components["schemas"]["__schema298"];
        };
        ConnectionCheck: {
            checked_at: components["schemas"]["__schema95"];
            code: components["schemas"]["__schema306"];
            detail: components["schemas"]["__schema307"];
            status: components["schemas"]["__schema305"];
        };
        ConnectionFormField: {
            default?: components["schemas"]["__schema321"];
            help?: components["schemas"]["__schema317"];
            input: components["schemas"]["__schema323"];
            item_fields?: components["schemas"]["__schema325"];
            label: components["schemas"]["__schema316"];
            options?: components["schemas"]["__schema322"];
            path: components["schemas"]["__schema315"];
            placeholder?: components["schemas"]["__schema320"];
            required: components["schemas"]["__schema318"];
            secret: components["schemas"]["__schema319"];
        };
        ConnectionKind: {
            description: components["schemas"]["__schema311"];
            fields: components["schemas"]["__schema314"];
            fixed: components["schemas"]["__schema312"];
            id: components["schemas"]["__schema308"];
            kind: components["schemas"]["__schema309"];
            scopes: components["schemas"]["__schema326"];
            title: components["schemas"]["__schema310"];
        };
        /** @enum {string} */
        EffectClass: "read" | "write_reversible" | "write_external" | "spend";
        Event: {
            attempt_id: components["schemas"]["__schema266"];
            created_at: components["schemas"]["__schema95"];
            dedup_key: components["schemas"]["__schema268"];
            job_id: components["schemas"]["__schema265"];
            payload: components["schemas"]["__schema212"];
            seq: components["schemas"]["__schema264"];
            type: components["schemas"]["__schema267"];
        };
        HookObservation: {
            capture_id: components["schemas"]["__schema377"];
            detail?: components["schemas"]["__schema383"];
            name: components["schemas"]["__schema378"];
            outcome: components["schemas"]["__schema381"];
            redacted_args_digest: components["schemas"]["__schema382"];
            timing: components["schemas"]["__schema380"];
            tool_name: components["schemas"]["__schema379"];
        };
        Job: {
            budget: components["schemas"]["__schema196"];
            constraints: components["schemas"]["__schema191"];
            created_at: components["schemas"]["__schema95"];
            created_by: components["schemas"]["__schema197"];
            id: components["schemas"]["__schema186"];
            lease_epoch: components["schemas"]["__schema193"];
            next_wake_at: components["schemas"]["__schema194"];
            objective: components["schemas"]["__schema190"];
            principal_id?: components["schemas"]["__schema188"];
            revision: components["schemas"]["__schema192"];
            space_id: components["schemas"]["__schema187"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema198"];
            title: components["schemas"]["__schema189"];
            updated_at: components["schemas"]["__schema95"];
            wait: components["schemas"]["__schema195"];
        };
        /** @enum {string} */
        JobState: "queued" | "running" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "needs_reconciliation" | "completed" | "failed" | "cancelled";
        KnowledgeFrontmatter: {
            asserted_by: components["schemas"]["__schema47"];
            audience: components["schemas"]["__schema43"];
            confidence: components["schemas"]["__schema46"];
            created: components["schemas"]["__schema49"];
            id: components["schemas"]["__schema40"];
            links?: components["schemas"]["__schema54"];
            observed_at: components["schemas"]["__schema49"];
            schema_version: components["schemas"]["__schema55"];
            source: components["schemas"]["__schema48"];
            space: components["schemas"]["__schema42"];
            status: components["schemas"]["__schema45"];
            superseded_by?: components["schemas"]["__schema52"];
            supersedes?: components["schemas"]["__schema51"];
            tags?: components["schemas"]["__schema53"];
            title: components["schemas"]["__schema41"];
            type: components["schemas"]["__schema44"];
            updated: components["schemas"]["__schema49"];
            valid_from: components["schemas"]["__schema49"];
            valid_until?: components["schemas"]["__schema50"];
        };
        KnowledgeFrontmatterOutput: {
            asserted_by: components["schemas"]["__schema335"];
            audience: components["schemas"]["__schema333"];
            confidence: components["schemas"]["__schema334"];
            created: components["schemas"]["__schema337"];
            id: components["schemas"]["__schema330"];
            links: components["schemas"]["__schema342"];
            observed_at: components["schemas"]["__schema337"];
            schema_version: components["schemas"]["__schema343"];
            source: components["schemas"]["__schema336"];
            space: components["schemas"]["__schema332"];
            status: components["schemas"]["__schema328"];
            superseded_by: components["schemas"]["__schema340"];
            supersedes: components["schemas"]["__schema339"];
            tags: components["schemas"]["__schema341"];
            title: components["schemas"]["__schema331"];
            type: components["schemas"]["__schema327"];
            updated: components["schemas"]["__schema337"];
            valid_from: components["schemas"]["__schema337"];
            valid_until: components["schemas"]["__schema338"];
        };
        LiveClose: {
            live_id: components["schemas"]["__schema66"];
        };
        LiveClosed: {
            closed: components["schemas"]["__schema364"];
        };
        LiveInputResponse: {
            accepted: components["schemas"]["__schema361"];
        };
        LiveOpen: {
            control_epoch: components["schemas"]["__schema356"];
            expires_at: components["schemas"]["__schema360"];
            live_id: components["schemas"]["__schema355"];
            site_scope: components["schemas"]["__schema358"];
            viewport: components["schemas"]["__schema357"];
        };
        LiveScope: {
            host: components["schemas"]["__schema74"];
            live_id: components["schemas"]["__schema66"];
        };
        LiveScopeResponse: {
            site_scope: components["schemas"]["__schema362"];
        };
        RuntimeEvent: {
            at: components["schemas"]["__schema95"];
            attempt_id: components["schemas"]["__schema374"];
            capture_id: components["schemas"]["__schema377"];
            dedup_key: components["schemas"]["__schema376"];
            detail?: components["schemas"]["__schema383"];
            local_seq: components["schemas"]["__schema375"];
            name: components["schemas"]["__schema378"];
            outcome: components["schemas"]["__schema381"];
            redacted_args_digest: components["schemas"]["__schema382"];
            timing: components["schemas"]["__schema380"];
            tool_name: components["schemas"]["__schema379"];
            /** @constant */
            type: "hook_event";
        } | {
            at: components["schemas"]["__schema95"];
            attempt_id: components["schemas"]["__schema374"];
            capture_id: components["schemas"]["__schema377"];
            dedup_key: components["schemas"]["__schema376"];
            detail?: components["schemas"]["__schema383"];
            /** @enum {string} */
            error_code: "observer_failed" | "delivery_failed" | "capture_gap";
            local_seq: components["schemas"]["__schema375"];
            name: components["schemas"]["__schema378"];
            outcome: components["schemas"]["__schema381"];
            redacted_args_digest: components["schemas"]["__schema382"];
            timing: components["schemas"]["__schema380"];
            tool_name: components["schemas"]["__schema379"];
            /** @constant */
            type: "hook_error";
        } | {
            at: components["schemas"]["__schema95"];
            attempt_id: components["schemas"]["__schema374"];
            dedup_key: components["schemas"]["__schema376"];
            local_seq: components["schemas"]["__schema375"];
            turn: number;
            /** @constant */
            type: "turn_started";
        } | {
            at: components["schemas"]["__schema95"];
            attempt_id: components["schemas"]["__schema374"];
            dedup_key: components["schemas"]["__schema376"];
            local_seq: components["schemas"]["__schema375"];
            text: string;
            /** @constant */
            type: "text_delta";
        } | {
            arguments: components["schemas"]["__schema212"];
            at: components["schemas"]["__schema95"];
            attempt_id: components["schemas"]["__schema374"];
            call_id: string;
            dedup_key: components["schemas"]["__schema376"];
            local_seq: components["schemas"]["__schema375"];
            tool: string;
            /** @constant */
            type: "tool_call_proposed";
        } | {
            at: components["schemas"]["__schema95"];
            attempt_id: components["schemas"]["__schema374"];
            call_id: string;
            dedup_key: components["schemas"]["__schema376"];
            local_seq: components["schemas"]["__schema375"];
            ok: boolean;
            result: components["schemas"]["__schema212"];
            /** @constant */
            type: "tool_result";
        } | {
            action_id: string;
            at: components["schemas"]["__schema95"];
            attempt_id: components["schemas"]["__schema374"];
            dedup_key: components["schemas"]["__schema376"];
            kind: string;
            local_seq: components["schemas"]["__schema375"];
            /** @constant */
            type: "action_requested";
        } | {
            at: components["schemas"]["__schema95"];
            attempt_id: components["schemas"]["__schema374"];
            dedup_key: components["schemas"]["__schema376"];
            local_seq: components["schemas"]["__schema375"];
            outcome: {
                evidence: ({
                    artifact_id: string;
                    /** @constant */
                    kind: "artifact";
                } | {
                    action_id: string;
                    /** @constant */
                    kind: "action";
                } | {
                    /** @constant */
                    kind: "knowledge";
                    record_id: string;
                })[];
                /** @constant */
                kind: "completed";
                summary: string;
            } | {
                draft?: string;
                /** @constant */
                kind: "waiting_for_input";
                question: string;
            } | {
                action_ids: components["schemas"]["__schema384"][];
                /** @constant */
                kind: "waiting_for_approval";
            } | {
                /** @constant */
                kind: "waiting_for_event_or_time";
                wait: components["schemas"]["__schema195"];
            } | {
                /** @constant */
                kind: "failed";
                reason: string;
                retryable: boolean;
            } | {
                /** @constant */
                kind: "budget_exhausted";
                summary: string;
            } | {
                /** @constant */
                check: "parked_actions";
                /** @constant */
                kind: "unknown_check";
                message: string;
                /** @enum {string} */
                reason: "timed_out" | "unavailable";
            };
            /** @constant */
            type: "attempt_outcome";
            usage?: components["schemas"]["__schema258"];
        } | {
            after_seq: number;
            at: components["schemas"]["__schema95"];
            attempt_id: components["schemas"]["__schema374"];
            dedup_key: components["schemas"]["__schema376"];
            local_seq: components["schemas"]["__schema375"];
            reason: string;
            /** @constant */
            type: "gap";
        };
        Space: {
            audience: components["schemas"]["__schema119"];
            created_at: components["schemas"]["__schema95"];
            git_path: components["schemas"]["__schema121"];
            id: components["schemas"]["__schema116"];
            kind: components["schemas"]["__schema118"];
            name: components["schemas"]["__schema117"];
            owner_principal_id?: components["schemas"]["__schema120"];
        };
        SpaceRemoval: {
            blocked_reason: components["schemas"]["__schema130"];
            counts: components["schemas"]["__schema129"];
            finished_at: components["schemas"]["__schema131"];
            id: components["schemas"]["__schema123"];
            kind: components["schemas"]["__schema126"];
            phase: components["schemas"]["__schema128"];
            space_id: components["schemas"]["__schema124"];
            space_name: components["schemas"]["__schema125"];
            started_at: components["schemas"]["__schema95"];
            state: components["schemas"]["__schema127"];
        };
        SpaceRemovalPreview: {
            confirmation: components["schemas"]["__schema137"];
            counts: components["schemas"]["__schema134"];
            kind: components["schemas"]["__schema126"];
            name: components["schemas"]["__schema133"];
            providers: components["schemas"]["__schema135"];
            space_id: components["schemas"]["__schema132"];
            stays: components["schemas"]["__schema136"];
        };
        SpaceRemovalReport: {
            cleared: components["schemas"]["__schema139"];
            headline: components["schemas"]["__schema138"];
            removal: components["schemas"]["SpaceRemoval"];
            still_yours: components["schemas"]["__schema140"];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
