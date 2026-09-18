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
                        "application/json": components["schemas"]["__schema249"];
                    };
                };
                /** @description No such action */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema249"];
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
                        "application/json": components["schemas"]["__schema249"];
                    };
                };
                /** @description Action is not awaiting reconciliation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            agents: components["schemas"]["__schema121"][];
                        } | components["schemas"]["__schema105"];
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
                    "application/json": components["schemas"]["__schema13"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema132"] | components["schemas"]["__schema105"];
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
                    "application/json": components["schemas"]["__schema13"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema132"] | components["schemas"]["__schema105"];
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
                                    allowed_connection_ids: components["schemas"]["__schema129"];
                                    asks_before_acting: components["schemas"]["__schema130"];
                                    colour: components["schemas"]["__schema124"];
                                    eye_colour: components["schemas"]["__schema126"];
                                    face_image?: components["schemas"]["__schema131"];
                                    name: components["schemas"]["__schema122"];
                                    role: components["schemas"]["__schema123"];
                                    standing_instruction: components["schemas"]["__schema128"];
                                    surface: components["schemas"]["__schema125"];
                                    tone: components["schemas"]["__schema127"];
                                };
                                id: components["schemas"]["__schema100"];
                                title: components["schemas"]["__schema101"];
                            }[];
                        } | components["schemas"]["__schema105"];
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
                                canonical_payload: components["schemas"]["__schema170"];
                                connection_id: string;
                                effect_class: components["schemas"]["EffectClass"];
                                expires_at: components["schemas"]["__schema78"] | null;
                                job_id: string;
                                job_revision: number;
                                kind: string;
                                /** @default [] */
                                origin_warnings: {
                                    description: string;
                                    field: string;
                                    handle: string | null;
                                    origin_trust: components["schemas"]["__schema182"];
                                }[];
                                payload_hash: components["schemas"]["__schema226"];
                                requested_at: components["schemas"]["__schema78"];
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
                            decided_at: components["schemas"]["__schema78"];
                            /** @enum {string} */
                            decision: "approved" | "denied";
                            payload_hash: components["schemas"]["__schema226"];
                        };
                    };
                };
                /** @description The payload changed since this approval was requested */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description No matching artifact in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                            automations: components["schemas"]["__schema139"][];
                        } | components["schemas"]["__schema105"];
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
                        agent_id: components["schemas"]["__schema10"];
                        at: string;
                        instruction: components["schemas"]["__schema9"];
                        title: components["schemas"]["__schema9"];
                        weekdays: components["schemas"]["__schema17"][];
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
                        "application/json": components["schemas"]["__schema140"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema120"] | components["schemas"]["__schema105"];
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
                        agent_id: components["schemas"]["__schema10"];
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
                        "application/json": components["schemas"]["__schema140"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema141"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema141"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            /** Format: uri */
                            calendar_url: string;
                            username: string;
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
                            from: string;
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
                        "application/json": components["schemas"]["__schema261"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description MCP installation name already exists */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema261"];
                    };
                };
                /** @description No such connection */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                            conversations: components["schemas"]["__schema99"][];
                        } | components["schemas"]["__schema105"];
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
                        agent_id: components["schemas"]["__schema10"];
                        plan_id?: components["schemas"]["__schema10"];
                        title: components["schemas"]["__schema9"];
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
                        "application/json": components["schemas"]["__schema106"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema106"] | components["schemas"]["__schema105"];
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
                    "application/json": components["schemas"]["__schema11"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema106"] | components["schemas"]["__schema105"];
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
                            cards: components["schemas"]["__schema109"][];
                        } | components["schemas"]["__schema105"];
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
                            drafts: components["schemas"]["__schema115"][];
                        } | components["schemas"]["__schema105"];
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
                                conversation_id: components["schemas"]["__schema100"];
                                created_at: components["schemas"]["__schema104"];
                                item: ({
                                    text: string;
                                    /** @constant */
                                    type: "say";
                                } | {
                                    label: components["schemas"]["__schema101"];
                                    meta: string;
                                    sources: {
                                        app: components["schemas"]["__schema101"];
                                        connection_id: components["schemas"]["__schema100"];
                                        /** @enum {string} */
                                        kind: "event" | "message" | "draft" | "file" | "page" | "task";
                                        title: components["schemas"]["__schema101"];
                                        url?: components["schemas"]["__schema108"];
                                    }[];
                                    /** @constant */
                                    type: "action";
                                } | {
                                    text: components["schemas"]["__schema101"];
                                    /** @constant */
                                    type: "note";
                                } | {
                                    apps: components["schemas"]["__schema101"][];
                                    elapsed_ms: components["schemas"]["__schema107"];
                                    source_count: components["schemas"]["__schema107"];
                                    summary: components["schemas"]["__schema101"];
                                    /** @constant */
                                    type: "done";
                                }) | {
                                    text: string;
                                    /** @constant */
                                    type: "text_delta";
                                } | {
                                    card: components["schemas"]["__schema109"];
                                    /** @constant */
                                    type: "card";
                                } | {
                                    receipt: components["schemas"]["__schema112"];
                                    /** @constant */
                                    type: "receipt";
                                } | {
                                    permission: components["schemas"]["__schema113"];
                                    /** @constant */
                                    type: "permission";
                                } | {
                                    question: components["schemas"]["__schema116"];
                                    /** @constant */
                                    type: "question";
                                } | {
                                    composer: components["schemas"]["__schema103"];
                                    status: components["schemas"]["__schema102"];
                                    /** @constant */
                                    type: "status";
                                };
                                seq: components["schemas"]["__schema107"];
                                turn_id: components["schemas"]["__schema100"] | null;
                            }[];
                            has_more: boolean;
                            next_cursor: components["schemas"]["__schema107"];
                        } | components["schemas"]["__schema105"];
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
                                agent_id: components["schemas"]["__schema100"];
                                answer: string;
                                conversation_id: components["schemas"]["__schema100"];
                                created_at: components["schemas"]["__schema104"];
                                delivery: ("sending" | "queued_offline" | "failed_retry") | null;
                                id: components["schemas"]["__schema100"];
                                status: components["schemas"]["__schema102"];
                                text: string;
                            }[];
                        } | components["schemas"]["__schema105"];
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
                                id: components["schemas"]["__schema100"];
                                received_at: components["schemas"]["__schema104"];
                                /** @enum {string} */
                                status: "accepted" | "failed_retry";
                            };
                            turn_id: components["schemas"]["__schema100"];
                        } | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema106"] | components["schemas"]["__schema105"];
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
                            receipts: components["schemas"]["__schema112"][];
                        } | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema106"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema106"] | components["schemas"]["__schema105"];
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
                            draft: components["schemas"]["__schema115"];
                            permission: components["schemas"]["__schema113"] | null;
                            receipt: components["schemas"]["__schema112"] | null;
                        } | components["schemas"]["__schema105"];
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
                    space_id: components["schemas"]["__schema1"];
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
                            episodes: components["schemas"]["__schema82"][];
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
                    space_id: components["schemas"]["__schema1"];
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
                    "application/json": components["schemas"]["__schema6"];
                };
            };
            responses: {
                /** @description Candidate */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema220"];
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
                                app: components["schemas"]["__schema101"];
                                builtin?: boolean;
                                id: components["schemas"]["__schema100"];
                                label: components["schemas"]["__schema101"];
                                /** @enum {string} */
                                status: "available" | "connecting" | "connected" | "error";
                            }[];
                        } | components["schemas"]["__schema105"];
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
                            source_connection: components["schemas"]["__schema100"];
                            title: components["schemas"]["__schema101"];
                            updated_at: components["schemas"]["__schema104"];
                            value: components["schemas"]["__schema101"];
                        } | components["schemas"]["__schema105"];
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
                            artist: components["schemas"]["__schema101"];
                            image?: components["schemas"]["__schema108"];
                            playing: boolean;
                            source_connection: components["schemas"]["__schema100"];
                            title: components["schemas"]["__schema101"];
                        } | components["schemas"]["__schema105"];
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
                            time: components["schemas"]["__schema78"];
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
                            date: components["schemas"]["__schema101"];
                            greeting: components["schemas"]["__schema101"];
                            open_task_count: components["schemas"]["__schema107"];
                            tasks: components["schemas"]["__schema137"][];
                            time_zone: components["schemas"]["__schema101"];
                            upcoming: {
                                connection_id: components["schemas"]["__schema100"];
                                ends_at: components["schemas"]["__schema104"];
                                id: components["schemas"]["__schema100"];
                                starts_at: components["schemas"]["__schema104"];
                                title: components["schemas"]["__schema101"];
                                url?: components["schemas"]["__schema108"];
                            }[] | components["schemas"]["__schema105"];
                            within_day_hours: boolean;
                        } | components["schemas"]["__schema105"];
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
        /** Delegate a responsibility */
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
                        budget?: components["schemas"]["__schema22"];
                        constraints?: components["schemas"]["__schema21"];
                        learning?: components["schemas"]["__schema23"];
                        objective: components["schemas"]["__schema20"];
                        space_id: components["schemas"]["__schema18"];
                        title: components["schemas"]["__schema19"];
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
                        "application/json": components["schemas"]["__schema205"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                header?: never;
                path: {
                    /** @description Job ID */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema34"];
                };
            };
            responses: {
                /** @description Input submission receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema175"];
                    };
                };
                /** @description Submission conflict or rejected transition */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema175"];
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
                            episode: components["schemas"]["__schema82"];
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
                    "application/json": components["schemas"]["__schema2"];
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
                            createdAt: components["schemas"]["__schema78"];
                            inputRefs: string[];
                            jobId: string;
                            scope: components["schemas"]["__schema84"];
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
                        due_at?: components["schemas"]["__schema30"];
                        /** @enum {string} */
                        kind: "timer" | "remote_task" | "local_process";
                        operation_key: string;
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
                        "application/json": components["schemas"]["__schema172"];
                    };
                };
                /** @description Operation key conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema142"];
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
                                    created_at: components["schemas"]["__schema78"];
                                    /** @default null */
                                    evaluation: {
                                        detail: string;
                                        evaluated_at: components["schemas"]["__schema78"];
                                        passed: boolean;
                                    } | null;
                                    fault_kind: components["schemas"]["__schema231"];
                                    id: string;
                                    job_id: string;
                                    kind: string;
                                    /** @default null */
                                    observed_schema: components["schemas"]["__schema170"] | null;
                                    proposed_mapping: {
                                        [key: string]: string;
                                    };
                                    safe: boolean;
                                    /** @enum {string} */
                                    state: "candidate" | "evaluated" | "applied" | "rejected";
                                    test: {
                                        expected: components["schemas"]["__schema170"];
                                        input: components["schemas"]["__schema170"];
                                        name: string;
                                        operation: string;
                                        /** @default [] */
                                        preserves: {
                                            path: string;
                                            value: string;
                                        }[];
                                    };
                                    updated_at: components["schemas"]["__schema78"];
                                }[];
                                /** @default {} */
                                counters: components["schemas"]["__schema229"];
                                /** @default null */
                                disposition: components["schemas"]["__schema228"] | null;
                                effect_class: components["schemas"]["EffectClass"];
                                /** @default null */
                                intent_key: components["schemas"]["__schema227"] | null;
                                job_id: string;
                                kind: string;
                                payload_hash: components["schemas"]["__schema226"];
                                /** @default null */
                                retry_after_at: components["schemas"]["__schema78"] | null;
                                safe_stop: boolean;
                                status: components["schemas"]["ActionStatus"];
                                /** @default [] */
                                trace: components["schemas"]["__schema230"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema142"];
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
                        importance?: components["schemas"]["__schema28"];
                        scheduling_class?: components["schemas"]["__schema27"];
                        unread_threshold?: components["schemas"]["__schema29"];
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
                        "application/json": components["schemas"]["__schema142"];
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
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema205"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema205"];
                    };
                };
                /** @description Job is already finished */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema220"];
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
        /** Answer a question the job is waiting on */
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
                    "application/json": components["schemas"]["__schema34"];
                };
            };
            responses: {
                /** @description Accepted; the job is queued for its next attempt */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema205"];
                    };
                };
                /** @description The job is not waiting for input */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema207"];
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
                                status: components["schemas"]["__schema284"];
                                tags: string[];
                                title: string;
                                type: components["schemas"]["__schema283"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema285"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema285"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        expected_revision: components["schemas"]["__schema36"];
                        frontmatter: components["schemas"]["KnowledgeFrontmatter"];
                        idempotency_key: components["schemas"]["__schema35"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            proposals: components["schemas"]["__schema203"][];
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
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema203"];
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
                        "application/json": components["schemas"]["__schema203"];
                    };
                };
                /** @description Proposal is stale */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                                status: components["schemas"]["__schema284"];
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
                    space_id?: components["schemas"]["__schema0"];
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
                            company: components["schemas"]["__schema75"];
                            item: components["schemas"]["__schema79"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema79"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description Already being handled, already finished, or no longer quotable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description Handling is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        delivered: components["schemas"]["__schema40"][];
                        payload: components["schemas"]["__schema32"];
                        uses: components["schemas"]["__schema39"];
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
                            findings: components["schemas"]["__schema198"][];
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
                                audience: components["schemas"]["__schema180"];
                                current: components["schemas"]["__schema191"];
                                domain_key: components["schemas"]["__schema178"];
                                head_revision: components["schemas"]["__schema179"];
                                hidden: components["schemas"]["__schema195"];
                                id: components["schemas"]["__schema184"];
                                key: components["schemas"]["__schema194"];
                                space_id: components["schemas"]["__schema193"];
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
                                audience: components["schemas"]["__schema180"];
                                domain_key: components["schemas"]["__schema178"];
                                head_revision: components["schemas"]["__schema179"];
                                hidden: components["schemas"]["__schema195"];
                                id: components["schemas"]["__schema184"];
                                key: components["schemas"]["__schema194"];
                                space_id: components["schemas"]["__schema193"];
                            };
                            revisions: components["schemas"]["__schema191"][];
                        };
                    };
                };
                /** @description No such claim */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                                alternative: components["schemas"]["__schema185"];
                                /** @enum {string} */
                                audience: "private" | "space" | "public";
                                claim_id: string;
                                head: components["schemas"]["__schema185"];
                                id: components["schemas"]["__schema196"];
                                key: components["schemas"]["__schema186"];
                                question_id: components["schemas"]["__schema196"] | null;
                                recorded_at: components["schemas"]["__schema78"];
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
                        claim_id: components["schemas"]["__schema37"];
                        content: string;
                        expected_revision: components["schemas"]["__schema36"];
                        idempotency_key: components["schemas"]["__schema35"];
                        text: string;
                        valid_from: components["schemas"]["__schema30"];
                        /** @default null */
                        valid_until?: components["schemas"]["__schema30"] | null;
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        claim_id?: components["schemas"]["__schema37"];
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
                        "application/json": components["schemas"]["__schema192"];
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
                            items: components["schemas"]["__schema133"][];
                        } | components["schemas"]["__schema105"];
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
                        key: components["schemas"]["__schema14"];
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
                            item: components["schemas"]["__schema133"];
                        } | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema120"] | components["schemas"]["__schema105"];
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
                        version: components["schemas"]["__schema10"];
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
                        "application/json": components["schemas"]["__schema120"] | components["schemas"]["__schema105"];
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
                            reasons: components["schemas"]["__schema101"][];
                            used_at: components["schemas"]["__schema104"] | null;
                        } | components["schemas"]["__schema105"];
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
                                affected: components["schemas"]["__schema202"][];
                                changed_handle: components["schemas"]["__schema185"];
                                created_at: components["schemas"]["__schema78"];
                                id: components["schemas"]["__schema196"];
                                job_id: string;
                                key: components["schemas"]["__schema186"] | null;
                                new_value: components["schemas"]["__schema201"];
                                old_value: components["schemas"]["__schema201"];
                                replacement_handle: components["schemas"]["__schema185"] | null;
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
                        output_id: components["schemas"]["__schema38"];
                        output_version: components["schemas"]["__schema38"];
                        uses: components["schemas"]["__schema39"];
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
                            output_id: components["schemas"]["__schema196"];
                            output_version: components["schemas"]["__schema196"];
                            unknown_handles: components["schemas"]["__schema197"][];
                        };
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                                because: components["schemas"]["__schema185"][];
                                created_at: components["schemas"]["__schema78"];
                                id: components["schemas"]["__schema196"];
                                if_ignored: string;
                                key: components["schemas"]["__schema186"];
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
                        at?: components["schemas"]["__schema30"];
                        job_id?: string;
                        /** @default 10 */
                        limit?: components["schemas"]["__schema36"];
                        /** @default 2000 */
                        max_tokens?: components["schemas"]["__schema36"];
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
                                authoritative_revision: components["schemas"]["__schema181"];
                                indexed_revision: components["schemas"]["__schema181"];
                                /** @enum {string} */
                                reason: "ready" | "index_lag" | "budget" | "timeout" | "index_failure" | "restore_pending" | "public_compartment";
                                supplemented: components["schemas"]["__schema181"];
                                truncated: boolean;
                            };
                            /** @default [] */
                            disputed_keys: components["schemas"]["__schema186"][];
                            index_generation: components["schemas"]["__schema181"] | null;
                            items: {
                                claim_id: components["schemas"]["__schema184"];
                                content: string;
                                /** @default false */
                                disputed: boolean;
                                domain_key: components["schemas"]["__schema178"];
                                excerpts: string[];
                                factual_status: components["schemas"]["__schema188"];
                                handle: components["schemas"]["__schema185"];
                                /** @default null */
                                key: components["schemas"]["__schema186"] | null;
                                kind: components["schemas"]["__schema187"];
                                /** @default inferred */
                                origin_trust: components["schemas"]["__schema182"];
                                recorded_at: components["schemas"]["__schema78"];
                                revision: components["schemas"]["__schema179"];
                                sources: components["schemas"]["__schema190"][];
                                status: components["schemas"]["__schema189"];
                                superseded_at: components["schemas"]["__schema78"] | null;
                                valid_from: components["schemas"]["__schema78"];
                                valid_until: components["schemas"]["__schema78"] | null;
                            }[];
                            recipe: components["schemas"]["__schema178"];
                            snapshot: components["schemas"]["__schema183"] | null;
                            /** @enum {string} */
                            status: "complete" | "degraded" | "unavailable";
                            token_budget: {
                                /** @constant */
                                counter: "utf8-bytes-upper-bound-v1";
                                limit: components["schemas"]["__schema179"];
                                used: components["schemas"]["__schema181"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                                recorded_at: components["schemas"]["__schema78"];
                                work_id: components["schemas"]["__schema196"];
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
                        event_at: components["schemas"]["__schema30"];
                        source_identity: components["schemas"]["__schema35"];
                        /** @enum {string} */
                        source_type: "message" | "document" | "observation" | "receipt" | "assistant";
                        source_version: components["schemas"]["__schema35"];
                        stream: components["schemas"]["__schema35"];
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
                            committed_sequence: components["schemas"]["__schema179"];
                            duplicate: boolean;
                            source: components["schemas"]["__schema176"];
                        };
                    };
                };
                /** @description Invalid evidence */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            source: components["schemas"]["__schema176"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema192"];
                    };
                };
                /** @description No such source */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        handles: components["schemas"]["__schema39"];
                        payload: components["schemas"]["__schema32"];
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
                            fields: components["schemas"]["__schema199"][];
                            minimum_trust: components["schemas"]["__schema182"];
                            unresolved: components["schemas"]["__schema200"][];
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
                        "application/json": components["schemas"]["__schema207"];
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
                            reaction: components["schemas"]["__schema206"];
                        };
                    };
                };
                /** @description No such message */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description That event is not a message */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            notifications: components["schemas"]["__schema174"][];
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
                        "application/json": components["schemas"]["__schema174"];
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
                        "application/json": components["schemas"]["__schema174"];
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
                            operations: components["schemas"]["__schema172"][];
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
                        version: components["schemas"]["__schema31"];
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
                        "application/json": components["schemas"]["__schema172"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        due_at: components["schemas"]["__schema30"];
                        version: components["schemas"]["__schema31"];
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
                        "application/json": components["schemas"]["__schema172"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        result: components["schemas"]["__schema32"];
                        version: components["schemas"]["__schema31"];
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
                        "application/json": components["schemas"]["__schema172"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            permissions: components["schemas"]["__schema113"][];
                        } | components["schemas"]["__schema105"];
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
                        version: components["schemas"]["__schema10"];
                    } | {
                        bounds: {
                            count_cap: number;
                            expires_at: components["schemas"]["__schema12"];
                            reconsent_after_days: number;
                        };
                        /** @constant */
                        option: "always";
                        version: components["schemas"]["__schema10"];
                    } | {
                        /** @constant */
                        option: "deny";
                        version: components["schemas"]["__schema10"];
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
                            rule: components["schemas"]["__schema119"] | null;
                            /** @constant */
                            status: "ok";
                        } | components["schemas"]["__schema105"];
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
                            plans: components["schemas"]["__schema134"][];
                        } | components["schemas"]["__schema105"];
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
                        category: components["schemas"]["__schema9"];
                        milestones: components["schemas"]["__schema15"][];
                        title: components["schemas"]["__schema9"];
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
                        "application/json": components["schemas"]["__schema135"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema135"] | components["schemas"]["__schema105"];
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
                    "application/json": components["schemas"]["__schema11"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema106"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema135"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema105"] | components["schemas"]["__schema105"];
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
                                created_at: components["schemas"]["__schema78"];
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
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description Email already registered */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                    space_id: components["schemas"]["__schema1"];
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
                            procedures: components["schemas"]["__schema88"][];
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
                    space_id: components["schemas"]["__schema1"];
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
                        "application/json": components["schemas"]["__schema91"];
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
                        space_id: components["schemas"]["__schema7"];
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
                        "application/json": components["schemas"]["__schema87"];
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
                    "application/json": components["schemas"]["__schema6"];
                };
            };
            responses: {
                /** @description Canary procedure */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                    "application/json": components["schemas"]["__schema6"];
                };
            };
            responses: {
                /** @description Evaluation result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema91"];
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
                    "application/json": components["schemas"]["__schema8"];
                };
            };
            responses: {
                /** @description Rejected history */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                    "application/json": components["schemas"]["__schema8"];
                };
            };
            responses: {
                /** @description Reverted procedure */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema136"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema136"] | components["schemas"]["__schema105"];
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
                            questions: components["schemas"]["__schema168"][];
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
                            error?: components["schemas"]["__schema74"];
                            job: components["schemas"]["__schema142"] | null;
                            question: components["schemas"]["__schema168"];
                            receipt: components["schemas"]["__schema164"] | null;
                        };
                    };
                };
                /** @description The question is no longer open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            questions: components["schemas"]["__schema116"][];
                        } | components["schemas"]["__schema105"];
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
                        option_id: components["schemas"]["__schema10"];
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
                        "application/json": components["schemas"]["__schema120"] | components["schemas"]["__schema105"];
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
                            receipt: components["schemas"]["__schema112"];
                        } | components["schemas"]["__schema105"];
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
                            obligations: components["schemas"]["__schema173"][];
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
                        "application/json": components["schemas"]["__schema173"];
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
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        budget?: components["schemas"]["__schema22"];
                        constraints?: components["schemas"]["__schema21"];
                        /** @default routine */
                        importance?: components["schemas"]["__schema25"];
                        learning?: components["schemas"]["__schema23"];
                        objective: components["schemas"]["__schema20"];
                        /** @default interactive */
                        scheduling_class?: components["schemas"]["__schema24"];
                        space_id: components["schemas"]["__schema18"];
                        title: components["schemas"]["__schema19"];
                        /** @default 3 */
                        unread_threshold?: components["schemas"]["__schema26"];
                    };
                };
            };
            responses: {
                /** @description Accepted responsibility */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error?: components["schemas"]["__schema167"];
                            job: components["schemas"]["__schema142"] | null;
                            receipt: components["schemas"]["__schema164"];
                        };
                    };
                };
                /** @description Submission conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            rules: components["schemas"]["__schema119"][];
                        } | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema120"] | components["schemas"]["__schema105"];
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
                                conversation_id: components["schemas"]["__schema100"] | null;
                                id: components["schemas"]["__schema100"];
                                /** @enum {string} */
                                kind: "conversation" | "plan" | "task" | "event" | "connection" | "action";
                                meta: string;
                                title: components["schemas"]["__schema101"];
                            }[];
                        } | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema105"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema105"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema120"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema120"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema120"] | components["schemas"]["__schema105"];
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
                                    triggers: components["schemas"]["__schema299"][];
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
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema204"];
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
                        "application/json": components["schemas"]["__schema204"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            membership: components["schemas"]["__schema98"];
                        };
                    };
                };
                /** @description Space owner required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            membership: components["schemas"]["__schema98"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                            companies: components["schemas"]["__schema75"][];
                            currency: components["schemas"]["__schema77"];
                            items: components["schemas"]["__schema79"][];
                            totals: {
                                data_holders: number;
                                monthly_spend_minor: components["schemas"]["__schema76"];
                                owed_to_you_minor: components["schemas"]["__schema76"];
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
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description No mailbox is connected to this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                        "application/json": components["schemas"]["__schema73"];
                    };
                };
                /** @description No such scan in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema73"];
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
                            receipt: components["schemas"]["__schema164"];
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
                            tasks: components["schemas"]["__schema137"][];
                        } | components["schemas"]["__schema105"];
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
                    "application/json": components["schemas"]["__schema16"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema138"] | components["schemas"]["__schema105"];
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
                        "application/json": components["schemas"]["__schema120"] | components["schemas"]["__schema105"];
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
                    "application/json": components["schemas"]["__schema16"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema138"] | components["schemas"]["__schema105"];
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
        __schema1: string;
        __schema2: {
            /** @default [] */
            input_refs: components["schemas"]["__schema4"][];
            scope: {
                app: components["schemas"]["__schema3"];
                app_version: components["schemas"]["__schema3"];
                /** @constant */
                audience: "private";
                /** @constant */
                role: "owner";
                task_family: components["schemas"]["__schema3"];
            };
            template_id: components["schemas"]["__schema3"];
        };
        __schema3: string;
        __schema4: components["schemas"]["__schema5"] | string;
        __schema5: string;
        __schema6: {
            space_id: components["schemas"]["__schema7"];
        };
        __schema7: string;
        __schema8: {
            reason: string;
            space_id: components["schemas"]["__schema7"];
        };
        __schema9: string;
        __schema10: string;
        __schema11: {
            agent_id: components["schemas"]["__schema10"];
        };
        /** Format: date-time */
        __schema12: string;
        __schema13: {
            allowed_connection_ids: components["schemas"]["__schema10"][];
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
        __schema14: string;
        __schema15: {
            assignee: {
                /** @constant */
                kind: "person";
            } | {
                agent_id: components["schemas"]["__schema10"];
                /** @constant */
                kind: "agent";
            };
            schedule_at?: components["schemas"]["__schema12"];
            title: components["schemas"]["__schema9"];
        };
        __schema16: {
            /** @default false */
            done: boolean;
            due_at: components["schemas"]["__schema12"] | null;
            title: components["schemas"]["__schema9"];
        };
        __schema17: number;
        __schema18: string;
        __schema19: string;
        __schema20: string;
        __schema21: {
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
        __schema22: {
            max_actions?: number;
            max_attempts?: number;
            max_input_tokens?: number;
            max_output_tokens?: number;
            max_turns?: number;
            max_usd_est?: number;
            max_wall_ms?: number;
        };
        __schema23: components["schemas"]["__schema2"];
        /** @enum {string} */
        __schema24: "interactive" | "background" | "quiet";
        /** @enum {string} */
        __schema25: "routine" | "important";
        __schema26: number;
        __schema27: components["schemas"]["__schema24"];
        __schema28: components["schemas"]["__schema25"];
        __schema29: components["schemas"]["__schema26"];
        /** Format: date-time */
        __schema30: string;
        __schema31: number;
        __schema32: {
            [key: string]: components["schemas"]["__schema33"];
        };
        __schema33: (string | number | boolean | null) | components["schemas"]["__schema33"][] | {
            [key: string]: components["schemas"]["__schema33"];
        };
        __schema34: {
            text: string;
        };
        __schema35: string;
        __schema36: number;
        __schema37: string;
        __schema38: string;
        __schema39: components["schemas"]["__schema4"][];
        __schema40: {
            content: string;
            /** @default [] */
            excerpts: components["schemas"]["__schema41"][];
            handle: components["schemas"]["__schema5"];
            /** @default null */
            key: components["schemas"]["__schema14"] | null;
        };
        __schema41: string;
        __schema42: string;
        __schema43: string;
        __schema44: string;
        /** @enum {string} */
        __schema45: "private" | "space" | "public";
        /** @enum {string} */
        __schema46: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema47: "active" | "superseded" | "retracted" | "disputed";
        /** @enum {string} */
        __schema48: "high" | "medium" | "low";
        /** @enum {string} */
        __schema49: "user" | "agent" | "document" | "tool";
        __schema50: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote: string;
            ref: string;
            /** @default null */
            sha256: string | null;
        };
        /** Format: date */
        __schema51: string;
        /** @default null */
        __schema52: components["schemas"]["__schema51"] | null;
        /** @default [] */
        __schema53: components["schemas"]["__schema42"][];
        /** @default null */
        __schema54: components["schemas"]["__schema42"] | null;
        /** @default [] */
        __schema55: string[];
        /** @default [] */
        __schema56: components["schemas"]["__schema42"][];
        /** @constant */
        __schema57: 1;
        /** @default 0 */
        __schema58: number;
        /** @default 200 */
        __schema59: number;
        __schema60: ("job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error")[];
        __schema61: string;
        __schema62: {
            alias: string;
            /** @default write_external */
            effect_class: components["schemas"]["EffectClass"];
            name: string;
            required_scopes: components["schemas"]["__schema61"][];
        };
        __schema63: string;
        __schema64: number;
        __schema65: string;
        __schema66: string;
        /** @enum {string} */
        __schema67: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema68: string | null;
        __schema69: {
            captured_at: components["schemas"]["__schema30"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema70: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema71: string | null;
        __schema72: string;
        __schema73: {
            error: components["schemas"]["__schema74"];
        };
        __schema74: {
            code: string;
            detail?: {
                [key: string]: unknown;
            };
            message: string;
        };
        __schema75: {
            /** @default null */
            currency: components["schemas"]["__schema77"] | null;
            domain: string;
            first_seen_at: components["schemas"]["__schema78"];
            id: string;
            last_seen_at: components["schemas"]["__schema78"];
            message_count: number;
            /** @default null */
            monthly_spend_minor: components["schemas"]["__schema76"] | null;
            name: string;
            space_id: string;
        };
        __schema76: number;
        __schema77: string;
        /** Format: date-time */
        __schema78: string;
        __schema79: {
            /** @default null */
            amount_minor: components["schemas"]["__schema76"] | null;
            company_id: string;
            confidence: components["schemas"]["__schema80"];
            /** @default null */
            currency: components["schemas"]["__schema77"] | null;
            /** @enum {string} */
            direction: "owed_to_you" | "you_pay" | "you_owe" | "info";
            /** @default null */
            due_at: components["schemas"]["__schema78"] | null;
            evidence: components["schemas"]["__schema81"][];
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
        /** @enum {string} */
        __schema80: "high" | "medium" | "low";
        __schema81: {
            end: number;
            message_id: string;
            quote: string;
            start: number;
        };
        __schema82: {
            actor: string;
            artifacts: components["schemas"]["__schema86"][];
            correctiveJobId?: string | null;
            createdAt: components["schemas"]["__schema78"];
            expiresAt: components["schemas"]["__schema78"];
            failureClass: string | null;
            generationStartedAt: components["schemas"]["__schema78"] | null;
            generationState: string;
            id: components["schemas"]["__schema83"];
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
            receipts: components["schemas"]["__schema86"][];
            restricted: boolean;
            scope: components["schemas"]["__schema84"];
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
        __schema83: string;
        __schema84: {
            app: components["schemas"]["__schema85"];
            app_version: components["schemas"]["__schema85"];
            /** @constant */
            audience: "private";
            /** @constant */
            role: "owner";
            task_family: components["schemas"]["__schema85"];
        };
        __schema85: string;
        __schema86: {
            [key: string]: unknown;
        };
        __schema87: {
            candidate: components["schemas"]["__schema88"];
        };
        __schema88: {
            body: string;
            bodyHash: string;
            canarySpaceId: string | null;
            change: components["schemas"]["__schema86"];
            compatibleModels: string[];
            createdAt: components["schemas"]["__schema78"];
            episodeId: components["schemas"]["__schema83"];
            id: components["schemas"]["__schema89"];
            knownRisk: string;
            predictedBenefit: string;
            /**
             * @default {
             *       "scope": "private",
             *       "principal_id": null
             *     }
             */
            promotion: {
                /** @default null */
                principal_id: string | null;
                /**
                 * @default private
                 * @enum {string}
                 */
                scope: "private" | "space";
            };
            rejectionReason: string | null;
            scope: components["schemas"]["__schema84"];
            selectedEvaluationId: string | null;
            spaceId: string;
            state: components["schemas"]["__schema90"];
            tests: string[];
            version: number;
        };
        __schema89: string;
        /** @enum {string} */
        __schema90: "candidate" | "evaluated" | "enabled_canary" | "active" | "superseded" | "reverted";
        __schema91: {
            candidate: components["schemas"]["__schema88"];
            evaluations: {
                budget: components["schemas"]["__schema86"];
                createdAt: components["schemas"]["__schema78"];
                id: string;
                passed: boolean;
                phase: string;
                selectedAt: components["schemas"]["__schema78"] | null;
            }[];
            history: {
                actor: string;
                candidateId: components["schemas"]["__schema89"];
                createdAt: components["schemas"]["__schema78"];
                fromState: string | null;
                id: string;
                reason: string;
                toState: components["schemas"]["__schema90"];
            }[];
        };
        __schema92: string;
        __schema93: string;
        /** @enum {string} */
        __schema94: "personal" | "shared";
        /** @enum {string} */
        __schema95: "owner" | "space";
        __schema96: string | null;
        __schema97: string;
        __schema98: {
            generation: number;
            principal_id: string;
            revoked_at: components["schemas"]["__schema78"] | null;
            /** @enum {string} */
            role: "owner" | "member";
            space_id: string;
        };
        __schema99: {
            agent_id: components["schemas"]["__schema100"];
            composer: components["schemas"]["__schema103"];
            created_at: components["schemas"]["__schema104"];
            id: components["schemas"]["__schema100"];
            plan_id: components["schemas"]["__schema100"] | null;
            status: components["schemas"]["__schema102"];
            title: components["schemas"]["__schema101"];
            updated_at: components["schemas"]["__schema104"];
        };
        __schema100: string;
        __schema101: string;
        /** @enum {string} */
        __schema102: "idle" | "queued" | "working" | "streaming" | "needs_you" | "paused" | "done" | "failed" | "stopped";
        /** @enum {string} */
        __schema103: "send" | "pause" | "resume" | "stop";
        /** Format: date-time */
        __schema104: string;
        __schema105: {
            reason: components["schemas"]["__schema101"];
            /** @constant */
            status: "not_available";
        };
        __schema106: {
            conversation: components["schemas"]["__schema99"];
        };
        __schema107: number;
        /** Format: uri */
        __schema108: string;
        __schema109: {
            facts: components["schemas"]["__schema110"][];
            id: components["schemas"]["__schema100"];
            image?: components["schemas"]["__schema108"];
            meta: string;
            primary_action: components["schemas"]["__schema111"] | null;
            secondary_actions: components["schemas"]["__schema111"][];
            source_connection: components["schemas"]["__schema100"] | null;
            title: components["schemas"]["__schema101"];
        };
        __schema110: {
            label: components["schemas"]["__schema101"];
            value: components["schemas"]["__schema101"];
        };
        __schema111: {
            handle: components["schemas"]["__schema100"];
            /** @enum {string} */
            kind: "open" | "download" | "send" | "undo";
            label: components["schemas"]["__schema101"];
            url?: components["schemas"]["__schema108"];
        };
        __schema112: {
            id: components["schemas"]["__schema100"];
            undo?: {
                handle: components["schemas"]["__schema100"];
                valid_until: components["schemas"]["__schema104"];
            };
            what: components["schemas"]["__schema101"];
            when: components["schemas"]["__schema104"];
            where: components["schemas"]["__schema101"];
        };
        __schema113: {
            conversation_id: components["schemas"]["__schema100"];
            draft?: components["schemas"]["__schema115"];
            id: components["schemas"]["__schema100"];
            options: components["schemas"]["__schema114"][];
            preview: components["schemas"]["__schema109"] | null;
            version: components["schemas"]["__schema100"];
            what: components["schemas"]["__schema101"];
            why: components["schemas"]["__schema101"][];
        };
        /** @enum {string} */
        __schema114: "allow_once" | "always" | "deny";
        __schema115: {
            bcc?: components["schemas"]["__schema101"][];
            body: string;
            cc?: components["schemas"]["__schema101"][];
            /** @enum {string} */
            channel: "email" | "message";
            connection_id: components["schemas"]["__schema100"];
            id: components["schemas"]["__schema100"];
            recipient: components["schemas"]["__schema101"];
            /** @enum {string} */
            status: "draft" | "awaiting_permission" | "sent" | "discarded";
            subject?: string;
        };
        __schema116: {
            conversation_id: components["schemas"]["__schema100"] | null;
            id: components["schemas"]["__schema100"];
            if_ignored: components["schemas"]["__schema101"];
            options: components["schemas"]["__schema117"];
            text: components["schemas"]["__schema101"];
            why: components["schemas"]["__schema101"][];
        };
        __schema117: components["schemas"]["__schema118"][];
        __schema118: {
            id: components["schemas"]["__schema100"];
            label: components["schemas"]["__schema101"];
        };
        __schema119: {
            bounds: {
                count_cap: number;
                expires_at: components["schemas"]["__schema104"];
                reconsent_after_days: number;
            };
            connection_id: components["schemas"]["__schema100"];
            created_at: components["schemas"]["__schema104"];
            id: components["schemas"]["__schema100"];
            /** @enum {string} */
            kind: "send_message" | "create_event" | "change_event" | "delete_event" | "save_file" | "restore_file" | "discard_draft";
            recipient_class: components["schemas"]["__schema101"];
            text: components["schemas"]["__schema101"];
            used: components["schemas"]["__schema107"];
        };
        __schema120: {
            /** @constant */
            status: "ok";
        };
        __schema121: {
            allowed_connection_ids: components["schemas"]["__schema129"];
            asks_before_acting: components["schemas"]["__schema130"];
            colour: components["schemas"]["__schema124"];
            eye_colour: components["schemas"]["__schema126"];
            face_image?: components["schemas"]["__schema131"];
            id: components["schemas"]["__schema100"];
            name: components["schemas"]["__schema122"];
            role: components["schemas"]["__schema123"];
            space_id: components["schemas"]["__schema100"];
            standing_instruction: components["schemas"]["__schema128"];
            surface: components["schemas"]["__schema125"];
            tone: components["schemas"]["__schema127"];
            usage: {
                conversations: components["schemas"]["__schema107"];
                last_used: components["schemas"]["__schema104"] | null;
            };
        };
        __schema122: string;
        __schema123: string;
        __schema124: string;
        /** @enum {string} */
        __schema125: "rounded" | "blob" | "diamond" | "octagon" | "gear";
        __schema126: string;
        __schema127: string;
        __schema128: string;
        __schema129: components["schemas"]["__schema100"][];
        __schema130: boolean;
        __schema131: components["schemas"]["__schema108"];
        __schema132: {
            agent: components["schemas"]["__schema121"];
        };
        __schema133: {
            created: components["schemas"]["__schema104"];
            editable: boolean;
            id: components["schemas"]["__schema100"];
            key: components["schemas"]["__schema101"];
            last_used: components["schemas"]["__schema104"] | null;
            /** @enum {string} */
            source: "onboarding" | "conversation" | "inferred";
            value: string;
            version: components["schemas"]["__schema100"];
        };
        __schema134: {
            category: components["schemas"]["__schema101"];
            conversation_ids: components["schemas"]["__schema100"][];
            file_ids: components["schemas"]["__schema100"][];
            id: components["schemas"]["__schema100"];
            milestones: {
                assignee: {
                    /** @constant */
                    kind: "person";
                } | {
                    agent_id: components["schemas"]["__schema100"];
                    /** @constant */
                    kind: "agent";
                };
                done: boolean;
                id: components["schemas"]["__schema100"];
                schedule_at?: components["schemas"]["__schema104"];
                status: components["schemas"]["__schema102"];
                title: components["schemas"]["__schema101"];
            }[];
            next_step: components["schemas"]["__schema101"] | null;
            progress_percent: number;
            title: components["schemas"]["__schema101"];
            updated_at: components["schemas"]["__schema104"];
        };
        __schema135: {
            plan: components["schemas"]["__schema134"];
        };
        __schema136: {
            profile: {
                day_hours: {
                    end: string;
                    start: string;
                };
                name: string;
                time_zone: string;
            };
        };
        __schema137: {
            created_at: components["schemas"]["__schema104"];
            /** @default false */
            done: boolean;
            due_at: components["schemas"]["__schema104"] | null;
            id: components["schemas"]["__schema100"];
            title: components["schemas"]["__schema101"];
            updated_at: components["schemas"]["__schema104"];
        };
        __schema138: {
            task: components["schemas"]["__schema137"];
        };
        __schema139: {
            enabled: boolean;
            id: components["schemas"]["__schema100"];
            runs: {
                finished_at: components["schemas"]["__schema104"] | null;
                id: components["schemas"]["__schema100"];
                started_at: components["schemas"]["__schema104"];
                status: components["schemas"]["__schema102"];
            }[];
            schedule: components["schemas"]["__schema101"];
            title: components["schemas"]["__schema101"];
        };
        __schema140: {
            automation: components["schemas"]["__schema139"];
        };
        __schema141: {
            session: {
                id: components["schemas"]["__schema100"];
                preview_frame: components["schemas"]["__schema108"] | null;
                /** @enum {string} */
                status: "working" | "needs_you" | "done" | "stopped";
                task_label: components["schemas"]["__schema101"];
                url: components["schemas"]["__schema108"];
            };
        };
        __schema142: {
            /** @enum {string} */
            attention_status: "normal" | "frequency_reduced" | "needs_attention";
            budget: components["schemas"]["__schema153"];
            cadence_multiplier: number;
            constraints: components["schemas"]["__schema148"];
            created_at: components["schemas"]["__schema78"];
            created_by: components["schemas"]["__schema154"];
            /** @default [] */
            deferred_questions: {
                because: components["schemas"]["__schema158"];
                blocks_external_effect: components["schemas"]["__schema161"];
                created_at: components["schemas"]["__schema78"];
                deadline_at: components["schemas"]["__schema162"];
                if_ignored: components["schemas"]["__schema160"];
                options?: components["schemas"]["__schema163"];
                text: components["schemas"]["__schema157"];
            }[];
            id: components["schemas"]["__schema143"];
            /** @enum {string} */
            importance: "routine" | "important";
            lease_epoch: components["schemas"]["__schema150"];
            next_wake_at: components["schemas"]["__schema151"];
            objective: components["schemas"]["__schema147"];
            principal_id?: components["schemas"]["__schema145"];
            revision: components["schemas"]["__schema149"];
            /** @enum {string} */
            scheduling_class: "interactive" | "background" | "quiet";
            space_id: components["schemas"]["__schema144"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema155"];
            substrate_disposition: components["schemas"]["__schema156"];
            title: components["schemas"]["__schema146"];
            unread_results: number;
            unread_threshold: number;
            updated_at: components["schemas"]["__schema78"];
            visible_status: components["schemas"]["JobState"] | ("frequency_reduced" | "needs_attention");
            wait: components["schemas"]["__schema152"];
        };
        __schema143: string;
        __schema144: string;
        __schema145: string | null;
        __schema146: string;
        __schema147: string;
        __schema148: {
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
        __schema149: number;
        __schema150: number;
        __schema151: components["schemas"]["__schema78"] | null;
        __schema152: {
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
            wake_at: components["schemas"]["__schema78"];
        } | {
            deadline_at: components["schemas"]["__schema78"] | null;
            /** @constant */
            kind: "event";
            trigger_id: string;
        };
        __schema153: {
            max_actions: number;
            max_attempts: number;
            max_input_tokens?: number;
            max_output_tokens: number;
            max_turns: number;
            max_usd_est: number;
            max_wall_ms: number;
        };
        /** @enum {string} */
        __schema154: "owner" | "trigger" | "system";
        __schema155: number;
        /** @enum {string} */
        __schema156: "remote_recoverable" | "timer_or_event" | "local_process_interrupted" | "external_uncertain";
        __schema157: string;
        __schema158: components["schemas"]["__schema159"][];
        __schema159: string;
        __schema160: string;
        /** @default false */
        __schema161: boolean;
        /** @default null */
        __schema162: components["schemas"]["__schema78"] | null;
        __schema163: components["schemas"]["__schema117"];
        __schema164: {
            event_cursor: number | null;
            input_digest: components["schemas"]["__schema166"] | null;
            job_id: string | null;
            job_revision: number | null;
            /** @enum {string} */
            state: "accepted" | "rejected" | "unknown_durability";
            submission_id: components["schemas"]["__schema165"];
        };
        __schema165: string;
        __schema166: string;
        __schema167: components["schemas"]["__schema74"];
        __schema168: {
            answer: string | null;
            answered_at: components["schemas"]["__schema78"] | null;
            attempt_id: string | null;
            because: components["schemas"]["__schema158"];
            blocks_external_effect: components["schemas"]["__schema161"];
            created_at: components["schemas"]["__schema78"];
            deadline_at: components["schemas"]["__schema162"];
            id: string;
            if_ignored: components["schemas"]["__schema160"];
            job_id: string | null;
            job_title: string | null;
            key: string | null;
            options?: components["schemas"]["__schema163"];
            /** @enum {string} */
            source: "job" | "memory";
            space_id: string | null;
            /** @enum {string} */
            state: "open" | "answered" | "withdrawn";
            text: components["schemas"]["__schema157"];
        };
        __schema169: {
            actions: {
                dispatched_at: components["schemas"]["__schema78"] | null;
                id: string;
                job_id: string;
                receipt: components["schemas"]["__schema170"] | null;
                status: string;
            }[];
            cursor: number;
            epoch: number | null;
            jobs: components["schemas"]["__schema142"][];
        };
        __schema170: {
            [key: string]: components["schemas"]["__schema171"];
        };
        __schema171: (string | number | boolean | null) | components["schemas"]["__schema171"][] | {
            [key: string]: components["schemas"]["__schema171"];
        };
        __schema172: {
            due_at: components["schemas"]["__schema78"];
            id: string;
            job_id: string;
            /** @enum {string} */
            kind: "timer" | "remote_task" | "local_process";
            operation_key: components["schemas"]["__schema165"];
            remote_ref: string | null;
            result: components["schemas"]["__schema170"] | null;
            /** @enum {string} */
            state: "registered" | "ready" | "claimed" | "settled" | "interrupted" | "unknown";
            substrate_disposition: components["schemas"]["__schema156"];
            version: number;
        };
        __schema173: {
            acknowledged_at: components["schemas"]["__schema78"] | null;
            coalesce_key: string;
            created_at: components["schemas"]["__schema78"];
            fulfilled_at: components["schemas"]["__schema78"] | null;
            id: string;
            job_id: string | null;
            /** @enum {string} */
            kind: "direct" | "quiet";
            message: string | null;
            /** @enum {string} */
            state: "owed" | "acknowledged" | "fulfilled" | "needs_retransmission";
            submission_id: components["schemas"]["__schema165"];
        };
        __schema174: {
            attempted_at: components["schemas"]["__schema78"] | null;
            because: components["schemas"]["__schema159"][];
            coalesce_key: string;
            content: {
                attempt_id: string;
                job_id: string;
                /** @enum {string} */
                kind: "answer" | "question" | "status";
                text: string;
            } | null;
            content_hash: components["schemas"]["__schema166"];
            created_at: components["schemas"]["__schema78"];
            delivered_at: components["schemas"]["__schema78"] | null;
            delivery_attempt: number;
            delivery_key: string;
            id: string;
            if_ignored: components["schemas"]["__schema160"];
            obligation_ids: string[];
            /** @enum {string} */
            state: "pending" | "attempted" | "delivered" | "superseded";
        };
        __schema175: {
            error?: components["schemas"]["__schema167"];
            job: components["schemas"]["Job"] | null;
            receipt: components["schemas"]["__schema164"];
        };
        __schema176: {
            audience: components["schemas"]["__schema180"];
            /**
             * @default owner
             * @enum {string}
             */
            author: "owner" | "external";
            content_ref: string | null;
            eligibility_generation: components["schemas"]["__schema181"];
            event_at: components["schemas"]["__schema78"];
            ingested_at: components["schemas"]["__schema78"];
            origin_trust: components["schemas"]["__schema182"];
            owner_id: string;
            publisher: components["schemas"]["__schema178"];
            source_id: components["schemas"]["__schema177"];
            source_identity: components["schemas"]["__schema178"];
            /** @enum {string} */
            source_type: "message" | "document" | "observation" | "receipt" | "assistant" | "owner_edit";
            source_version: components["schemas"]["__schema178"];
            space_id: string;
            /** @enum {string} */
            state: "active" | "suppressed" | "deleted" | "revoked";
            stream: components["schemas"]["__schema178"];
            stream_sequence: components["schemas"]["__schema179"];
        };
        __schema177: string;
        __schema178: string;
        __schema179: number;
        /** @enum {string} */
        __schema180: "private" | "space" | "public";
        __schema181: number;
        /** @enum {string} */
        __schema182: "owner" | "verified_connector" | "external_content" | "inferred" | "unknown";
        __schema183: {
            access_generation: components["schemas"]["__schema181"];
            data_revision: components["schemas"]["__schema181"];
            eligibility_generation: components["schemas"]["__schema181"];
            policy_generation: components["schemas"]["__schema181"];
            restore_ready: boolean;
            space_id: string;
        };
        __schema184: string;
        __schema185: string;
        __schema186: string;
        /** @enum {string} */
        __schema187: "user_statement" | "document_assertion" | "checked_fact" | "inferred" | "preference" | "exception" | "historical";
        /** @enum {string} */
        __schema188: "attributed" | "checked" | "tentative" | "disputed";
        /** @enum {string} */
        __schema189: "active" | "superseded" | "historical" | "retracted" | "disputed";
        __schema190: {
            end: components["schemas"]["__schema179"];
            source_id: components["schemas"]["__schema177"];
            source_version: components["schemas"]["__schema178"];
            start: components["schemas"]["__schema181"];
        };
        __schema191: {
            claim_id: components["schemas"]["__schema184"];
            content: string | null;
            data_revision: components["schemas"]["__schema179"];
            factual_status: components["schemas"]["__schema188"];
            kind: components["schemas"]["__schema187"];
            /** @default inferred */
            origin_trust: components["schemas"]["__schema182"];
            protected: boolean;
            recorded_at: components["schemas"]["__schema78"];
            revision: components["schemas"]["__schema179"];
            sources: components["schemas"]["__schema190"][];
            status: components["schemas"]["__schema189"];
            superseded_at: components["schemas"]["__schema78"] | null;
            valid_from: components["schemas"]["__schema78"];
            valid_until: components["schemas"]["__schema78"] | null;
        };
        __schema192: {
            /** @enum {string} */
            cleanup: "pending" | "complete";
            generation: components["schemas"]["__schema183"];
        };
        __schema193: string;
        /** @default null */
        __schema194: components["schemas"]["__schema186"] | null;
        __schema195: boolean;
        __schema196: string;
        __schema197: string;
        __schema198: {
            field: string;
            handle: components["schemas"]["__schema185"];
            key: components["schemas"]["__schema186"] | null;
            /** @enum {string} */
            kind: "recipient" | "date" | "amount" | "identifier";
            value: string;
        };
        __schema199: {
            description: string;
            field: string;
            handle: (components["schemas"]["__schema185"] | string) | null;
            origin_trust: components["schemas"]["__schema182"];
            value: string;
        };
        __schema200: string;
        __schema201: string;
        __schema202: {
            /** @enum {string} */
            kind: "artifact" | "plan_step" | "action";
            location: string | null;
            output_id: components["schemas"]["__schema196"];
            output_version: components["schemas"]["__schema196"];
        };
        __schema203: {
            diff: string;
            id: components["schemas"]["__schema178"];
            path: string;
            /** @enum {string} */
            status: "pending" | "applied" | "discarded";
        };
        __schema204: {
            spaces: components["schemas"]["Space"][];
        };
        __schema205: {
            job: components["schemas"]["Job"];
        };
        __schema206: {
            /** @enum {string} */
            by: "person" | "assistant";
            created_at: components["schemas"]["__schema78"];
            emoji: string;
            job_id: string | null;
            message_id: string;
            seq: number;
        };
        __schema207: {
            reactions: components["schemas"]["__schema206"][];
        };
        __schema208: string;
        __schema209: string;
        __schema210: number;
        __schema211: string;
        __schema212: string;
        __schema213: string;
        __schema214: string | null;
        __schema215: {
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
        __schema216: components["schemas"]["__schema78"] | null;
        __schema217: ("completed" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "failed" | "budget_exhausted" | "fenced" | "unknown_check") | null;
        __schema218: components["schemas"]["__schema170"] | null;
        __schema219: string | null;
        __schema220: {
            events: components["schemas"]["Event"][];
            has_more: boolean;
            next_cursor: number;
        };
        __schema221: number;
        __schema222: string | null;
        __schema223: string | null;
        /** @enum {string} */
        __schema224: "job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error";
        __schema225: string;
        __schema226: string;
        __schema227: string;
        /** @enum {string} */
        __schema228: "completed" | "parked_until_retry" | "needs_reconciliation" | "needs_reconnect" | "needs_input" | "repair_exhausted";
        __schema229: {
            [key: string]: number;
        };
        __schema230: {
            at: components["schemas"]["__schema78"];
            attempt: number;
            /** @default null */
            candidate_id: string | null;
            /** @enum {string} */
            decision: "verified_completion" | "retry_with_backoff" | "park_until_retry_after" | "refresh_credential_once" | "stop_connection_revoked" | "rediscover_schema" | "record_repair_candidate" | "apply_safe_mapping" | "change_route" | "reconcile_by_verify" | "revise_and_revalidate" | "stop_needs_input" | "escalate_diagnosis";
            /** @default null */
            delay_ms: number | null;
            detail: string;
            /** @default null */
            fault_kind: components["schemas"]["__schema231"] | null;
            payload_hash: components["schemas"]["__schema226"];
            /** @default null */
            retry_after: components["schemas"]["__schema78"] | null;
            /** @default null */
            route: string | null;
        }[];
        /** @enum {string} */
        __schema231: "transient_before_dispatch" | "rate_limited" | "expired_credential" | "revoked_credential" | "schema_drift" | "unsupported_route" | "uncertain_outcome" | "bad_output" | "unclassified";
        __schema232: string;
        __schema233: string;
        __schema234: string;
        __schema235: string;
        __schema236: string;
        /** @default null */
        __schema237: components["schemas"]["__schema227"] | null;
        __schema238: string | null;
        __schema239: string | null;
        __schema240: string;
        __schema241: components["schemas"]["__schema78"] | null;
        __schema242: components["schemas"]["__schema170"] | null;
        __schema243: components["schemas"]["__schema78"] | null;
        __schema244: components["schemas"]["__schema170"] | null;
        /** @default [] */
        __schema245: components["schemas"]["__schema230"];
        /** @default {} */
        __schema246: components["schemas"]["__schema229"];
        /** @default null */
        __schema247: components["schemas"]["__schema228"] | null;
        /** @default null */
        __schema248: components["schemas"]["__schema78"] | null;
        __schema249: {
            action: components["schemas"]["Action"];
        };
        __schema250: string;
        __schema251: string;
        /** @enum {string} */
        __schema252: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp";
        __schema253: string;
        __schema254: string[];
        /** @enum {string} */
        __schema255: "active" | "disabled" | "error" | "revoked";
        /** @enum {string} */
        __schema256: "unknown" | "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema257: "available" | "connecting" | "connected" | "error";
        __schema258: number;
        __schema259: boolean;
        __schema260: components["schemas"]["__schema78"] | null;
        __schema261: {
            check?: components["schemas"]["ConnectionCheck"];
            connection: components["schemas"]["Connection"];
        };
        /** @enum {string} */
        __schema262: "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema263: "ok" | "degraded" | "unavailable" | "not_running" | "revoked";
        __schema264: string;
        /** @enum {string} */
        __schema265: "mail" | "caldav" | "ics" | "mcp";
        __schema266: string;
        __schema267: string;
        __schema268: {
            path: string;
            value: components["schemas"]["__schema269"];
        }[];
        __schema269: string | number | boolean;
        __schema270: components["schemas"]["ConnectionFormField"][];
        __schema271: string;
        __schema272: string;
        __schema273: string;
        __schema274: boolean;
        __schema275: boolean;
        __schema276: string;
        __schema277: components["schemas"]["__schema269"];
        __schema278: {
            label: string;
            value: string;
        }[];
        __schema279: components["schemas"]["__schema280"] | "list";
        /** @enum {string} */
        __schema280: "text" | "email" | "url" | "number" | "password" | "checkbox" | "select" | "string_list";
        __schema281: {
            default?: components["schemas"]["__schema277"];
            help?: components["schemas"]["__schema273"];
            input: components["schemas"]["__schema280"];
            label: components["schemas"]["__schema272"];
            options?: components["schemas"]["__schema278"];
            path: components["schemas"]["__schema271"];
            placeholder?: components["schemas"]["__schema276"];
            required: components["schemas"]["__schema274"];
            secret: components["schemas"]["__schema275"];
        }[];
        __schema282: {
            asks_first: boolean;
            default: boolean;
            effect_class: components["schemas"]["EffectClass"];
            label: string;
            scope: string;
        }[];
        /** @enum {string} */
        __schema283: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema284: "active" | "superseded" | "retracted" | "disputed";
        __schema285: {
            body: string;
            frontmatter: components["schemas"]["KnowledgeFrontmatterOutput"];
            id: string;
            path: string;
        };
        __schema286: string;
        __schema287: string;
        __schema288: string;
        /** @enum {string} */
        __schema289: "private" | "space" | "public";
        /** @enum {string} */
        __schema290: "user" | "agent" | "document" | "tool";
        __schema291: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote: string;
            ref: string;
            /** @default null */
            sha256: string | null;
        };
        /** Format: date */
        __schema292: string;
        /** @default null */
        __schema293: components["schemas"]["__schema292"] | null;
        /** @default [] */
        __schema294: components["schemas"]["__schema286"][];
        /** @default null */
        __schema295: components["schemas"]["__schema286"] | null;
        /** @default [] */
        __schema296: string[];
        /** @default [] */
        __schema297: components["schemas"]["__schema286"][];
        /** @constant */
        __schema298: 1;
        __schema299: string;
        __schema300: string;
        __schema301: number;
        /** @enum {string} */
        __schema302: "automation" | "human";
        /** @constant */
        __schema303: true;
        __schema304: string;
        __schema305: number;
        __schema306: string;
        __schema307: string;
        /** @enum {string} */
        __schema308: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema309: string | null;
        __schema310: {
            captured_at: components["schemas"]["__schema78"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema311: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema312: string | null;
        __schema313: string;
        Action: {
            attempt_id: components["schemas"]["__schema234"];
            authorization_ref: components["schemas"]["__schema238"];
            budget_reservation: components["schemas"]["__schema239"];
            canonical_payload: components["schemas"]["__schema170"];
            connection_id: components["schemas"]["__schema235"];
            created_at: components["schemas"]["__schema78"];
            dispatched_at: components["schemas"]["__schema241"];
            effect_class: components["schemas"]["EffectClass"];
            id: components["schemas"]["__schema232"];
            idempotency_key: components["schemas"]["__schema240"];
            intent_key: components["schemas"]["__schema237"];
            job_id: components["schemas"]["__schema233"];
            kind: components["schemas"]["__schema236"];
            payload_hash: components["schemas"]["__schema226"];
            receipt: components["schemas"]["__schema242"];
            reconciliation: components["schemas"]["__schema244"];
            repair_counters: components["schemas"]["__schema246"];
            repair_disposition: components["schemas"]["__schema247"];
            repair_trace: components["schemas"]["__schema245"];
            resolved_at: components["schemas"]["__schema243"];
            retry_after_at: components["schemas"]["__schema248"];
            status: components["schemas"]["ActionStatus"];
        };
        /** @enum {string} */
        ActionStatus: "proposed" | "needs_approval" | "approved" | "denied" | "admitted" | "dispatched" | "succeeded" | "failed" | "unknown" | "unresolved";
        Attempt: {
            context_snapshot_ref: components["schemas"]["__schema219"];
            ended_at: components["schemas"]["__schema216"];
            epoch: components["schemas"]["__schema210"];
            id: components["schemas"]["__schema208"];
            job_id: components["schemas"]["__schema209"];
            model: components["schemas"]["__schema213"];
            model_actual: components["schemas"]["__schema214"];
            outcome: components["schemas"]["__schema217"];
            outcome_detail: components["schemas"]["__schema218"];
            provider: components["schemas"]["__schema212"];
            runtime_version: components["schemas"]["__schema211"];
            started_at: components["schemas"]["__schema78"];
            usage: components["schemas"]["__schema215"];
        };
        BrowserControlResponse: {
            control: components["schemas"]["__schema302"];
            control_epoch: components["schemas"]["__schema301"];
            fresh_observation_required: components["schemas"]["__schema303"];
            session_id: components["schemas"]["__schema300"];
        };
        Connection: {
            builtin?: components["schemas"]["__schema259"];
            created_at: components["schemas"]["__schema78"];
            generation?: components["schemas"]["__schema258"];
            health: components["schemas"]["__schema256"];
            id: components["schemas"]["__schema250"];
            label: components["schemas"]["__schema253"];
            last_checked_at: components["schemas"]["__schema260"];
            provider: components["schemas"]["__schema252"];
            scopes: components["schemas"]["__schema254"];
            setup_state?: components["schemas"]["__schema257"];
            space_id: components["schemas"]["__schema251"];
            status: components["schemas"]["__schema255"];
        };
        ConnectionCheck: {
            checked_at: components["schemas"]["__schema78"];
            code: components["schemas"]["__schema263"];
            detail: components["schemas"]["__schema264"];
            status: components["schemas"]["__schema262"];
        };
        ConnectionFormField: {
            default?: components["schemas"]["__schema277"];
            help?: components["schemas"]["__schema273"];
            input: components["schemas"]["__schema279"];
            item_fields?: components["schemas"]["__schema281"];
            label: components["schemas"]["__schema272"];
            options?: components["schemas"]["__schema278"];
            path: components["schemas"]["__schema271"];
            placeholder?: components["schemas"]["__schema276"];
            required: components["schemas"]["__schema274"];
            secret: components["schemas"]["__schema275"];
        };
        ConnectionKind: {
            description: components["schemas"]["__schema267"];
            fields: components["schemas"]["__schema270"];
            fixed: components["schemas"]["__schema268"];
            kind: components["schemas"]["__schema265"];
            scopes: components["schemas"]["__schema282"];
            title: components["schemas"]["__schema266"];
        };
        /** @enum {string} */
        EffectClass: "read" | "write_reversible" | "write_external" | "spend";
        Event: {
            attempt_id: components["schemas"]["__schema223"];
            created_at: components["schemas"]["__schema78"];
            dedup_key: components["schemas"]["__schema225"];
            job_id: components["schemas"]["__schema222"];
            payload: components["schemas"]["__schema170"];
            seq: components["schemas"]["__schema221"];
            type: components["schemas"]["__schema224"];
        };
        HookObservation: {
            capture_id: components["schemas"]["__schema307"];
            name: components["schemas"]["__schema308"];
            outcome: components["schemas"]["__schema311"];
            redacted_args_digest: components["schemas"]["__schema312"];
            timing: components["schemas"]["__schema310"];
            tool_name: components["schemas"]["__schema309"];
        };
        Job: {
            budget: components["schemas"]["__schema153"];
            constraints: components["schemas"]["__schema148"];
            created_at: components["schemas"]["__schema78"];
            created_by: components["schemas"]["__schema154"];
            id: components["schemas"]["__schema143"];
            lease_epoch: components["schemas"]["__schema150"];
            next_wake_at: components["schemas"]["__schema151"];
            objective: components["schemas"]["__schema147"];
            principal_id?: components["schemas"]["__schema145"];
            revision: components["schemas"]["__schema149"];
            space_id: components["schemas"]["__schema144"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema155"];
            title: components["schemas"]["__schema146"];
            updated_at: components["schemas"]["__schema78"];
            wait: components["schemas"]["__schema152"];
        };
        /** @enum {string} */
        JobState: "queued" | "running" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "needs_reconciliation" | "completed" | "failed" | "cancelled";
        KnowledgeFrontmatter: {
            asserted_by: components["schemas"]["__schema49"];
            audience: components["schemas"]["__schema45"];
            confidence: components["schemas"]["__schema48"];
            created: components["schemas"]["__schema51"];
            id: components["schemas"]["__schema42"];
            links?: components["schemas"]["__schema56"];
            observed_at: components["schemas"]["__schema51"];
            schema_version: components["schemas"]["__schema57"];
            source: components["schemas"]["__schema50"];
            space: components["schemas"]["__schema44"];
            status: components["schemas"]["__schema47"];
            superseded_by?: components["schemas"]["__schema54"];
            supersedes?: components["schemas"]["__schema53"];
            tags?: components["schemas"]["__schema55"];
            title: components["schemas"]["__schema43"];
            type: components["schemas"]["__schema46"];
            updated: components["schemas"]["__schema51"];
            valid_from: components["schemas"]["__schema51"];
            valid_until?: components["schemas"]["__schema52"];
        };
        KnowledgeFrontmatterOutput: {
            asserted_by: components["schemas"]["__schema290"];
            audience: components["schemas"]["__schema289"];
            confidence: components["schemas"]["__schema80"];
            created: components["schemas"]["__schema292"];
            id: components["schemas"]["__schema286"];
            links: components["schemas"]["__schema297"];
            observed_at: components["schemas"]["__schema292"];
            schema_version: components["schemas"]["__schema298"];
            source: components["schemas"]["__schema291"];
            space: components["schemas"]["__schema288"];
            status: components["schemas"]["__schema284"];
            superseded_by: components["schemas"]["__schema295"];
            supersedes: components["schemas"]["__schema294"];
            tags: components["schemas"]["__schema296"];
            title: components["schemas"]["__schema287"];
            type: components["schemas"]["__schema283"];
            updated: components["schemas"]["__schema292"];
            valid_from: components["schemas"]["__schema292"];
            valid_until: components["schemas"]["__schema293"];
        };
        RuntimeEvent: {
            at: components["schemas"]["__schema78"];
            attempt_id: components["schemas"]["__schema304"];
            capture_id: components["schemas"]["__schema307"];
            dedup_key: components["schemas"]["__schema306"];
            local_seq: components["schemas"]["__schema305"];
            name: components["schemas"]["__schema308"];
            outcome: components["schemas"]["__schema311"];
            redacted_args_digest: components["schemas"]["__schema312"];
            timing: components["schemas"]["__schema310"];
            tool_name: components["schemas"]["__schema309"];
            /** @constant */
            type: "hook_event";
        } | {
            at: components["schemas"]["__schema78"];
            attempt_id: components["schemas"]["__schema304"];
            capture_id: components["schemas"]["__schema307"];
            dedup_key: components["schemas"]["__schema306"];
            /** @enum {string} */
            error_code: "observer_failed" | "delivery_failed" | "capture_gap";
            local_seq: components["schemas"]["__schema305"];
            name: components["schemas"]["__schema308"];
            outcome: components["schemas"]["__schema311"];
            redacted_args_digest: components["schemas"]["__schema312"];
            timing: components["schemas"]["__schema310"];
            tool_name: components["schemas"]["__schema309"];
            /** @constant */
            type: "hook_error";
        } | {
            at: components["schemas"]["__schema78"];
            attempt_id: components["schemas"]["__schema304"];
            dedup_key: components["schemas"]["__schema306"];
            local_seq: components["schemas"]["__schema305"];
            turn: number;
            /** @constant */
            type: "turn_started";
        } | {
            at: components["schemas"]["__schema78"];
            attempt_id: components["schemas"]["__schema304"];
            dedup_key: components["schemas"]["__schema306"];
            local_seq: components["schemas"]["__schema305"];
            text: string;
            /** @constant */
            type: "text_delta";
        } | {
            arguments: components["schemas"]["__schema170"];
            at: components["schemas"]["__schema78"];
            attempt_id: components["schemas"]["__schema304"];
            call_id: string;
            dedup_key: components["schemas"]["__schema306"];
            local_seq: components["schemas"]["__schema305"];
            tool: string;
            /** @constant */
            type: "tool_call_proposed";
        } | {
            at: components["schemas"]["__schema78"];
            attempt_id: components["schemas"]["__schema304"];
            call_id: string;
            dedup_key: components["schemas"]["__schema306"];
            local_seq: components["schemas"]["__schema305"];
            ok: boolean;
            result: components["schemas"]["__schema170"];
            /** @constant */
            type: "tool_result";
        } | {
            action_id: string;
            at: components["schemas"]["__schema78"];
            attempt_id: components["schemas"]["__schema304"];
            dedup_key: components["schemas"]["__schema306"];
            kind: string;
            local_seq: components["schemas"]["__schema305"];
            /** @constant */
            type: "action_requested";
        } | {
            at: components["schemas"]["__schema78"];
            attempt_id: components["schemas"]["__schema304"];
            dedup_key: components["schemas"]["__schema306"];
            local_seq: components["schemas"]["__schema305"];
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
                action_ids: components["schemas"]["__schema313"][];
                /** @constant */
                kind: "waiting_for_approval";
            } | {
                /** @constant */
                kind: "waiting_for_event_or_time";
                wait: components["schemas"]["__schema152"];
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
            usage?: components["schemas"]["__schema215"];
        } | {
            after_seq: number;
            at: components["schemas"]["__schema78"];
            attempt_id: components["schemas"]["__schema304"];
            dedup_key: components["schemas"]["__schema306"];
            local_seq: components["schemas"]["__schema305"];
            reason: string;
            /** @constant */
            type: "gap";
        };
        Space: {
            audience: components["schemas"]["__schema95"];
            created_at: components["schemas"]["__schema78"];
            git_path: components["schemas"]["__schema97"];
            id: components["schemas"]["__schema92"];
            kind: components["schemas"]["__schema94"];
            name: components["schemas"]["__schema93"];
            owner_principal_id?: components["schemas"]["__schema96"];
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
