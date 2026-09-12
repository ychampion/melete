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
                        "application/json": components["schemas"]["__schema174"];
                    };
                };
                /** @description No such action */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema174"];
                    };
                };
                /** @description Action is not awaiting reconciliation */
                409: {
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
                                canonical_payload: components["schemas"]["__schema90"];
                                connection_id: string;
                                effect_class: components["schemas"]["EffectClass"];
                                expires_at: components["schemas"]["__schema56"] | null;
                                job_id: string;
                                job_revision: number;
                                kind: string;
                                /** @default [] */
                                origin_warnings: {
                                    description: string;
                                    field: string;
                                    handle: string | null;
                                    origin_trust: components["schemas"]["__schema102"];
                                }[];
                                payload_hash: components["schemas"]["__schema151"];
                                requested_at: components["schemas"]["__schema56"];
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
                            decided_at: components["schemas"]["__schema56"];
                            /** @enum {string} */
                            decision: "approved" | "denied";
                            payload_hash: components["schemas"]["__schema151"];
                        };
                    };
                };
                /** @description The payload changed since this approval was requested */
                409: {
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
                        "application/json": components["schemas"]["__schema87"];
                    };
                };
                /** @description No matching artifact in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema87"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
                    };
                };
                /** @description Browser control could not change */
                409: {
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
                        "application/json": components["schemas"]["__schema87"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
                    };
                };
                /** @description Browser control could not change */
                409: {
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
        /** Add a connection */
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
                        credentials?: {
                            [key: string]: string;
                        };
                        label: string;
                        /** @enum {string} */
                        provider: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp";
                        /** @default [] */
                        scopes?: string[];
                        space_id: string;
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
                        "application/json": components["schemas"]["__schema183"];
                    };
                };
                /** @description Invalid request */
                400: {
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
                        "application/json": components["schemas"]["__schema183"];
                    };
                };
                /** @description No such connection */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
        /** Check a connection now */
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
                /** @description Connection */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema183"];
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
                            episodes: components["schemas"]["__schema51"][];
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
                    "application/json": components["schemas"]["__schema5"];
                };
            };
            responses: {
                /** @description Candidate */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema57"];
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
                    after?: components["schemas"]["__schema48"];
                    limit?: components["schemas"]["__schema49"];
                    types?: components["schemas"]["__schema50"];
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
                        "application/json": components["schemas"]["__schema145"];
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
                            /** @enum {string} */
                            status: "ok" | "degraded";
                            time: components["schemas"]["__schema56"];
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
                        budget?: components["schemas"]["__schema12"];
                        constraints?: components["schemas"]["__schema11"];
                        learning?: components["schemas"]["__schema13"];
                        objective: components["schemas"]["__schema10"];
                        space_id: components["schemas"]["__schema8"];
                        title: components["schemas"]["__schema9"];
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
                        "application/json": components["schemas"]["__schema130"];
                    };
                };
                /** @description Invalid request */
                400: {
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
                    "application/json": components["schemas"]["__schema24"];
                };
            };
            responses: {
                /** @description Input submission receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema95"];
                    };
                };
                /** @description Submission conflict or rejected transition */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema95"];
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
                            episode: components["schemas"]["__schema51"];
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
                            createdAt: components["schemas"]["__schema56"];
                            inputRefs: string[];
                            jobId: string;
                            scope: components["schemas"]["__schema53"];
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
                        due_at?: components["schemas"]["__schema20"];
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
                        "application/json": components["schemas"]["__schema92"];
                    };
                };
                /** @description Operation key conflict */
                409: {
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
                        "application/json": components["schemas"]["__schema62"];
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
                                    created_at: components["schemas"]["__schema56"];
                                    /** @default null */
                                    evaluation: {
                                        detail: string;
                                        evaluated_at: components["schemas"]["__schema56"];
                                        passed: boolean;
                                    } | null;
                                    fault_kind: components["schemas"]["__schema156"];
                                    id: string;
                                    job_id: string;
                                    kind: string;
                                    /** @default null */
                                    observed_schema: components["schemas"]["__schema90"] | null;
                                    proposed_mapping: {
                                        [key: string]: string;
                                    };
                                    safe: boolean;
                                    /** @enum {string} */
                                    state: "candidate" | "evaluated" | "applied" | "rejected";
                                    test: {
                                        expected: components["schemas"]["__schema90"];
                                        input: components["schemas"]["__schema90"];
                                        name: string;
                                        operation: string;
                                        /** @default [] */
                                        preserves: {
                                            path: string;
                                            value: string;
                                        }[];
                                    };
                                    updated_at: components["schemas"]["__schema56"];
                                }[];
                                /** @default {} */
                                counters: components["schemas"]["__schema154"];
                                /** @default null */
                                disposition: components["schemas"]["__schema153"] | null;
                                effect_class: components["schemas"]["EffectClass"];
                                /** @default null */
                                intent_key: components["schemas"]["__schema152"] | null;
                                job_id: string;
                                kind: string;
                                payload_hash: components["schemas"]["__schema151"];
                                /** @default null */
                                retry_after_at: components["schemas"]["__schema56"] | null;
                                safe_stop: boolean;
                                status: components["schemas"]["ActionStatus"];
                                /** @default [] */
                                trace: components["schemas"]["__schema155"];
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
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema62"];
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
                        importance?: components["schemas"]["__schema18"];
                        scheduling_class?: components["schemas"]["__schema17"];
                        unread_threshold?: components["schemas"]["__schema19"];
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
                        "application/json": components["schemas"]["__schema62"];
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
                        "application/json": components["schemas"]["__schema89"];
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
                        "application/json": components["schemas"]["__schema130"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema130"];
                    };
                };
                /** @description Job is already finished */
                409: {
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
                    after?: components["schemas"]["__schema48"];
                    limit?: components["schemas"]["__schema49"];
                    types?: components["schemas"]["__schema50"];
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
                        "application/json": components["schemas"]["__schema145"];
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
                    "application/json": components["schemas"]["__schema24"];
                };
            };
            responses: {
                /** @description Accepted; the job is queued for its next attempt */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema130"];
                    };
                };
                /** @description The job is not waiting for input */
                409: {
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
                        "application/json": components["schemas"]["__schema132"];
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
                                status: components["schemas"]["__schema185"];
                                tags: string[];
                                title: string;
                                type: components["schemas"]["__schema184"];
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
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema186"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema186"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                        expected_revision: components["schemas"]["__schema26"];
                        frontmatter: components["schemas"]["KnowledgeFrontmatter"];
                        idempotency_key: components["schemas"]["__schema25"];
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
                        "application/json": components["schemas"]["__schema111"];
                    };
                };
                /** @description Stale revision */
                409: {
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
                            proposals: components["schemas"]["__schema123"][];
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
                        "application/json": components["schemas"]["__schema123"];
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
                        "application/json": components["schemas"]["__schema123"];
                    };
                };
                /** @description Proposal is stale */
                409: {
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
                                status: components["schemas"]["__schema185"];
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
                        delivered: components["schemas"]["__schema30"][];
                        payload: components["schemas"]["__schema22"];
                        uses: components["schemas"]["__schema29"];
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
                            findings: components["schemas"]["__schema118"][];
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
                                audience: components["schemas"]["__schema100"];
                                current: components["schemas"]["__schema111"];
                                domain_key: components["schemas"]["__schema98"];
                                head_revision: components["schemas"]["__schema99"];
                                hidden: components["schemas"]["__schema115"];
                                id: components["schemas"]["__schema104"];
                                key: components["schemas"]["__schema114"];
                                space_id: components["schemas"]["__schema113"];
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
                                audience: components["schemas"]["__schema100"];
                                domain_key: components["schemas"]["__schema98"];
                                head_revision: components["schemas"]["__schema99"];
                                hidden: components["schemas"]["__schema115"];
                                id: components["schemas"]["__schema104"];
                                key: components["schemas"]["__schema114"];
                                space_id: components["schemas"]["__schema113"];
                            };
                            revisions: components["schemas"]["__schema111"][];
                        };
                    };
                };
                /** @description No such claim */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                                alternative: components["schemas"]["__schema105"];
                                /** @enum {string} */
                                audience: "private" | "space" | "public";
                                claim_id: string;
                                head: components["schemas"]["__schema105"];
                                id: components["schemas"]["__schema116"];
                                key: components["schemas"]["__schema106"];
                                question_id: components["schemas"]["__schema116"] | null;
                                recorded_at: components["schemas"]["__schema56"];
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
                        claim_id: components["schemas"]["__schema27"];
                        content: string;
                        expected_revision: components["schemas"]["__schema26"];
                        idempotency_key: components["schemas"]["__schema25"];
                        text: string;
                        valid_from: components["schemas"]["__schema20"];
                        /** @default null */
                        valid_until?: components["schemas"]["__schema20"] | null;
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
                        "application/json": components["schemas"]["__schema111"];
                    };
                };
                /** @description Stale revision */
                409: {
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
                        claim_id?: components["schemas"]["__schema27"];
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
                        "application/json": components["schemas"]["__schema112"];
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
                                affected: components["schemas"]["__schema122"][];
                                changed_handle: components["schemas"]["__schema105"];
                                created_at: components["schemas"]["__schema56"];
                                id: components["schemas"]["__schema116"];
                                job_id: string;
                                key: components["schemas"]["__schema106"] | null;
                                new_value: components["schemas"]["__schema121"];
                                old_value: components["schemas"]["__schema121"];
                                replacement_handle: components["schemas"]["__schema105"] | null;
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
                        output_id: components["schemas"]["__schema28"];
                        output_version: components["schemas"]["__schema28"];
                        uses: components["schemas"]["__schema29"];
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
                            output_id: components["schemas"]["__schema116"];
                            output_version: components["schemas"]["__schema116"];
                            unknown_handles: components["schemas"]["__schema117"][];
                        };
                    };
                };
                /** @description Scope denied */
                403: {
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
                                because: components["schemas"]["__schema105"][];
                                created_at: components["schemas"]["__schema56"];
                                id: components["schemas"]["__schema116"];
                                if_ignored: string;
                                key: components["schemas"]["__schema106"];
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
                        at?: components["schemas"]["__schema20"];
                        job_id?: string;
                        /** @default 10 */
                        limit?: components["schemas"]["__schema26"];
                        /** @default 2000 */
                        max_tokens?: components["schemas"]["__schema26"];
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
                                authoritative_revision: components["schemas"]["__schema101"];
                                indexed_revision: components["schemas"]["__schema101"];
                                /** @enum {string} */
                                reason: "ready" | "index_lag" | "budget" | "timeout" | "index_failure" | "restore_pending" | "public_compartment";
                                supplemented: components["schemas"]["__schema101"];
                                truncated: boolean;
                            };
                            /** @default [] */
                            disputed_keys: components["schemas"]["__schema106"][];
                            index_generation: components["schemas"]["__schema101"] | null;
                            items: {
                                claim_id: components["schemas"]["__schema104"];
                                content: string;
                                /** @default false */
                                disputed: boolean;
                                domain_key: components["schemas"]["__schema98"];
                                excerpts: string[];
                                factual_status: components["schemas"]["__schema108"];
                                handle: components["schemas"]["__schema105"];
                                /** @default null */
                                key: components["schemas"]["__schema106"] | null;
                                kind: components["schemas"]["__schema107"];
                                /** @default inferred */
                                origin_trust: components["schemas"]["__schema102"];
                                recorded_at: components["schemas"]["__schema56"];
                                revision: components["schemas"]["__schema99"];
                                sources: components["schemas"]["__schema110"][];
                                status: components["schemas"]["__schema109"];
                                superseded_at: components["schemas"]["__schema56"] | null;
                                valid_from: components["schemas"]["__schema56"];
                                valid_until: components["schemas"]["__schema56"] | null;
                            }[];
                            recipe: components["schemas"]["__schema98"];
                            snapshot: components["schemas"]["__schema103"] | null;
                            /** @enum {string} */
                            status: "complete" | "degraded" | "unavailable";
                            token_budget: {
                                /** @constant */
                                counter: "utf8-bytes-upper-bound-v1";
                                limit: components["schemas"]["__schema99"];
                                used: components["schemas"]["__schema101"];
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
                                recorded_at: components["schemas"]["__schema56"];
                                work_id: components["schemas"]["__schema116"];
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
                        event_at: components["schemas"]["__schema20"];
                        source_identity: components["schemas"]["__schema25"];
                        /** @enum {string} */
                        source_type: "message" | "document" | "observation" | "receipt" | "assistant";
                        source_version: components["schemas"]["__schema25"];
                        stream: components["schemas"]["__schema25"];
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
                            committed_sequence: components["schemas"]["__schema99"];
                            duplicate: boolean;
                            source: components["schemas"]["__schema96"];
                        };
                    };
                };
                /** @description Invalid evidence */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
                    };
                };
                /** @description Scope denied */
                403: {
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
                            source: components["schemas"]["__schema96"];
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
                        "application/json": components["schemas"]["__schema87"];
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
                        "application/json": components["schemas"]["__schema112"];
                    };
                };
                /** @description No such source */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
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
                        handles: components["schemas"]["__schema29"];
                        payload: components["schemas"]["__schema22"];
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
                            fields: components["schemas"]["__schema119"][];
                            minimum_trust: components["schemas"]["__schema102"];
                            unresolved: components["schemas"]["__schema120"][];
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
                        "application/json": components["schemas"]["__schema132"];
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
                            reaction: components["schemas"]["__schema131"];
                        };
                    };
                };
                /** @description No such message */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema87"];
                    };
                };
                /** @description That event is not a message */
                409: {
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
                            notifications: components["schemas"]["__schema94"][];
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
                        "application/json": components["schemas"]["__schema94"];
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
                        "application/json": components["schemas"]["__schema94"];
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
                            operations: components["schemas"]["__schema92"][];
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
                        version: components["schemas"]["__schema21"];
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
                        "application/json": components["schemas"]["__schema92"];
                    };
                };
                /** @description Stale operation */
                409: {
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
                        due_at: components["schemas"]["__schema20"];
                        version: components["schemas"]["__schema21"];
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
                        "application/json": components["schemas"]["__schema92"];
                    };
                };
                /** @description Stale operation */
                409: {
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
                        result: components["schemas"]["__schema22"];
                        version: components["schemas"]["__schema21"];
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
                        "application/json": components["schemas"]["__schema92"];
                    };
                };
                /** @description Stale operation */
                409: {
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
                            procedures: components["schemas"]["__schema58"][];
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
                        "application/json": components["schemas"]["__schema61"];
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
        /** Activate after a completed canary job */
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
                    "application/json": components["schemas"]["__schema5"];
                };
            };
            responses: {
                /** @description Active procedure */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema57"];
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
                    "application/json": components["schemas"]["__schema5"];
                };
            };
            responses: {
                /** @description Canary procedure */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema57"];
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
                    "application/json": components["schemas"]["__schema5"];
                };
            };
            responses: {
                /** @description Evaluation result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema61"];
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
                    "application/json": components["schemas"]["__schema7"];
                };
            };
            responses: {
                /** @description Rejected history */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema57"];
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
                    "application/json": components["schemas"]["__schema7"];
                };
            };
            responses: {
                /** @description Reverted procedure */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema57"];
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
                            questions: components["schemas"]["__schema88"][];
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
                            error?: components["schemas"]["__schema86"];
                            job: components["schemas"]["__schema62"] | null;
                            question: components["schemas"]["__schema88"];
                            receipt: components["schemas"]["__schema82"] | null;
                        };
                    };
                };
                /** @description The question is no longer open */
                409: {
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
                            obligations: components["schemas"]["__schema93"][];
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
                        "application/json": components["schemas"]["__schema93"];
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
                        budget?: components["schemas"]["__schema12"];
                        constraints?: components["schemas"]["__schema11"];
                        /** @default routine */
                        importance?: components["schemas"]["__schema15"];
                        learning?: components["schemas"]["__schema13"];
                        objective: components["schemas"]["__schema10"];
                        /** @default interactive */
                        scheduling_class?: components["schemas"]["__schema14"];
                        space_id: components["schemas"]["__schema8"];
                        title: components["schemas"]["__schema9"];
                        /** @default 3 */
                        unread_threshold?: components["schemas"]["__schema16"];
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
                            error?: components["schemas"]["__schema85"];
                            job: components["schemas"]["__schema62"] | null;
                            receipt: components["schemas"]["__schema82"];
                        };
                    };
                };
                /** @description Submission conflict */
                409: {
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
                                    description: string;
                                    /** @default 400 */
                                    max_tokens: number;
                                    name: string;
                                    /** @default [] */
                                    tools: string[];
                                    triggers: components["schemas"]["__schema201"][];
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
                        "application/json": components["schemas"]["__schema89"];
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
                        "application/json": components["schemas"]["__schema124"];
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
                        "application/json": components["schemas"]["__schema124"];
                    };
                };
                /** @description Invalid request */
                400: {
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
                            receipt: components["schemas"]["__schema82"];
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
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        __schema0: string;
        __schema1: {
            /** @default [] */
            input_refs: components["schemas"]["__schema3"][];
            scope: {
                app: components["schemas"]["__schema2"];
                app_version: components["schemas"]["__schema2"];
                /** @constant */
                audience: "private";
                /** @constant */
                role: "owner";
                task_family: components["schemas"]["__schema2"];
            };
            template_id: components["schemas"]["__schema2"];
        };
        __schema2: string;
        __schema3: components["schemas"]["__schema4"] | string;
        __schema4: string;
        __schema5: {
            space_id: components["schemas"]["__schema6"];
        };
        __schema6: string;
        __schema7: {
            reason: string;
            space_id: components["schemas"]["__schema6"];
        };
        __schema8: string;
        __schema9: string;
        __schema10: string;
        __schema11: {
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
        __schema12: {
            max_actions?: number;
            max_attempts?: number;
            max_output_tokens?: number;
            max_turns?: number;
            max_usd_est?: number;
            max_wall_ms?: number;
        };
        __schema13: components["schemas"]["__schema1"];
        /** @enum {string} */
        __schema14: "interactive" | "background" | "quiet";
        /** @enum {string} */
        __schema15: "routine" | "important";
        __schema16: number;
        __schema17: components["schemas"]["__schema14"];
        __schema18: components["schemas"]["__schema15"];
        __schema19: components["schemas"]["__schema16"];
        /** Format: date-time */
        __schema20: string;
        __schema21: number;
        __schema22: {
            [key: string]: components["schemas"]["__schema23"];
        };
        __schema23: (string | number | boolean | null) | components["schemas"]["__schema23"][] | {
            [key: string]: components["schemas"]["__schema23"];
        };
        __schema24: {
            text: string;
        };
        __schema25: string;
        __schema26: number;
        __schema27: string;
        __schema28: string;
        __schema29: components["schemas"]["__schema3"][];
        __schema30: {
            content: string;
            /** @default [] */
            excerpts: components["schemas"]["__schema31"][];
            handle: components["schemas"]["__schema4"];
            /** @default null */
            key: string | null;
        };
        __schema31: string;
        __schema32: string;
        __schema33: string;
        __schema34: string;
        /** @enum {string} */
        __schema35: "private" | "space" | "public";
        /** @enum {string} */
        __schema36: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema37: "active" | "superseded" | "retracted" | "disputed";
        /** @enum {string} */
        __schema38: "high" | "medium" | "low";
        /** @enum {string} */
        __schema39: "user" | "agent" | "document" | "tool";
        __schema40: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote: string;
            ref: string;
            /** @default null */
            sha256: string | null;
        };
        /** Format: date */
        __schema41: string;
        /** @default null */
        __schema42: components["schemas"]["__schema41"] | null;
        /** @default [] */
        __schema43: components["schemas"]["__schema32"][];
        /** @default null */
        __schema44: components["schemas"]["__schema32"] | null;
        /** @default [] */
        __schema45: string[];
        /** @default [] */
        __schema46: components["schemas"]["__schema32"][];
        /** @constant */
        __schema47: 1;
        /** @default 0 */
        __schema48: number;
        /** @default 200 */
        __schema49: number;
        __schema50: ("job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap")[];
        __schema51: {
            actor: string;
            artifacts: components["schemas"]["__schema55"][];
            correctiveJobId?: string | null;
            createdAt: components["schemas"]["__schema56"];
            expiresAt: components["schemas"]["__schema56"];
            failureClass: string | null;
            generationStartedAt: components["schemas"]["__schema56"] | null;
            generationState: string;
            id: components["schemas"]["__schema52"];
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
            receipts: components["schemas"]["__schema55"][];
            restricted: boolean;
            scope: components["schemas"]["__schema53"];
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
        __schema52: string;
        __schema53: {
            app: components["schemas"]["__schema54"];
            app_version: components["schemas"]["__schema54"];
            /** @constant */
            audience: "private";
            /** @constant */
            role: "owner";
            task_family: components["schemas"]["__schema54"];
        };
        __schema54: string;
        __schema55: {
            [key: string]: unknown;
        };
        /** Format: date-time */
        __schema56: string;
        __schema57: {
            candidate: components["schemas"]["__schema58"];
        };
        __schema58: {
            body: string;
            bodyHash: string;
            canarySpaceId: string | null;
            change: components["schemas"]["__schema55"];
            compatibleModels: string[];
            createdAt: components["schemas"]["__schema56"];
            episodeId: components["schemas"]["__schema52"];
            id: components["schemas"]["__schema59"];
            knownRisk: string;
            predictedBenefit: string;
            rejectionReason: string | null;
            scope: components["schemas"]["__schema53"];
            selectedEvaluationId: string | null;
            spaceId: string;
            state: components["schemas"]["__schema60"];
            tests: string[];
            version: number;
        };
        __schema59: string;
        /** @enum {string} */
        __schema60: "candidate" | "evaluated" | "enabled_canary" | "active" | "superseded" | "reverted";
        __schema61: {
            candidate: components["schemas"]["__schema58"];
            evaluations: {
                budget: components["schemas"]["__schema55"];
                createdAt: components["schemas"]["__schema56"];
                id: string;
                passed: boolean;
                phase: string;
                selectedAt: components["schemas"]["__schema56"] | null;
            }[];
            history: {
                actor: string;
                candidateId: components["schemas"]["__schema59"];
                createdAt: components["schemas"]["__schema56"];
                fromState: string | null;
                id: string;
                reason: string;
                toState: components["schemas"]["__schema60"];
            }[];
        };
        __schema62: {
            /** @enum {string} */
            attention_status: "normal" | "frequency_reduced" | "needs_attention";
            budget: components["schemas"]["__schema72"];
            cadence_multiplier: number;
            constraints: components["schemas"]["__schema67"];
            created_at: components["schemas"]["__schema56"];
            created_by: components["schemas"]["__schema73"];
            /** @default [] */
            deferred_questions: {
                because: components["schemas"]["__schema77"];
                blocks_external_effect: components["schemas"]["__schema80"];
                created_at: components["schemas"]["__schema56"];
                deadline_at: components["schemas"]["__schema81"];
                if_ignored: components["schemas"]["__schema79"];
                text: components["schemas"]["__schema76"];
            }[];
            id: components["schemas"]["__schema63"];
            /** @enum {string} */
            importance: "routine" | "important";
            lease_epoch: components["schemas"]["__schema69"];
            next_wake_at: components["schemas"]["__schema70"];
            objective: components["schemas"]["__schema66"];
            revision: components["schemas"]["__schema68"];
            /** @enum {string} */
            scheduling_class: "interactive" | "background" | "quiet";
            space_id: components["schemas"]["__schema64"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema74"];
            substrate_disposition: components["schemas"]["__schema75"];
            title: components["schemas"]["__schema65"];
            unread_results: number;
            unread_threshold: number;
            updated_at: components["schemas"]["__schema56"];
            visible_status: components["schemas"]["JobState"] | ("frequency_reduced" | "needs_attention");
            wait: components["schemas"]["__schema71"];
        };
        __schema63: string;
        __schema64: string;
        __schema65: string;
        __schema66: string;
        __schema67: {
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
        __schema68: number;
        __schema69: number;
        __schema70: components["schemas"]["__schema56"] | null;
        __schema71: {
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
            wake_at: components["schemas"]["__schema56"];
        } | {
            deadline_at: components["schemas"]["__schema56"] | null;
            /** @constant */
            kind: "event";
            trigger_id: string;
        };
        __schema72: {
            max_actions: number;
            max_attempts: number;
            max_output_tokens: number;
            max_turns: number;
            max_usd_est: number;
            max_wall_ms: number;
        };
        /** @enum {string} */
        __schema73: "owner" | "trigger" | "system";
        __schema74: number;
        /** @enum {string} */
        __schema75: "remote_recoverable" | "timer_or_event" | "local_process_interrupted" | "external_uncertain";
        __schema76: string;
        __schema77: components["schemas"]["__schema78"][];
        __schema78: string;
        __schema79: string;
        /** @default false */
        __schema80: boolean;
        /** @default null */
        __schema81: components["schemas"]["__schema56"] | null;
        __schema82: {
            event_cursor: number | null;
            input_digest: components["schemas"]["__schema84"] | null;
            job_id: string | null;
            job_revision: number | null;
            /** @enum {string} */
            state: "accepted" | "rejected" | "unknown_durability";
            submission_id: components["schemas"]["__schema83"];
        };
        __schema83: string;
        __schema84: string;
        __schema85: components["schemas"]["__schema86"];
        __schema86: {
            code: string;
            detail?: {
                [key: string]: unknown;
            };
            message: string;
        };
        __schema87: {
            error: components["schemas"]["__schema86"];
        };
        __schema88: {
            answer: string | null;
            answered_at: components["schemas"]["__schema56"] | null;
            attempt_id: string | null;
            because: components["schemas"]["__schema77"];
            blocks_external_effect: components["schemas"]["__schema80"];
            created_at: components["schemas"]["__schema56"];
            deadline_at: components["schemas"]["__schema81"];
            id: string;
            if_ignored: components["schemas"]["__schema79"];
            job_id: string | null;
            job_title: string | null;
            key: string | null;
            /** @enum {string} */
            source: "job" | "memory";
            space_id: string | null;
            /** @enum {string} */
            state: "open" | "answered" | "withdrawn";
            text: components["schemas"]["__schema76"];
        };
        __schema89: {
            actions: {
                dispatched_at: components["schemas"]["__schema56"] | null;
                id: string;
                job_id: string;
                receipt: components["schemas"]["__schema90"] | null;
                status: string;
            }[];
            cursor: number;
            epoch: number | null;
            jobs: components["schemas"]["__schema62"][];
        };
        __schema90: {
            [key: string]: components["schemas"]["__schema91"];
        };
        __schema91: (string | number | boolean | null) | components["schemas"]["__schema91"][] | {
            [key: string]: components["schemas"]["__schema91"];
        };
        __schema92: {
            due_at: components["schemas"]["__schema56"];
            id: string;
            job_id: string;
            /** @enum {string} */
            kind: "timer" | "remote_task" | "local_process";
            operation_key: components["schemas"]["__schema83"];
            remote_ref: string | null;
            result: components["schemas"]["__schema90"] | null;
            /** @enum {string} */
            state: "registered" | "ready" | "claimed" | "settled" | "interrupted" | "unknown";
            substrate_disposition: components["schemas"]["__schema75"];
            version: number;
        };
        __schema93: {
            acknowledged_at: components["schemas"]["__schema56"] | null;
            coalesce_key: string;
            created_at: components["schemas"]["__schema56"];
            fulfilled_at: components["schemas"]["__schema56"] | null;
            id: string;
            job_id: string | null;
            /** @enum {string} */
            kind: "direct" | "quiet";
            message: string | null;
            /** @enum {string} */
            state: "owed" | "acknowledged" | "fulfilled" | "needs_retransmission";
            submission_id: components["schemas"]["__schema83"];
        };
        __schema94: {
            attempted_at: components["schemas"]["__schema56"] | null;
            because: components["schemas"]["__schema78"][];
            coalesce_key: string;
            content: {
                attempt_id: string;
                job_id: string;
                /** @enum {string} */
                kind: "answer" | "question" | "status";
                text: string;
            } | null;
            content_hash: components["schemas"]["__schema84"];
            created_at: components["schemas"]["__schema56"];
            delivered_at: components["schemas"]["__schema56"] | null;
            delivery_attempt: number;
            delivery_key: string;
            id: string;
            if_ignored: components["schemas"]["__schema79"];
            obligation_ids: string[];
            /** @enum {string} */
            state: "pending" | "attempted" | "delivered" | "superseded";
        };
        __schema95: {
            error?: components["schemas"]["__schema85"];
            job: components["schemas"]["Job"] | null;
            receipt: components["schemas"]["__schema82"];
        };
        __schema96: {
            audience: components["schemas"]["__schema100"];
            /**
             * @default owner
             * @enum {string}
             */
            author: "owner" | "external";
            content_ref: string | null;
            eligibility_generation: components["schemas"]["__schema101"];
            event_at: components["schemas"]["__schema56"];
            ingested_at: components["schemas"]["__schema56"];
            origin_trust: components["schemas"]["__schema102"];
            owner_id: string;
            publisher: components["schemas"]["__schema98"];
            source_id: components["schemas"]["__schema97"];
            source_identity: components["schemas"]["__schema98"];
            /** @enum {string} */
            source_type: "message" | "document" | "observation" | "receipt" | "assistant" | "owner_edit";
            source_version: components["schemas"]["__schema98"];
            space_id: string;
            /** @enum {string} */
            state: "active" | "suppressed" | "deleted" | "revoked";
            stream: components["schemas"]["__schema98"];
            stream_sequence: components["schemas"]["__schema99"];
        };
        __schema97: string;
        __schema98: string;
        __schema99: number;
        /** @enum {string} */
        __schema100: "private" | "space" | "public";
        __schema101: number;
        /** @enum {string} */
        __schema102: "owner" | "verified_connector" | "external_content" | "inferred" | "unknown";
        __schema103: {
            access_generation: components["schemas"]["__schema101"];
            data_revision: components["schemas"]["__schema101"];
            eligibility_generation: components["schemas"]["__schema101"];
            policy_generation: components["schemas"]["__schema101"];
            restore_ready: boolean;
            space_id: string;
        };
        __schema104: string;
        __schema105: string;
        __schema106: string;
        /** @enum {string} */
        __schema107: "user_statement" | "document_assertion" | "checked_fact" | "inferred" | "preference" | "exception" | "historical";
        /** @enum {string} */
        __schema108: "attributed" | "checked" | "tentative" | "disputed";
        /** @enum {string} */
        __schema109: "active" | "superseded" | "historical" | "retracted" | "disputed";
        __schema110: {
            end: components["schemas"]["__schema99"];
            source_id: components["schemas"]["__schema97"];
            source_version: components["schemas"]["__schema98"];
            start: components["schemas"]["__schema101"];
        };
        __schema111: {
            claim_id: components["schemas"]["__schema104"];
            content: string | null;
            data_revision: components["schemas"]["__schema99"];
            factual_status: components["schemas"]["__schema108"];
            kind: components["schemas"]["__schema107"];
            /** @default inferred */
            origin_trust: components["schemas"]["__schema102"];
            protected: boolean;
            recorded_at: components["schemas"]["__schema56"];
            revision: components["schemas"]["__schema99"];
            sources: components["schemas"]["__schema110"][];
            status: components["schemas"]["__schema109"];
            superseded_at: components["schemas"]["__schema56"] | null;
            valid_from: components["schemas"]["__schema56"];
            valid_until: components["schemas"]["__schema56"] | null;
        };
        __schema112: {
            /** @enum {string} */
            cleanup: "pending" | "complete";
            generation: components["schemas"]["__schema103"];
        };
        __schema113: string;
        /** @default null */
        __schema114: components["schemas"]["__schema106"] | null;
        __schema115: boolean;
        __schema116: string;
        __schema117: string;
        __schema118: {
            field: string;
            handle: components["schemas"]["__schema105"];
            key: components["schemas"]["__schema106"] | null;
            /** @enum {string} */
            kind: "recipient" | "date" | "amount" | "identifier";
            value: string;
        };
        __schema119: {
            description: string;
            field: string;
            handle: (components["schemas"]["__schema105"] | string) | null;
            origin_trust: components["schemas"]["__schema102"];
            value: string;
        };
        __schema120: string;
        __schema121: string;
        __schema122: {
            /** @enum {string} */
            kind: "artifact" | "plan_step" | "action";
            location: string | null;
            output_id: components["schemas"]["__schema116"];
            output_version: components["schemas"]["__schema116"];
        };
        __schema123: {
            diff: string;
            id: components["schemas"]["__schema98"];
            path: string;
            /** @enum {string} */
            status: "pending" | "applied" | "discarded";
        };
        __schema124: {
            spaces: components["schemas"]["Space"][];
        };
        __schema125: string;
        __schema126: string;
        /** @enum {string} */
        __schema127: "personal";
        /** @enum {string} */
        __schema128: "owner";
        __schema129: string;
        __schema130: {
            job: components["schemas"]["Job"];
        };
        __schema131: {
            /** @enum {string} */
            by: "person" | "assistant";
            created_at: components["schemas"]["__schema56"];
            emoji: string;
            job_id: string | null;
            message_id: string;
            seq: number;
        };
        __schema132: {
            reactions: components["schemas"]["__schema131"][];
        };
        __schema133: string;
        __schema134: string;
        __schema135: number;
        __schema136: string;
        __schema137: string;
        __schema138: string;
        __schema139: string | null;
        __schema140: {
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
        __schema141: components["schemas"]["__schema56"] | null;
        __schema142: ("completed" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "failed" | "budget_exhausted" | "fenced" | "unknown_check") | null;
        __schema143: components["schemas"]["__schema90"] | null;
        __schema144: string | null;
        __schema145: {
            events: components["schemas"]["Event"][];
            has_more: boolean;
            next_cursor: number;
        };
        __schema146: number;
        __schema147: string | null;
        __schema148: string | null;
        /** @enum {string} */
        __schema149: "job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap";
        __schema150: string;
        __schema151: string;
        __schema152: string;
        /** @enum {string} */
        __schema153: "completed" | "parked_until_retry" | "needs_reconciliation" | "needs_reconnect" | "needs_input" | "repair_exhausted";
        __schema154: {
            [key: string]: number;
        };
        __schema155: {
            at: components["schemas"]["__schema56"];
            attempt: number;
            /** @default null */
            candidate_id: string | null;
            /** @enum {string} */
            decision: "verified_completion" | "retry_with_backoff" | "park_until_retry_after" | "refresh_credential_once" | "stop_connection_revoked" | "rediscover_schema" | "record_repair_candidate" | "apply_safe_mapping" | "change_route" | "reconcile_by_verify" | "revise_and_revalidate" | "stop_needs_input" | "escalate_diagnosis";
            /** @default null */
            delay_ms: number | null;
            detail: string;
            /** @default null */
            fault_kind: components["schemas"]["__schema156"] | null;
            payload_hash: components["schemas"]["__schema151"];
            /** @default null */
            retry_after: components["schemas"]["__schema56"] | null;
            /** @default null */
            route: string | null;
        }[];
        /** @enum {string} */
        __schema156: "transient_before_dispatch" | "rate_limited" | "expired_credential" | "revoked_credential" | "schema_drift" | "unsupported_route" | "uncertain_outcome" | "bad_output" | "unclassified";
        __schema157: string;
        __schema158: string;
        __schema159: string;
        __schema160: string;
        __schema161: string;
        /** @default null */
        __schema162: components["schemas"]["__schema152"] | null;
        __schema163: string | null;
        __schema164: string | null;
        __schema165: string;
        __schema166: components["schemas"]["__schema56"] | null;
        __schema167: components["schemas"]["__schema90"] | null;
        __schema168: components["schemas"]["__schema56"] | null;
        __schema169: components["schemas"]["__schema90"] | null;
        /** @default [] */
        __schema170: components["schemas"]["__schema155"];
        /** @default {} */
        __schema171: components["schemas"]["__schema154"];
        /** @default null */
        __schema172: components["schemas"]["__schema153"] | null;
        /** @default null */
        __schema173: components["schemas"]["__schema56"] | null;
        __schema174: {
            action: components["schemas"]["Action"];
        };
        __schema175: string;
        __schema176: string;
        /** @enum {string} */
        __schema177: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp";
        __schema178: string;
        __schema179: string[];
        /** @enum {string} */
        __schema180: "active" | "disabled" | "error";
        /** @enum {string} */
        __schema181: "unknown" | "ok" | "degraded" | "failing";
        __schema182: components["schemas"]["__schema56"] | null;
        __schema183: {
            connection: components["schemas"]["Connection"];
        };
        /** @enum {string} */
        __schema184: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema185: "active" | "superseded" | "retracted" | "disputed";
        __schema186: {
            body: string;
            frontmatter: components["schemas"]["KnowledgeFrontmatterOutput"];
            id: string;
            path: string;
        };
        __schema187: string;
        __schema188: string;
        __schema189: string;
        /** @enum {string} */
        __schema190: "private" | "space" | "public";
        /** @enum {string} */
        __schema191: "high" | "medium" | "low";
        /** @enum {string} */
        __schema192: "user" | "agent" | "document" | "tool";
        __schema193: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote: string;
            ref: string;
            /** @default null */
            sha256: string | null;
        };
        /** Format: date */
        __schema194: string;
        /** @default null */
        __schema195: components["schemas"]["__schema194"] | null;
        /** @default [] */
        __schema196: components["schemas"]["__schema187"][];
        /** @default null */
        __schema197: components["schemas"]["__schema187"] | null;
        /** @default [] */
        __schema198: string[];
        /** @default [] */
        __schema199: components["schemas"]["__schema187"][];
        /** @constant */
        __schema200: 1;
        __schema201: string;
        __schema202: string;
        __schema203: number;
        /** @enum {string} */
        __schema204: "automation" | "human";
        /** @constant */
        __schema205: true;
        Action: {
            attempt_id: components["schemas"]["__schema159"];
            authorization_ref: components["schemas"]["__schema163"];
            budget_reservation: components["schemas"]["__schema164"];
            canonical_payload: components["schemas"]["__schema90"];
            connection_id: components["schemas"]["__schema160"];
            created_at: components["schemas"]["__schema56"];
            dispatched_at: components["schemas"]["__schema166"];
            effect_class: components["schemas"]["EffectClass"];
            id: components["schemas"]["__schema157"];
            idempotency_key: components["schemas"]["__schema165"];
            intent_key: components["schemas"]["__schema162"];
            job_id: components["schemas"]["__schema158"];
            kind: components["schemas"]["__schema161"];
            payload_hash: components["schemas"]["__schema151"];
            receipt: components["schemas"]["__schema167"];
            reconciliation: components["schemas"]["__schema169"];
            repair_counters: components["schemas"]["__schema171"];
            repair_disposition: components["schemas"]["__schema172"];
            repair_trace: components["schemas"]["__schema170"];
            resolved_at: components["schemas"]["__schema168"];
            retry_after_at: components["schemas"]["__schema173"];
            status: components["schemas"]["ActionStatus"];
        };
        /** @enum {string} */
        ActionStatus: "proposed" | "needs_approval" | "approved" | "denied" | "admitted" | "dispatched" | "succeeded" | "failed" | "unknown" | "unresolved";
        Attempt: {
            context_snapshot_ref: components["schemas"]["__schema144"];
            ended_at: components["schemas"]["__schema141"];
            epoch: components["schemas"]["__schema135"];
            id: components["schemas"]["__schema133"];
            job_id: components["schemas"]["__schema134"];
            model: components["schemas"]["__schema138"];
            model_actual: components["schemas"]["__schema139"];
            outcome: components["schemas"]["__schema142"];
            outcome_detail: components["schemas"]["__schema143"];
            provider: components["schemas"]["__schema137"];
            runtime_version: components["schemas"]["__schema136"];
            started_at: components["schemas"]["__schema56"];
            usage: components["schemas"]["__schema140"];
        };
        BrowserControlResponse: {
            control: components["schemas"]["__schema204"];
            control_epoch: components["schemas"]["__schema203"];
            fresh_observation_required: components["schemas"]["__schema205"];
            session_id: components["schemas"]["__schema202"];
        };
        Connection: {
            created_at: components["schemas"]["__schema56"];
            health: components["schemas"]["__schema181"];
            id: components["schemas"]["__schema175"];
            label: components["schemas"]["__schema178"];
            last_checked_at: components["schemas"]["__schema182"];
            provider: components["schemas"]["__schema177"];
            scopes: components["schemas"]["__schema179"];
            space_id: components["schemas"]["__schema176"];
            status: components["schemas"]["__schema180"];
        };
        /** @enum {string} */
        EffectClass: "read" | "write_reversible" | "write_external" | "spend";
        Event: {
            attempt_id: components["schemas"]["__schema148"];
            created_at: components["schemas"]["__schema56"];
            dedup_key: components["schemas"]["__schema150"];
            job_id: components["schemas"]["__schema147"];
            payload: components["schemas"]["__schema90"];
            seq: components["schemas"]["__schema146"];
            type: components["schemas"]["__schema149"];
        };
        Job: {
            budget: components["schemas"]["__schema72"];
            constraints: components["schemas"]["__schema67"];
            created_at: components["schemas"]["__schema56"];
            created_by: components["schemas"]["__schema73"];
            id: components["schemas"]["__schema63"];
            lease_epoch: components["schemas"]["__schema69"];
            next_wake_at: components["schemas"]["__schema70"];
            objective: components["schemas"]["__schema66"];
            revision: components["schemas"]["__schema68"];
            space_id: components["schemas"]["__schema64"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema74"];
            title: components["schemas"]["__schema65"];
            updated_at: components["schemas"]["__schema56"];
            wait: components["schemas"]["__schema71"];
        };
        /** @enum {string} */
        JobState: "queued" | "running" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "needs_reconciliation" | "completed" | "failed" | "cancelled";
        KnowledgeFrontmatter: {
            asserted_by: components["schemas"]["__schema39"];
            audience: components["schemas"]["__schema35"];
            confidence: components["schemas"]["__schema38"];
            created: components["schemas"]["__schema41"];
            id: components["schemas"]["__schema32"];
            links?: components["schemas"]["__schema46"];
            observed_at: components["schemas"]["__schema41"];
            schema_version: components["schemas"]["__schema47"];
            source: components["schemas"]["__schema40"];
            space: components["schemas"]["__schema34"];
            status: components["schemas"]["__schema37"];
            superseded_by?: components["schemas"]["__schema44"];
            supersedes?: components["schemas"]["__schema43"];
            tags?: components["schemas"]["__schema45"];
            title: components["schemas"]["__schema33"];
            type: components["schemas"]["__schema36"];
            updated: components["schemas"]["__schema41"];
            valid_from: components["schemas"]["__schema41"];
            valid_until?: components["schemas"]["__schema42"];
        };
        KnowledgeFrontmatterOutput: {
            asserted_by: components["schemas"]["__schema192"];
            audience: components["schemas"]["__schema190"];
            confidence: components["schemas"]["__schema191"];
            created: components["schemas"]["__schema194"];
            id: components["schemas"]["__schema187"];
            links: components["schemas"]["__schema199"];
            observed_at: components["schemas"]["__schema194"];
            schema_version: components["schemas"]["__schema200"];
            source: components["schemas"]["__schema193"];
            space: components["schemas"]["__schema189"];
            status: components["schemas"]["__schema185"];
            superseded_by: components["schemas"]["__schema197"];
            supersedes: components["schemas"]["__schema196"];
            tags: components["schemas"]["__schema198"];
            title: components["schemas"]["__schema188"];
            type: components["schemas"]["__schema184"];
            updated: components["schemas"]["__schema194"];
            valid_from: components["schemas"]["__schema194"];
            valid_until: components["schemas"]["__schema195"];
        };
        Space: {
            audience: components["schemas"]["__schema128"];
            created_at: components["schemas"]["__schema56"];
            git_path: components["schemas"]["__schema129"];
            id: components["schemas"]["__schema125"];
            kind: components["schemas"]["__schema127"];
            name: components["schemas"]["__schema126"];
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
