/**
 * Generated from packages/contracts/openapi.json by `bun run client:generate`.
 * Do not edit by hand: the sync test compares this file against a fresh run.
 */

export interface paths {
    "/.well-known/oauth-authorization-server": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * OAuth authorization server metadata (RFC 8414)
         * @description Public, at the root of the web origin. No session is needed.
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
                /** @description The metadata */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uri */
                            authorization_endpoint: string;
                            authorization_response_iss_parameter_supported: boolean;
                            client_id_metadata_document_supported: boolean;
                            code_challenge_methods_supported: string[];
                            grant_types_supported: string[];
                            /** Format: uri */
                            issuer: string;
                            /** Format: uri */
                            registration_endpoint: string;
                            response_modes_supported: string[];
                            response_types_supported: string[];
                            /** Format: uri */
                            revocation_endpoint: string;
                            revocation_endpoint_auth_methods_supported: string[];
                            scopes_supported: string[];
                            /** Format: uri */
                            token_endpoint: string;
                            token_endpoint_auth_methods_supported: string[];
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
    "/.well-known/oauth-protected-resource": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Protected resource metadata for the MCP endpoint (RFC 9728) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The metadata */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema391"];
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
    "/.well-known/oauth-protected-resource/api/mcp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Protected resource metadata at the path-specific address the endpoint names */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The metadata */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema391"];
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
                        "application/json": components["schemas"]["__schema366"];
                    };
                };
                /** @description No such action */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema366"];
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
         * @description Used when verify cannot decide. The owner says what really happened; the answer is recorded as a reconciliation, and the action is never re-dispatched. It settles only an action on one of the caller's own jobs whose status is unknown or unresolved.
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
                        "application/json": components["schemas"]["__schema366"];
                    };
                };
                /** @description No signed-in person to record the answer for */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such action among the caller's own */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Action is not awaiting reconciliation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            agents: components["schemas"]["__schema228"][];
                        } | components["schemas"]["__schema205"];
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
                    "application/json": components["schemas"]["__schema17"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema205"];
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
                    "application/json": components["schemas"]["__schema17"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema205"];
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
                                    allowed_connection_ids: components["schemas"]["__schema236"];
                                    asks_before_acting: components["schemas"]["__schema237"];
                                    colour: components["schemas"]["__schema231"];
                                    eye_colour: components["schemas"]["__schema233"];
                                    face_image?: components["schemas"]["__schema238"];
                                    name: components["schemas"]["__schema229"];
                                    role: components["schemas"]["__schema230"];
                                    standing_instruction: components["schemas"]["__schema235"];
                                    surface: components["schemas"]["__schema232"];
                                    tone: components["schemas"]["__schema234"];
                                };
                                id: components["schemas"]["__schema199"];
                                title: components["schemas"]["__schema200"];
                            }[];
                        } | components["schemas"]["__schema205"];
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
    "/approval-settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /approval-settings
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
                        "application/json": components["schemas"]["__schema226"] | components["schemas"]["__schema205"];
                    };
                };
            };
        };
        /**
         * PUT /approval-settings
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        classes: {
                            app_changes: boolean;
                            calendar: boolean;
                            sandbox: boolean;
                        };
                        /** @enum {string} */
                        mode: "ask" | "auto_review";
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
                        "application/json": components["schemas"]["__schema226"] | components["schemas"]["__schema205"];
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
                                canonical_payload: components["schemas"]["__schema286"];
                                connection_id: string;
                                effect_class: components["schemas"]["EffectClass"];
                                expires_at: components["schemas"]["__schema134"] | null;
                                job_id: string;
                                job_revision: number;
                                kind: string;
                                /** @default [] */
                                origin_warnings: {
                                    description: string;
                                    field: string;
                                    handle: string | null;
                                    origin_trust: components["schemas"]["__schema297"];
                                }[];
                                payload_hash: components["schemas"]["__schema343"];
                                requested_at: components["schemas"]["__schema134"];
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
                            decided_at: components["schemas"]["__schema134"];
                            /** @enum {string} */
                            decision: "approved" | "denied";
                            payload_hash: components["schemas"]["__schema343"];
                        };
                    };
                };
                /** @description The payload changed since this approval was requested */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No matching artifact in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                            automations: components["schemas"]["__schema255"][];
                        } | components["schemas"]["__schema205"];
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
                        agent_id: components["schemas"]["__schema13"];
                        at: string;
                        instruction: components["schemas"]["__schema12"];
                        title: components["schemas"]["__schema12"];
                        weekdays: components["schemas"]["__schema22"][];
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
                        "application/json": components["schemas"]["__schema256"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
                        agent_id: components["schemas"]["__schema13"];
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
                        "application/json": components["schemas"]["__schema256"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema257"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema257"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The live view could not open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The live view was already closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                    after?: components["schemas"]["__schema96"];
                    /** @description The live id this view was opened with */
                    live_id: components["schemas"]["__schema95"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        events: components["schemas"]["__schema97"][];
                        live_id: components["schemas"]["__schema95"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Input above the rate cap; the view closes */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The host was refused or the scope is full */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Not the owner of this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Not the owner of this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The browser could not be cleared */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            catalog?: components["schemas"]["ConnectionCatalogEntry"][];
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
                            calendar_url?: components["schemas"]["__schema71"];
                            server_url?: components["schemas"]["__schema73"];
                            username: components["schemas"]["__schema72"];
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
                        mcp?: components["schemas"]["__schema64"];
                        mcp_stdio?: {
                            allowed_scopes: components["schemas"]["__schema66"];
                            args?: components["schemas"]["__schema77"];
                            audience: components["schemas"]["__schema68"];
                            command?: components["schemas"]["__schema76"];
                            egress?: components["schemas"]["__schema79"];
                            id: components["schemas"]["__schema65"];
                            runner: components["schemas"]["__schema74"];
                            secret_env?: components["schemas"]["__schema81"];
                            source: components["schemas"]["__schema75"];
                            tools: components["schemas"]["__schema69"];
                        };
                        /** @enum {string} */
                        provider: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp" | "sandbox";
                        sandbox?: {
                            /** @enum {string} */
                            adapter: "e2b" | "daytona" | "modal";
                            cidrs?: components["schemas"]["__schema83"][];
                            /** @enum {string} */
                            egress: "deny_all" | "cidr_allowlist" | "open";
                            image: string;
                            lifetime_seconds: number;
                            /** @enum {string} */
                            persistence: "ephemeral" | "pause" | "snapshot";
                            region?: string;
                        };
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
                        "application/json": components["schemas"]["__schema379"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description MCP installation name already exists */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema379"];
                    };
                };
                /** @description No such connection */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                query?: {
                    cursor?: string;
                    limit?: number;
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
                            conversations: components["schemas"]["__schema198"][];
                            next_cursor: string | null;
                        } | components["schemas"]["__schema205"];
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
                        agent_id: components["schemas"]["__schema13"];
                        plan_id?: components["schemas"]["__schema13"];
                        title: components["schemas"]["__schema12"];
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
                        "application/json": components["schemas"]["__schema206"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema206"] | components["schemas"]["__schema205"];
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
                    "application/json": components["schemas"]["__schema14"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema206"] | components["schemas"]["__schema205"];
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
                            cards: components["schemas"]["__schema210"][];
                        } | components["schemas"]["__schema205"];
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
    "/conversations/{id}/computer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /conversations/{id}/computer
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
                            available: {
                                browser: boolean;
                                terminal: boolean;
                            };
                            browser: {
                                /** @enum {string} */
                                control: "agent" | "you";
                                screenshot: {
                                    artifact_id: components["schemas"]["__schema199"];
                                } | null;
                                seen_at: components["schemas"]["__schema203"] | null;
                                session_id: components["schemas"]["__schema199"];
                                title: string | null;
                                url: string | null;
                            } | null;
                            terminal: components["schemas"]["__schema224"][];
                        } | components["schemas"]["__schema205"];
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
                            drafts: components["schemas"]["__schema220"][];
                        } | components["schemas"]["__schema205"];
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
                                conversation_id: components["schemas"]["__schema199"];
                                created_at: components["schemas"]["__schema203"];
                                item: ({
                                    text: string;
                                    /** @constant */
                                    type: "say";
                                } | {
                                    label: components["schemas"]["__schema200"];
                                    meta: string;
                                    sources: {
                                        app: components["schemas"]["__schema200"];
                                        connection_id: components["schemas"]["__schema199"];
                                        /** @enum {string} */
                                        kind: "event" | "message" | "draft" | "file" | "page" | "task";
                                        title: components["schemas"]["__schema200"];
                                        url?: components["schemas"]["__schema207"];
                                    }[];
                                    tool?: components["schemas"]["__schema208"];
                                    /** @constant */
                                    type: "action";
                                } | {
                                    text: components["schemas"]["__schema200"];
                                    /** @constant */
                                    type: "note";
                                } | {
                                    apps: components["schemas"]["__schema200"][];
                                    elapsed_ms: components["schemas"]["__schema204"];
                                    source_count: components["schemas"]["__schema204"];
                                    summary: components["schemas"]["__schema200"];
                                    /** @constant */
                                    type: "done";
                                }) | {
                                    text: string;
                                    /** @constant */
                                    type: "text_delta";
                                } | {
                                    card: components["schemas"]["__schema210"];
                                    /** @constant */
                                    type: "card";
                                } | {
                                    receipt: components["schemas"]["__schema213"];
                                    /** @constant */
                                    type: "receipt";
                                } | {
                                    permission: components["schemas"]["__schema218"];
                                    /** @constant */
                                    type: "permission";
                                } | {
                                    question: components["schemas"]["__schema221"];
                                    /** @constant */
                                    type: "question";
                                } | {
                                    decision: {
                                        answer: string | null;
                                        decided_at: components["schemas"]["__schema203"];
                                        id: components["schemas"]["__schema199"];
                                        /** @enum {string} */
                                        kind: "permission" | "question";
                                        /** @enum {string} */
                                        outcome: "allow_once" | "always" | "deny" | "replaced" | "answered" | "withdrawn";
                                    };
                                    /** @constant */
                                    type: "decision";
                                } | {
                                    composer: components["schemas"]["__schema202"];
                                    status: components["schemas"]["__schema201"];
                                    /** @constant */
                                    type: "status";
                                } | {
                                    tool: components["schemas"]["__schema208"];
                                    /** @constant */
                                    type: "tool";
                                };
                                seq: components["schemas"]["__schema204"];
                                turn_id: components["schemas"]["__schema199"] | null;
                            }[];
                            has_more: boolean;
                            next_cursor: components["schemas"]["__schema204"];
                        } | components["schemas"]["__schema205"];
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
                                agent_id: components["schemas"]["__schema199"];
                                answer: string;
                                conversation_id: components["schemas"]["__schema199"];
                                created_at: components["schemas"]["__schema203"];
                                delivery: ("sending" | "queued_offline" | "failed_retry") | null;
                                id: components["schemas"]["__schema199"];
                                status: components["schemas"]["__schema201"];
                                text: string;
                            }[];
                        } | components["schemas"]["__schema205"];
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
                        corrects?: components["schemas"]["__schema15"];
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
                                id: components["schemas"]["__schema199"];
                                received_at: components["schemas"]["__schema203"];
                                /** @enum {string} */
                                status: "accepted" | "failed_retry";
                            };
                            turn_id: components["schemas"]["__schema199"];
                        } | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema206"] | components["schemas"]["__schema205"];
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
                            receipts: components["schemas"]["__schema213"][];
                        } | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema206"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema206"] | components["schemas"]["__schema205"];
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
                            draft: components["schemas"]["__schema220"];
                            permission: components["schemas"]["__schema218"] | null;
                            receipt: components["schemas"]["__schema213"] | null;
                        } | components["schemas"]["__schema205"];
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
    "/engine-skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the skills the engine wrote for itself in this space */
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
                /** @description Engine skills */
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
    "/engine-skills/{id}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve the exact bytes of a held engine-written skill */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Skill id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        definition_hash: components["schemas"]["__schema11"];
                        space_id: components["schemas"]["__schema8"];
                    };
                };
            };
            responses: {
                /** @description Live engine skill */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema172"];
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
    "/engine-skills/{id}/decline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Decline a held engine-written skill and erase its body */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Skill id */
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
                /** @description Engine skill */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema172"];
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
    "/engine-skills/{id}/delete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Delete an engine-written skill and erase its body */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Skill id */
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
                /** @description Engine skill */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema172"];
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
    "/engine-skills/{id}/edit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Replace an engine-written skill with the owner’s own text */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Skill id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        body: string;
                        definition_hash: components["schemas"]["__schema11"];
                        space_id: components["schemas"]["__schema8"];
                    };
                };
            };
            responses: {
                /** @description Edited engine skill */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema172"];
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
    "/engine-skills/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop delivering an engine-written skill from the next attempt */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Skill id */
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
                /** @description Engine skill */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema172"];
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
    "/engine-skills/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Deliver a paused engine-written skill again */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Skill id */
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
                /** @description Engine skill */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema172"];
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
    "/engine-skills/{id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop an engine-written skill and prohibit its name and body in every space until lifted */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Skill id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema10"];
                };
            };
            responses: {
                /** @description Stopped engine skill */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema172"];
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
    "/engine-skills/held": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List engine-written skills waiting for the owner to read them */
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
                /** @description Held engine skills */
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
    "/engine-skills/prohibitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the standing prohibitions this person placed on engine skills, in any space */
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
                /** @description Prohibitions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            prohibitions: components["schemas"]["__schema171"][];
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
    "/engine-skills/prohibitions/{id}/lift": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Lift a standing prohibition on an engine skill */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Prohibition id */
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
                /** @description Lifted prohibition */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            prohibition: components["schemas"]["__schema171"];
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
                            episodes: components["schemas"]["__schema140"][];
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
                        "application/json": components["schemas"]["__schema145"];
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
                    after?: components["schemas"]["__schema61"];
                    limit?: components["schemas"]["__schema62"];
                    types?: components["schemas"]["__schema63"];
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
                        "application/json": components["schemas"]["__schema337"];
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
                                app: components["schemas"]["__schema200"];
                                builtin?: boolean;
                                id: components["schemas"]["__schema199"];
                                label: components["schemas"]["__schema200"];
                                /** @enum {string} */
                                status: "available" | "connecting" | "connected" | "error";
                            }[];
                        } | components["schemas"]["__schema205"];
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
                            source_connection: components["schemas"]["__schema199"];
                            title: components["schemas"]["__schema200"];
                            updated_at: components["schemas"]["__schema203"];
                            value: components["schemas"]["__schema200"];
                        } | components["schemas"]["__schema205"];
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
                            artist: components["schemas"]["__schema200"];
                            image?: components["schemas"]["__schema207"];
                            playing: boolean;
                            source_connection: components["schemas"]["__schema199"];
                            title: components["schemas"]["__schema200"];
                        } | components["schemas"]["__schema205"];
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
    "/feedback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List problem reports, newest first
         * @description The person who runs the installation sees every report and `can_manage` is true. Anyone else sees only the reports they sent.
         */
        get: {
            parameters: {
                query?: {
                    status?: components["schemas"]["FeedbackStatus"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Reports */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            can_manage: boolean;
                            reports: components["schemas"]["FeedbackReport"][];
                        };
                    };
                };
                /** @description A session is required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Report a problem with the app
         * @description Stores what the person wrote and what the page said about itself, and answers with a short id such as `FB-7K3Q` to quote when asking for a fix. Console lines, request addresses and the route are redacted again before they are stored. Each person may send a few reports in a short time; more are refused until the window passes.
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
                        context?: components["schemas"]["FeedbackContext"];
                        message: string;
                    };
                };
            };
            responses: {
                /** @description Stored */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema471"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description A session is required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Too many reports from this person in a short time */
                429: {
                    headers: {
                        /** @description Seconds to wait before the next attempt */
                        "Retry-After": string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/feedback/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read one problem report with its page details */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Report id, such as FB-7K3Q */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Report */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema471"];
                    };
                };
                /** @description No such report, or not one this person sent */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Change a report’s status, with an optional note */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Report id, such as FB-7K3Q */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        note?: string | null;
                        status: components["schemas"]["FeedbackStatus"];
                    };
                };
            };
            responses: {
                /** @description Updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema471"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Only the person who runs the installation changes a status */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such report */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/google-sign-ins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whether signing in with Google is offered here
         * @description Available once the operator has set a Google OAuth client and an https:// or localhost public address. `redirect_uri` is the address to register with that client.
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
                /** @description Availability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema394"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Start connecting Gmail and Google Calendar by signing in with Google
         * @description Answers with the Google address to open in the browser. One consent asks to read mail, send mail and manage calendar events; drafts stay in Melete. When the browser returns, each part the person allowed becomes a connection with the same tools, approvals and receipts as a mailbox or calendar connected with a password. Signing in again with the same account renews those connections instead of adding more.
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
                    "application/json": components["schemas"]["__schema94"];
                };
            };
            responses: {
                /** @description Open `authorize_url` in the browser */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema395"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No OAuth client, no public address to return to, or no master key */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/google-sign-ins/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read how a Google sign-in is going */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sign-in id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Pending, connected with its connections, or failed with a code */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema396"];
                    };
                };
                /** @description No sign-in by that id for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            memory?: {
                                failed: number;
                                reason: ("provider_unavailable" | "provider_slow" | "daily_budget") | null;
                                /** @enum {string} */
                                status: "ok" | "waiting";
                                waiting: number;
                            };
                            runtime_adapter?: string;
                            runtime_supervisor?: ("process" | "docker") | null;
                            /** @enum {string} */
                            status: "ok" | "degraded";
                            time: components["schemas"]["__schema134"];
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
                            date: components["schemas"]["__schema200"];
                            greeting: components["schemas"]["__schema200"];
                            open_task_count: components["schemas"]["__schema204"];
                            tasks: components["schemas"]["__schema253"][];
                            time_zone: components["schemas"]["__schema200"];
                            upcoming: {
                                connection_id: components["schemas"]["__schema199"];
                                ends_at: components["schemas"]["__schema203"];
                                id: components["schemas"]["__schema199"];
                                starts_at: components["schemas"]["__schema203"];
                                title: components["schemas"]["__schema200"];
                                url?: components["schemas"]["__schema207"];
                            }[] | components["schemas"]["__schema205"];
                            within_day_hours: boolean;
                        } | components["schemas"]["__schema205"];
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
                        payload: components["schemas"]["__schema33"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The connection is not active */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                    "Idempotency-Key"?: components["schemas"]["__schema23"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema24"];
                };
            };
            responses: {
                /** @description A retried submission whose first status was not recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description Accepted, or the same key and input submitted again */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"] | components["schemas"]["__schema136"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"] | components["schemas"]["__schema136"];
                    };
                };
                /** @description No such space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
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
                    "Idempotency-Key"?: components["schemas"]["__schema23"];
                };
                path: {
                    /** @description Job ID */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema35"];
                };
            };
            responses: {
                /** @description Accepted, or the same key and input submitted again */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"] | components["schemas"]["__schema136"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"] | components["schemas"]["__schema136"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
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
                            episode: components["schemas"]["__schema140"];
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
                            createdAt: components["schemas"]["__schema134"];
                            inputRefs: string[];
                            jobId: string;
                            scope: components["schemas"]["__schema142"];
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
                        due_at?: components["schemas"]["__schema31"];
                        /** @enum {string} */
                        kind: "timer" | "remote_task" | "local_process";
                        operation_key: components["schemas"]["__schema23"];
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
                        "application/json": components["schemas"]["__schema288"];
                    };
                };
                /** @description Operation key conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema259"];
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
                                    created_at: components["schemas"]["__schema134"];
                                    /** @default null */
                                    evaluation: {
                                        detail: string;
                                        evaluated_at: components["schemas"]["__schema134"];
                                        passed: boolean;
                                    } | null;
                                    fault_kind: components["schemas"]["__schema348"];
                                    id: string;
                                    job_id: string;
                                    kind: string;
                                    /** @default null */
                                    observed_schema: components["schemas"]["__schema286"] | null;
                                    proposed_mapping: {
                                        [key: string]: string;
                                    };
                                    safe: boolean;
                                    /** @enum {string} */
                                    state: "candidate" | "evaluated" | "applied" | "rejected";
                                    test: {
                                        expected: components["schemas"]["__schema286"];
                                        input: components["schemas"]["__schema286"];
                                        name: string;
                                        operation: string;
                                        /** @default [] */
                                        preserves: {
                                            path: string;
                                            value: string;
                                        }[];
                                    };
                                    updated_at: components["schemas"]["__schema134"];
                                }[];
                                /** @default {} */
                                counters: components["schemas"]["__schema346"];
                                /** @default null */
                                disposition: components["schemas"]["__schema345"] | null;
                                effect_class: components["schemas"]["EffectClass"];
                                /** @default null */
                                intent_key: components["schemas"]["__schema344"] | null;
                                job_id: string;
                                kind: string;
                                payload_hash: components["schemas"]["__schema343"];
                                /** @default null */
                                retry_after_at: components["schemas"]["__schema134"] | null;
                                safe_stop: boolean;
                                status: components["schemas"]["ActionStatus"];
                                /** @default [] */
                                trace: components["schemas"]["__schema347"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema259"];
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
                        importance?: components["schemas"]["__schema29"];
                        scheduling_class?: components["schemas"]["__schema28"];
                        unread_threshold?: components["schemas"]["__schema30"];
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
                        "application/json": components["schemas"]["__schema259"];
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
                        "application/json": components["schemas"]["__schema285"];
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
                            all: components["schemas"]["__schema60"][];
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
                                created_at: components["schemas"]["__schema134"];
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
                                        all: components["schemas"]["__schema322"][];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The job has finished */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema321"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema321"];
                    };
                };
                /** @description Job is already finished */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                    after?: components["schemas"]["__schema61"];
                    limit?: components["schemas"]["__schema62"];
                    types?: components["schemas"]["__schema63"];
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
                        "application/json": components["schemas"]["__schema337"];
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
                    "Idempotency-Key"?: components["schemas"]["__schema23"];
                };
                path: {
                    /** @description Job id */
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema35"];
                };
            };
            responses: {
                /** @description Accepted, or the same key and input submitted again */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"] | components["schemas"]["__schema136"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"] | components["schemas"]["__schema136"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
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
                        "application/json": components["schemas"]["__schema324"];
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
                                status: components["schemas"]["__schema426"];
                                tags: string[];
                                title: string;
                                type: components["schemas"]["__schema425"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema427"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema427"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        expected_revision: components["schemas"]["__schema37"];
                        frontmatter: components["schemas"]["KnowledgeFrontmatter"];
                        idempotency_key: components["schemas"]["__schema36"];
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
                        "application/json": components["schemas"]["__schema306"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            proposals: components["schemas"]["__schema318"][];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema318"];
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
                        "application/json": components["schemas"]["__schema318"];
                    };
                };
                /** @description Proposal is stale */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                                status: components["schemas"]["__schema426"];
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
    "/learned": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List what the signed-in person taught, in their own words */
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
                /** @description What was learned */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["__schema163"][];
                            last_change: components["schemas"]["__schema165"] | null;
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
    "/learned/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop using it until resumed */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Learned item id */
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
                /** @description Paused */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema166"];
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
    "/learned/{id}/remove": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Remove it from the list and stop using it */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Learned item id */
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
                /** @description Removed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema166"];
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
    "/learned/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Use it again */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Learned item id */
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
                /** @description Resumed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema166"];
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
    "/learned/{id}/share": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Share something you kept with your shared space, when sealed evidence exists */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Learned item id */
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
                /** @description Shared */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema166"];
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
    "/learned/{id}/try": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Try something learned on your own work, approving the exact definition shown */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Learned item id */
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
                /** @description On trial */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema166"];
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
    "/learned/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Undo your latest change, named by the id you were shown */
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
                        change_id: string;
                        space_id: components["schemas"]["__schema8"];
                    };
                };
            };
            responses: {
                /** @description Undone */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema166"];
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
    "/learning/notices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Open "keep doing this?" questions and unread notices that something stopped */
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
                /** @description Notices */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            notices: components["schemas"]["__schema167"][];
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
    "/learning/notices/{id}/answer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Answer yes, no or change to a "keep doing this?" question */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Notice id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        answer: "yes";
                        space_id: components["schemas"]["__schema8"];
                    } | {
                        /** @constant */
                        answer: "no";
                        reason?: string;
                        space_id: components["schemas"]["__schema8"];
                    } | {
                        /** @constant */
                        answer: "change";
                        space_id: components["schemas"]["__schema8"];
                        text: string;
                    };
                };
            };
            responses: {
                /** @description Answered */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            episode_id: components["schemas"]["__schema141"] | null;
                            item: components["schemas"]["__schema163"] | null;
                            notice: components["schemas"]["__schema167"];
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
    "/learning/notices/{id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Dismiss a notice that something stopped */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Notice id */
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
                /** @description Read */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            notice: components["schemas"]["__schema167"];
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
                    space_id?: components["schemas"]["__schema104"];
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
                            company: components["schemas"]["__schema464"];
                            item: components["schemas"]["__schema467"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema467"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Already finished, or no longer quotable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Handling is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/ledger/{id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stop handling this item
         * @description Cancels the job chasing the item, if one still runs, and returns the item to open so it can be handled again later.
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
                /** @description The item, open again */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema467"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The item is already settled or dropped */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Stopping is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                    "application/json": components["schemas"]["__schema59"];
                };
            };
            responses: {
                /** @description Signed in */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema319"];
                    };
                };
                /** @description An email and a password of 8 to 1024 characters are required */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The email or the password is wrong */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The request came from another origin */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No database is configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/mcp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Not offered: the endpoint holds no stream */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description POST only */
                405: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema393"];
                    };
                };
            };
        };
        put?: never;
        /**
         * The MCP endpoint (streamable HTTP, one JSON response per message)
         * @description Tools: waiting_on, handle, safe_send, remember, recall and status, each acting as the person the token names, in the space they agreed from. safe_send only proposes: the person approves the exact text in Melete. A token whose person can no longer use that space is refused with 401 and its connection ends. Tool calls are limited per connection.
         */
        post: {
            parameters: {
                query?: never;
                header?: {
                    "MCP-Protocol-Version"?: string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        id?: string | number;
                        /** @constant */
                        jsonrpc: "2.0";
                        method: string;
                        params?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description The JSON-RPC response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema393"];
                    };
                };
                /** @description A notification was accepted */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Not one JSON-RPC 2.0 message, or an unknown version */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema393"];
                    };
                };
                /** @description No valid access token */
                401: {
                    headers: {
                        /** @description Bearer, with resource_metadata naming the protected resource metadata */
                        "WWW-Authenticate": string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Too many tool calls from this connection */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema393"];
                    };
                };
            };
        };
        /** Not offered: the endpoint holds no session */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description POST only */
                405: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema393"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/mcp-sign-ins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start connecting a remote MCP server by signing in to it
         * @description Reads the server's protected resource metadata (RFC 9728) and its authorization server's metadata, registers a client (the one given, a Client ID Metadata Document, or dynamic registration), and answers with the address to open in the browser. The request carries PKCE (S256), a state and the resource indicator (RFC 8707). When the browser returns, the credential is sealed and the server is installed with the grants in `mcp`, exactly as a connection with a pasted credential is. With `connection_id` instead, it signs in again for that connection, asking for everything granted before and any scopes it has needed since, and gives it the new credential.
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
                        client?: components["schemas"]["__schema84"];
                        label: string;
                        mcp: components["schemas"]["__schema64"];
                        space_id?: string;
                    } | {
                        client?: components["schemas"]["__schema84"];
                        connection_id: string;
                    };
                };
            };
            responses: {
                /** @description Open `authorize_url` in the browser */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uri */
                            authorize_url: string;
                            expires_at: components["schemas"]["__schema134"];
                            /** Format: uri */
                            issuer: string;
                            /** Format: uri */
                            redirect_uri: string;
                            scopes: components["schemas"]["__schema390"][];
                            sign_in_id: string;
                        };
                    };
                };
                /** @description Invalid request or server address */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No public address to return to, no master key, a server that needs no sign-in, or one that needs a client registered by hand */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The server or its authorization server did not answer as required */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/mcp-sign-ins/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read how a sign-in is going */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sign-in id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Pending, connected, or failed with a code */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            expires_at: components["schemas"]["__schema134"];
                            /** @constant */
                            state: "pending";
                        } | {
                            connection_id: string;
                            /** @constant */
                            state: "connected";
                        } | {
                            error: string;
                            /** @constant */
                            state: "failed";
                        };
                    };
                };
                /** @description No sign-in by that id for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/mcp/clients": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The assistants this person has connected */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connected assistants */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            clients: {
                                client_id: string;
                                name: string;
                                /** Format: date-time */
                                since: string;
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
    "/mcp/clients/{clientId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Disconnect an assistant: every token it holds for this person ends */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The client ID */
                    clientId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Disconnected */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description No connection from that assistant */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
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
                        "application/json": components["schemas"]["__schema319"];
                    };
                };
                /** @description No session, or the session has expired */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        delivered: components["schemas"]["__schema41"][];
                        payload: components["schemas"]["__schema33"];
                        uses: components["schemas"]["__schema40"];
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
                            findings: components["schemas"]["__schema313"][];
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
    "/memory/beliefs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/beliefs
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
                            beliefs: {
                                /** @enum {string} */
                                category: "people" | "preferences" | "accounts" | "routines" | "work" | "other";
                                changed_at: components["schemas"]["__schema244"];
                                corrected: boolean;
                                disputed: boolean;
                                earlier: components["schemas"]["__schema245"];
                                id: components["schemas"]["__schema216"];
                                label: components["schemas"]["__schema217"];
                                last_used: components["schemas"]["__schema244"] | null;
                                learned_at: components["schemas"]["__schema244"];
                                source: components["schemas"]["__schema243"];
                                /** @enum {string} */
                                trust: "yours" | "connected" | "outside" | "worked_out";
                                trust_label: components["schemas"]["__schema217"];
                                value: components["schemas"]["__schema242"];
                                version: components["schemas"]["__schema216"];
                            }[];
                            time_zone: components["schemas"]["__schema217"];
                        } | components["schemas"]["__schema205"];
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
    "/memory/beliefs/{id}/block": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /memory/beliefs/{id}/block
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
    "/memory/beliefs/{id}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/beliefs/{id}/history
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
                            label: components["schemas"]["__schema217"];
                            versions: {
                                at: components["schemas"]["__schema244"];
                                current: boolean;
                                source: components["schemas"]["__schema243"];
                                value: components["schemas"]["__schema242"];
                            }[];
                        } | components["schemas"]["__schema205"];
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
    "/memory/blocks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/blocks
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
                            blocks: {
                                created_at: components["schemas"]["__schema244"];
                                id: components["schemas"]["__schema216"];
                                label: components["schemas"]["__schema217"];
                            }[];
                        } | components["schemas"]["__schema205"];
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
    "/memory/blocks/{id}": {
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
         * DELETE /memory/blocks/{id}
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
                    };
                };
            };
        };
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
                                audience: components["schemas"]["__schema295"];
                                current: components["schemas"]["__schema306"];
                                domain_key: components["schemas"]["__schema293"];
                                head_revision: components["schemas"]["__schema294"];
                                hidden: components["schemas"]["__schema310"];
                                id: components["schemas"]["__schema299"];
                                key: components["schemas"]["__schema309"];
                                space_id: components["schemas"]["__schema308"];
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
                                audience: components["schemas"]["__schema295"];
                                domain_key: components["schemas"]["__schema293"];
                                head_revision: components["schemas"]["__schema294"];
                                hidden: components["schemas"]["__schema310"];
                                id: components["schemas"]["__schema299"];
                                key: components["schemas"]["__schema309"];
                                space_id: components["schemas"]["__schema308"];
                            };
                            revisions: components["schemas"]["__schema306"][];
                        };
                    };
                };
                /** @description No such claim */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                                alternative: components["schemas"]["__schema300"];
                                /** @enum {string} */
                                audience: "private" | "space" | "public";
                                claim_id: string;
                                head: components["schemas"]["__schema300"];
                                id: components["schemas"]["__schema311"];
                                key: components["schemas"]["__schema301"];
                                question_id: components["schemas"]["__schema311"] | null;
                                recorded_at: components["schemas"]["__schema134"];
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
                        claim_id: components["schemas"]["__schema38"];
                        content: string;
                        expected_revision: components["schemas"]["__schema37"];
                        idempotency_key: components["schemas"]["__schema36"];
                        text: string;
                        valid_from: components["schemas"]["__schema31"];
                        /** @default null */
                        valid_until?: components["schemas"]["__schema31"] | null;
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
                        "application/json": components["schemas"]["__schema306"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/memory/digest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/digest
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
                            digest: {
                                created_at: components["schemas"]["__schema244"];
                                id: components["schemas"]["__schema216"];
                                items: {
                                    at: components["schemas"]["__schema244"];
                                    belief_id: components["schemas"]["__schema216"];
                                    /** @enum {string} */
                                    change: "learned" | "changed" | "corrected";
                                    current: boolean;
                                    label: components["schemas"]["__schema217"];
                                    previous: components["schemas"]["__schema242"] | null;
                                    value: components["schemas"]["__schema242"];
                                    version: components["schemas"]["__schema216"] | null;
                                }[];
                                seen_at: components["schemas"]["__schema244"] | null;
                                title: components["schemas"]["__schema217"];
                                week_of: components["schemas"]["__schema246"];
                                window_end: components["schemas"]["__schema244"];
                                window_start: components["schemas"]["__schema244"];
                            } | null;
                            next_at: components["schemas"]["__schema244"];
                        } | components["schemas"]["__schema205"];
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
    "/memory/digest/{id}/seen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /memory/digest/{id}/seen
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
    "/memory/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/export
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query: {
                    format: "json" | "markdown";
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
                            content: string;
                            filename: components["schemas"]["__schema217"];
                            /** @enum {string} */
                            format: "json" | "markdown";
                        } | components["schemas"]["__schema205"];
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
                        claim_id?: components["schemas"]["__schema38"];
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
                        "application/json": components["schemas"]["__schema307"];
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
    "/memory/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /memory/import
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
                        content: string;
                        /** @enum {string} */
                        format: "json" | "markdown";
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
                            imported: components["schemas"]["__schema245"];
                            notes: components["schemas"]["__schema217"][];
                            skipped: components["schemas"]["__schema245"];
                        } | components["schemas"]["__schema205"];
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
                query?: {
                    after?: components["schemas"]["__schema13"];
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
                            items: components["schemas"]["__schema240"][];
                            next?: components["schemas"]["__schema199"] | null;
                        } | components["schemas"]["__schema205"];
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
                        key: components["schemas"]["__schema18"];
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
                            item: components["schemas"]["__schema240"];
                        } | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
                        version: components["schemas"]["__schema13"];
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
                            reasons: components["schemas"]["__schema200"][];
                            used_at: components["schemas"]["__schema203"] | null;
                        } | components["schemas"]["__schema205"];
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
                                affected: components["schemas"]["__schema317"][];
                                changed_handle: components["schemas"]["__schema300"];
                                created_at: components["schemas"]["__schema134"];
                                id: components["schemas"]["__schema311"];
                                job_id: string;
                                key: components["schemas"]["__schema301"] | null;
                                new_value: components["schemas"]["__schema316"];
                                old_value: components["schemas"]["__schema316"];
                                replacement_handle: components["schemas"]["__schema300"] | null;
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
                        output_id: components["schemas"]["__schema39"];
                        output_version: components["schemas"]["__schema39"];
                        uses: components["schemas"]["__schema40"];
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
                            output_id: components["schemas"]["__schema311"];
                            output_version: components["schemas"]["__schema311"];
                            unknown_handles: components["schemas"]["__schema312"][];
                        };
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                                because: components["schemas"]["__schema300"][];
                                created_at: components["schemas"]["__schema134"];
                                id: components["schemas"]["__schema311"];
                                if_ignored: string;
                                key: components["schemas"]["__schema301"];
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
                        at?: components["schemas"]["__schema31"];
                        job_id?: string;
                        /** @default 10 */
                        limit?: components["schemas"]["__schema37"];
                        /** @default 2000 */
                        max_tokens?: components["schemas"]["__schema37"];
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
                                authoritative_revision: components["schemas"]["__schema296"];
                                indexed_revision: components["schemas"]["__schema296"];
                                /** @enum {string} */
                                reason: "ready" | "index_lag" | "budget" | "timeout" | "index_failure" | "restore_pending" | "public_compartment";
                                supplemented: components["schemas"]["__schema296"];
                                truncated: boolean;
                            };
                            /** @default [] */
                            disputed_keys: components["schemas"]["__schema301"][];
                            index_generation: components["schemas"]["__schema296"] | null;
                            items: {
                                claim_id: components["schemas"]["__schema299"];
                                content: string;
                                /** @default false */
                                disputed: boolean;
                                domain_key: components["schemas"]["__schema293"];
                                excerpts: string[];
                                factual_status: components["schemas"]["__schema303"];
                                handle: components["schemas"]["__schema300"];
                                /** @default null */
                                key: components["schemas"]["__schema301"] | null;
                                kind: components["schemas"]["__schema302"];
                                /** @default inferred */
                                origin_trust: components["schemas"]["__schema297"];
                                recorded_at: components["schemas"]["__schema134"];
                                revision: components["schemas"]["__schema294"];
                                sources: components["schemas"]["__schema305"][];
                                status: components["schemas"]["__schema304"];
                                superseded_at: components["schemas"]["__schema134"] | null;
                                valid_from: components["schemas"]["__schema134"];
                                valid_until: components["schemas"]["__schema134"] | null;
                            }[];
                            recipe: components["schemas"]["__schema293"];
                            snapshot: components["schemas"]["__schema298"] | null;
                            /** @enum {string} */
                            status: "complete" | "degraded" | "unavailable";
                            token_budget: {
                                /** @enum {string} */
                                counter: "utf8-bytes-upper-bound-v1" | "utf8-bytes-quarter-v1";
                                limit: components["schemas"]["__schema294"];
                                used: components["schemas"]["__schema296"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                                reason: "key_not_in_registry" | "span_not_verbatim" | "span_outside_segment" | "value_not_in_evidence" | "date_not_parseable" | "value_not_well_formed" | "confidence_is_not_a_status" | "checked_status_requires_tier0" | "invalid_shape" | "blocked_by_person";
                                recorded_at: components["schemas"]["__schema134"];
                                work_id: components["schemas"]["__schema311"];
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
    "/memory/rewind": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /memory/rewind
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
                    "application/json": components["schemas"]["__schema19"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema249"] | components["schemas"]["__schema205"];
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
    "/memory/rewind/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /memory/rewind/preview
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
                    "application/json": components["schemas"]["__schema19"];
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
                            label: components["schemas"]["__schema217"];
                            skipped: components["schemas"]["__schema217"][];
                            steps: components["schemas"]["__schema248"][];
                        } | components["schemas"]["__schema205"];
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
    "/memory/rewinds/{id}/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /memory/rewinds/{id}/undo
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
                        "application/json": components["schemas"]["__schema249"] | components["schemas"]["__schema205"];
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
    "/memory/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/settings
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
                        "application/json": components["schemas"]["__schema241"] | components["schemas"]["__schema205"];
                    };
                };
            };
        };
        /**
         * PUT /memory/settings
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        capture: boolean;
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
                        "application/json": components["schemas"]["__schema241"] | components["schemas"]["__schema205"];
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
                        event_at: components["schemas"]["__schema31"];
                        source_identity: components["schemas"]["__schema36"];
                        /** @enum {string} */
                        source_type: "message" | "document" | "observation" | "receipt" | "assistant";
                        source_version: components["schemas"]["__schema36"];
                        stream: components["schemas"]["__schema36"];
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
                            committed_sequence: components["schemas"]["__schema294"];
                            duplicate: boolean;
                            source: components["schemas"]["__schema291"];
                        };
                    };
                };
                /** @description Invalid evidence */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            source: components["schemas"]["__schema291"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema307"];
                    };
                };
                /** @description No such source */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/memory/timeline": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/timeline
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: {
                    days?: string;
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
                            days: {
                                changes: {
                                    at: components["schemas"]["__schema244"];
                                    belief_id: components["schemas"]["__schema216"];
                                    /** @enum {string} */
                                    change: "learned" | "changed" | "corrected" | "restored" | "removed";
                                    label: components["schemas"]["__schema217"];
                                    previous: components["schemas"]["__schema242"] | null;
                                    value: components["schemas"]["__schema242"] | null;
                                }[];
                                day: components["schemas"]["__schema246"];
                                label: components["schemas"]["__schema217"];
                                rewinds: components["schemas"]["__schema247"][];
                            }[];
                            time_zone: components["schemas"]["__schema217"];
                        } | components["schemas"]["__schema205"];
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
                        handles: components["schemas"]["__schema40"];
                        payload: components["schemas"]["__schema33"];
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
                            fields: components["schemas"]["__schema314"][];
                            minimum_trust: components["schemas"]["__schema297"];
                            unresolved: components["schemas"]["__schema315"][];
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
                        "application/json": components["schemas"]["__schema324"];
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
                            reaction: components["schemas"]["__schema323"];
                        };
                    };
                };
                /** @description No such message */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description That event is not a message */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/microsoft-sign-ins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whether signing in with Microsoft is offered here
         * @description Available once the operator has set a Microsoft OAuth client and an https:// or localhost public address. `redirect_uri` is the address to register with that client.
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
                /** @description Availability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema394"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Start connecting Outlook mail and calendar by signing in with Microsoft
         * @description Answers with the Microsoft address to open in the browser. One consent asks to read the profile, read mail, send mail and read and write calendars; drafts stay in Melete. Personal and work or school accounts can sign in. When the browser returns, each part the person allowed becomes a connection with the same tools, approvals and receipts as a mailbox or calendar connected with a password. Signing in again with the same account renews those connections instead of adding more.
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
                    "application/json": components["schemas"]["__schema94"];
                };
            };
            responses: {
                /** @description Open `authorize_url` in the browser */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema395"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No OAuth client, no public address to return to, or no master key */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/microsoft-sign-ins/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read how a Microsoft sign-in is going */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sign-in id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Pending, connected with its connections, or failed with a code */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema396"];
                    };
                };
                /** @description No sign-in by that id for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                    provider: components["schemas"]["__schema119"];
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
                        "application/json": components["schemas"]["__schema494"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                    provider: components["schemas"]["__schema119"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description `device` shows a code to enter at the provider; `browser` returns an address to open, after which the address the browser was sent back to is pasted into complete. Left out, the provider’s first method. */
                        method?: components["schemas"]["__schema120"];
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
                            expires_at: components["schemas"]["__schema134"];
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
                            expires_at: components["schemas"]["__schema134"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The provider could not be reached or refused the request */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                    provider: components["schemas"]["__schema119"];
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
                        "application/json": components["schemas"]["__schema494"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                    provider: components["schemas"]["__schema119"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description For a browser sign-in: the whole address the provider sent the browser back to. Its state must match the sign-in it completes. */
                        callback_url?: components["schemas"]["__schema121"];
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
                        "application/json": components["schemas"]["__schema494"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No unfinished sign-in by that id */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The provider could not be reached or refused the code */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            providers: components["schemas"]["__schema494"][];
                        };
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set, so nothing can be sealed */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/model-settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Which model new attempts use, and how each provider is connected
         * @description Any signed-in account may read it; `can_edit` says whether this one may change it. No key is ever returned, only whether one is set and its last four characters. A key the server environment names wins over one entered here and is shown as `operator`.
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
                /** @description Model settings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema489"];
                    };
                };
                /** @description Not signed in */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/model-settings/default": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Choose the model new attempts use
         * @description Takes effect for the next attempt, without a restart. The provider must already have a key or a sign-in.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        model: string;
                        /** @enum {string} */
                        provider: "anthropic" | "openai" | "google" | "fireworks" | "openai-compatible" | "chatgpt";
                    };
                };
            };
            responses: {
                /** @description Model settings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema489"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The provider has no key or sign-in yet */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
        post?: never;
        /** Go back to the server’s default model */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Model settings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema489"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-settings/keys/{provider}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Store a provider key, sealed with the master key */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: components["schemas"]["__schema116"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        api_key: string;
                        /** @description Required for, and only for, the OpenAI-compatible endpoint */
                        base_url?: components["schemas"]["__schema118"];
                    };
                };
            };
            responses: {
                /** @description Model settings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema489"];
                    };
                };
                /** @description Invalid key or endpoint address */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The server environment already sets this provider’s key */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set, so the key cannot be sealed */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
        post?: never;
        /** Remove a key entered in the app */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: components["schemas"]["__schema116"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Model settings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema489"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-settings/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Try a provider key with one small call, and list the provider’s models
         * @description Asks the provider for its model list with the given key, or with the key already set. A refusal answers 200 with `ok: false` and a plain sentence; nothing is saved.
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
                        /** @description A key to try before saving it. Left out, the key already set. */
                        api_key?: components["schemas"]["__schema117"];
                        base_url?: components["schemas"]["__schema118"];
                        provider: components["schemas"]["__schema116"];
                    };
                };
            };
            responses: {
                /** @description What the provider answered */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            latency_ms: number;
                            /** @description The model ids the provider lists, sorted; empty if it lists none */
                            models: components["schemas"]["__schema492"][];
                            /** @constant */
                            ok: true;
                        } | {
                            /** @enum {string} */
                            code: "key_refused" | "not_found" | "timeout" | "unreachable" | "rate_limited" | "provider_error" | "no_key" | "invalid_address";
                            /** @description What went wrong and what to do, in plain words */
                            message: string;
                            /** @constant */
                            ok: false;
                            /** @description The provider’s HTTP status, when it answered */
                            status: components["schemas"]["__schema493"] | null;
                        };
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            notifications: components["schemas"]["__schema290"][];
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
                        "application/json": components["schemas"]["__schema290"];
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
                        "application/json": components["schemas"]["__schema290"];
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
    "/oauth/authorize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The consent page an assistant sends a person to
         * @description Shows the signed-in person who is asking (a checked host, or a self-given name marked unverified), the space the access would act in, and what it could do. An error about the request goes back with the state and issuer only to a trusted redirect address: loopback, the metadata document host, or one a person here already allowed. Anywhere else it is shown on this page.
         */
        get: {
            parameters: {
                query: {
                    client_id: components["schemas"]["__schema87"];
                    code_challenge: components["schemas"]["__schema89"];
                    code_challenge_method: components["schemas"]["__schema90"];
                    redirect_uri: components["schemas"]["__schema88"];
                    resource?: components["schemas"]["__schema93"];
                    response_type: components["schemas"]["__schema86"];
                    scope?: components["schemas"]["__schema92"];
                    state?: components["schemas"]["__schema91"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The consent page, or a prompt to sign in first */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description An error returned to the assistant */
                302: {
                    headers: {
                        Location: string;
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description The client or its redirect address is unknown, or the request was refused */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description Too many authorization requests from this address */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
            };
        };
        put?: never;
        /**
         * The person's answer on the consent page
         * @description Accepted only from the page shown to this session for this exact request. Allowing returns a single-use code bound to the PKCE challenge.
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
                    "application/x-www-form-urlencoded": {
                        client_id: components["schemas"]["__schema87"];
                        code_challenge: components["schemas"]["__schema89"];
                        code_challenge_method: components["schemas"]["__schema90"];
                        consent: string;
                        /** @enum {string} */
                        decision: "allow" | "deny";
                        redirect_uri: components["schemas"]["__schema88"];
                        resource?: components["schemas"]["__schema93"];
                        response_type: components["schemas"]["__schema86"];
                        scope?: components["schemas"]["__schema92"];
                        state?: components["schemas"]["__schema91"];
                    };
                };
            };
            responses: {
                /** @description Back to the assistant with a code, or with access_denied */
                302: {
                    headers: {
                        Location: string;
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description The client or its redirect address is unknown, or the request was refused */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description The page expired or was not shown to this session */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description Too many authorization requests from this address */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
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
    "/oauth/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Where the authorization server returns the browser after signing in
         * @description Checks the state and the issuer (RFC 9207) before the code is spent, then installs the connection. Answers with a short page for the browser; the outcome is also available from the sign-in status.
         */
        get: {
            parameters: {
                query?: {
                    code?: string;
                    error?: string;
                    iss?: string;
                    state?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connected */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description The response was refused */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description No such sign-in for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
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
    "/oauth/client-metadata.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * This service's OAuth Client ID Metadata Document
         * @description Published when the service has an https:// public address, so an authorization server that supports Client ID Metadata Documents can identify it without registration. No session is needed.
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
                /** @description The client metadata */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uri */
                            client_id: string;
                            client_name: string;
                            grant_types: string[];
                            redirect_uris: string[];
                            response_types: string[];
                            token_endpoint_auth_method: string;
                        };
                    };
                };
                /** @description No https:// public address is configured */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/oauth/google/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Where Google returns the browser after signing in
         * @description Checks the state before the code is spent, then connects what was granted. Answers with a short page for the browser; the outcome is also available from the sign-in status.
         */
        get: {
            parameters: {
                query?: {
                    code?: string;
                    error?: string;
                    scope?: string;
                    state?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connected */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description The response was refused, or nothing was granted */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description No such sign-in for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
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
    "/oauth/microsoft/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Where Microsoft returns the browser after signing in
         * @description Checks the state before the code is spent, then connects what was granted. Answers with a short page for the browser; the outcome is also available from the sign-in status.
         */
        get: {
            parameters: {
                query?: {
                    code?: string;
                    error?: string;
                    scope?: string;
                    state?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connected */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description The response was refused, or nothing was granted */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
                    };
                };
                /** @description No such sign-in for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "text/html": string;
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
    "/oauth/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register an assistant as a public OAuth client (RFC 7591)
         * @description Public clients only, with PKCE. A client may instead use an https:// client ID metadata document.
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
                        client_name?: string;
                        grant_types?: ("authorization_code" | "refresh_token")[];
                        redirect_uris: components["schemas"]["__schema85"][];
                        response_types?: "code"[];
                        scope?: string;
                        /** @constant */
                        token_endpoint_auth_method?: "none";
                    } & {
                        [key: string]: unknown;
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
                        "application/json": {
                            client_id: string;
                            client_id_issued_at: number;
                            client_name: string;
                            grant_types: string[];
                            redirect_uris: string[];
                            response_types: string[];
                            /** @constant */
                            token_endpoint_auth_method: "none";
                        };
                    };
                };
                /** @description The metadata was refused */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema392"];
                    };
                };
                /** @description Too many registrations from this address, or too many waiting for a person to allow them */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema392"];
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
    "/oauth/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke a token and every token of its connection (RFC 7009) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/x-www-form-urlencoded": {
                        token: string;
                    };
                };
            };
            responses: {
                /** @description Revoked, or never valid */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/oauth/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Exchange a code, or rotate a refresh token
         * @description A code is used once, with its PKCE verifier. Each refresh returns a new refresh token; presenting a used one ends every token of that connection. No token outlives 90 days from the consent, however often it is refreshed.
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
                    "application/x-www-form-urlencoded": {
                        client_id: string;
                        code?: string;
                        code_verifier?: string;
                        /** @enum {string} */
                        grant_type: "authorization_code" | "refresh_token";
                        redirect_uri?: string;
                        refresh_token?: string;
                        resource?: string;
                    };
                };
            };
            responses: {
                /** @description Tokens */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            access_token: string;
                            expires_in: number;
                            refresh_token: string;
                            scope: string;
                            /** @constant */
                            token_type: "Bearer";
                        };
                    };
                };
                /** @description The grant was refused */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema392"];
                    };
                };
                /** @description The client is not registered */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema392"];
                    };
                };
                /** @description Too many requests from this address */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema392"];
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
                            operations: components["schemas"]["__schema288"][];
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
                        version: components["schemas"]["__schema32"];
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
                        "application/json": components["schemas"]["__schema288"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        due_at: components["schemas"]["__schema31"];
                        version: components["schemas"]["__schema32"];
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
                        "application/json": components["schemas"]["__schema288"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        result: components["schemas"]["__schema33"];
                        version: components["schemas"]["__schema32"];
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
                        "application/json": components["schemas"]["__schema288"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            permissions: components["schemas"]["__schema218"][];
                        } | components["schemas"]["__schema205"];
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
                        version: components["schemas"]["__schema13"];
                    } | {
                        bounds: {
                            count_cap: number;
                            expires_at: components["schemas"]["__schema16"];
                            reconsent_after_days: number;
                        };
                        /** @constant */
                        option: "always";
                        version: components["schemas"]["__schema13"];
                    } | {
                        /** @constant */
                        option: "deny";
                        version: components["schemas"]["__schema13"];
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
                            rule: components["schemas"]["__schema225"] | null;
                            /** @constant */
                            status: "ok";
                        } | components["schemas"]["__schema205"];
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
                            plans: components["schemas"]["__schema250"][];
                        } | components["schemas"]["__schema205"];
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
                        category: components["schemas"]["__schema12"];
                        milestones: components["schemas"]["__schema20"][];
                        title: components["schemas"]["__schema12"];
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
                        "application/json": components["schemas"]["__schema251"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema251"] | components["schemas"]["__schema205"];
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
                    "application/json": components["schemas"]["__schema14"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema206"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema251"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema205"] | components["schemas"]["__schema205"];
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
    "/plugins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the plugins that can be added with one tap
         * @description Each plugin is a tool server Melete runs in a container of its own, at a pinned version. `fields` are the few values a person supplies; `installed` names the connection already running it in the space. Empty when this service does not run plugin containers.
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
                /** @description Plugins */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            plugins: components["schemas"]["Plugin"][];
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
    "/plugins/{pluginId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add a plugin from the catalog
         * @description Builds the installation from the catalog entry and the supplied values, then installs it exactly as `POST /connections` does. Secret values are sealed on arrival and given only to the plugin. The service starts it when a tool is first used, stops it when idle, and moves it to the pinned version of each release.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Catalog entry id */
                    pluginId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        space_id?: string;
                        /** @default {} */
                        values?: {
                            [key: string]: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Added */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            check?: components["schemas"]["ConnectionCheck"];
                            connection: components["schemas"]["Connection"];
                        };
                    };
                };
                /** @description A value is missing or invalid */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such plugin */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The plugin is already added to this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                                created_at: components["schemas"]["__schema134"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Email already registered */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            procedures: components["schemas"]["__schema146"][];
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
                        "application/json": components["schemas"]["__schema162"];
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
                        "application/json": components["schemas"]["__schema145"];
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
                        "application/json": components["schemas"]["__schema145"];
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
                        "application/json": components["schemas"]["__schema162"];
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
                    "application/json": components["schemas"]["__schema10"];
                };
            };
            responses: {
                /** @description Rejected history */
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
                    "application/json": components["schemas"]["__schema10"];
                };
            };
            responses: {
                /** @description Reverted procedure */
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
                    "application/json": components["schemas"]["__schema9"];
                };
            };
            responses: {
                /** @description Procedure on owner trial */
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
                        "application/json": components["schemas"]["__schema252"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema252"] | components["schemas"]["__schema205"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/push/public-key": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The key a browser subscribes with, or null when push is not configured */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Public key */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            public_key: string | null;
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
    "/push/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** What Melete pushes, how often, and the quiet hours read from the profile */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Settings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema138"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Change what Melete pushes and how often */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        batch_minutes?: number;
                        daily_cap?: number;
                        decisions?: boolean;
                        settled?: boolean;
                        weekly_summary?: boolean;
                    };
                };
            };
            responses: {
                /** @description Settings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema138"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/push/subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** This person’s devices that receive pushes */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Subscriptions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            subscriptions: components["schemas"]["__schema133"][];
                        };
                    };
                };
            };
        };
        put?: never;
        /**
         * Subscribe this device; the same endpoint again updates it
         * @description Only endpoints on a known browser push service, or an origin the operator added, are accepted, with a P-256 public key and a 16-byte secret.
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
                        /** @default  */
                        device_label?: string;
                        /** Format: uri */
                        endpoint: string;
                        keys: {
                            auth: string;
                            p256dh: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Subscribed */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema135"];
                    };
                };
                /** @description Not a push service this installation sends to, or keys a browser does not subscribe with */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Push is not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/push/subscriptions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Stop pushes to one of this person’s devices */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Subscription id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Removed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema135"];
                    };
                };
                /** @description No such subscription for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
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
                            questions: components["schemas"]["__schema284"][];
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
                            error?: components["schemas"]["__schema137"];
                            job: components["schemas"]["__schema259"] | null;
                            question: components["schemas"]["__schema284"];
                            receipt: components["schemas"]["__schema281"] | null;
                        };
                    };
                };
                /** @description The question is no longer open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            questions: components["schemas"]["__schema221"][];
                        } | components["schemas"]["__schema205"];
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
                        option_id: components["schemas"]["__schema13"];
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
                            receipt: components["schemas"]["__schema213"];
                        } | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                            obligations: components["schemas"]["__schema289"][];
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
                        "application/json": components["schemas"]["__schema289"];
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
                    "Idempotency-Key"?: components["schemas"]["__schema23"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema24"];
                };
            };
            responses: {
                /** @description A retried submission whose first status was not recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description Accepted, or the same key and input submitted again */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"] | components["schemas"]["__schema136"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"] | components["schemas"]["__schema136"];
                    };
                };
                /** @description No such space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema258"];
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
                            rules: components["schemas"]["__schema225"][];
                        } | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
                                conversation_id: components["schemas"]["__schema199"] | null;
                                id: components["schemas"]["__schema199"];
                                /** @enum {string} */
                                kind: "conversation" | "plan" | "task" | "event" | "connection" | "action";
                                meta: string;
                                title: components["schemas"]["__schema200"];
                            }[];
                        } | components["schemas"]["__schema205"];
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
        /**
         * Whether the first account still needs to be created
         * @description Public, like setup itself, so a browser with no session can choose between creating the account and signing in. `needed` is true until an owner exists.
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
                /** @description Whether setup is needed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            needed: boolean;
                        };
                    };
                };
                /** @description No database is configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
            };
        };
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
                    "application/json": components["schemas"]["__schema59"];
                };
            };
            responses: {
                /** @description The owner, signed in */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema319"];
                    };
                };
                /** @description An email and a password of 8 to 1024 characters are required */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The request came from another origin */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The owner is already set up */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No database is configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema205"] | components["schemas"]["__schema205"];
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
    "/signin/chatgpt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /signin/chatgpt
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
                        "application/json": components["schemas"]["__schema205"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema205"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
                                    triggers: components["schemas"]["__schema442"][];
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
                        "application/json": components["schemas"]["__schema285"];
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
                        "application/json": components["schemas"]["__schema320"];
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
                        "application/json": components["schemas"]["__schema320"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Space owner required, or no such space */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description The browser worker uses this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            membership: components["schemas"]["__schema179"];
                        };
                    };
                };
                /** @description Space owner required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            membership: components["schemas"]["__schema179"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                            companies: components["schemas"]["__schema464"][];
                            currency: components["schemas"]["__schema466"];
                            items: components["schemas"]["__schema467"][];
                            totals: {
                                data_holders: number;
                                monthly_spend_minor: components["schemas"]["__schema465"];
                                owed_to_you_minor: components["schemas"]["__schema465"];
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
                        "application/json": components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No mailbox is connected to this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            /** @description Present when the scan stopped at the daily allowance; the rest are read on a later scan */
                            note?: components["schemas"]["__schema463"];
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
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description No such scan in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
                            receipt: components["schemas"]["__schema281"];
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
                            tasks: components["schemas"]["__schema253"][];
                        } | components["schemas"]["__schema205"];
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
                    "application/json": components["schemas"]["__schema21"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema254"] | components["schemas"]["__schema205"];
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
                        "application/json": components["schemas"]["__schema227"] | components["schemas"]["__schema205"];
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
                    "application/json": components["schemas"]["__schema21"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema254"] | components["schemas"]["__schema205"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/waiting-on": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What this person is waiting on: money owed to them, and replies
         * @description Combines the company map’s owed items with messages the person sent that asked for something and have not been answered after three days. The owed figure is the company map’s own. `top` holds up to three nothing is chasing yet. A reply nothing is chasing that went out more than thirty days ago is left out. Reads only; a scan is started with `POST /spaces/{spaceId}/companies/scan` in the space `scan.space_id` names.
         */
        get: {
            parameters: {
                query?: {
                    /** @description One space; every space the person can see if absent */
                    space_id?: components["schemas"]["__schema105"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description What is waited on, and the latest scan */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            currency: components["schemas"]["__schema466"];
                            owed: components["schemas"]["__schema470"][];
                            owed_minor: components["schemas"]["__schema465"];
                            replies: components["schemas"]["__schema470"][];
                            scan: {
                                connected: boolean;
                                finished_at: components["schemas"]["__schema134"] | null;
                                space_id: string | null;
                                stale: boolean;
                                /** @enum {string} */
                                status: "none" | "running" | "done" | "failed";
                            };
                            top: components["schemas"]["__schema470"][];
                        };
                    };
                };
                /** @description This space is not accessible to the signed-in account */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/waiting-on/replies/{id}/chase": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start the job that chases a reply the person is waiting on
         * @description Creates the job that runs the chase-reply playbook for one sent message. The follow-up goes through the existing approval path, which shows the exact text; this route starts the work, it does not send.
         */
        post: {
            parameters: {
                query?: {
                    space_id?: string;
                };
                header?: never;
                path: {
                    /** @description Awaited reply id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Already being chased, by the job named here */
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
                /** @description The job now chasing it */
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
                /** @description No such awaited reply for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Already finished, or no longer quotable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Chasing is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
    "/waiting-on/replies/{id}/drop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Dismiss a reply the person is no longer waiting on
         * @description Marks the awaited reply dropped, so it leaves the list and a later scan does not bring it back. A chase that has it is stopped first.
         */
        post: {
            parameters: {
                query?: {
                    space_id?: string;
                };
                header?: never;
                path: {
                    /** @description Awaited reply id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The reply, now dropped */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            evidence: components["schemas"]["__schema469"];
                            id: string;
                            job_id: string | null;
                            message_id: string;
                            principal_id: string;
                            sent_at: components["schemas"]["__schema134"];
                            space_id: string;
                            status: components["schemas"]["__schema468"];
                            subject: string;
                            to: string;
                            to_name: string | null;
                        };
                    };
                };
                /** @description No such awaited reply for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
                    };
                };
                /** @description Stopping its chase is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema136"];
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
            definition_hash: string;
            space_id: components["schemas"]["__schema8"];
        };
        __schema10: {
            reason: string;
            space_id: components["schemas"]["__schema8"];
        };
        __schema11: string;
        __schema12: string;
        __schema13: string;
        __schema14: {
            agent_id: components["schemas"]["__schema13"];
        };
        __schema15: string;
        /** Format: date-time */
        __schema16: string;
        __schema17: {
            allowed_connection_ids: components["schemas"]["__schema13"][] | null;
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
        __schema18: string;
        __schema19: {
            /** Format: date */
            day: string;
        } | {
            belief_id: string;
            /** Format: date-time */
            since: string;
        };
        __schema20: {
            assignee: {
                /** @constant */
                kind: "person";
            } | {
                agent_id: components["schemas"]["__schema13"];
                /** @constant */
                kind: "agent";
            };
            schedule_at?: components["schemas"]["__schema16"];
            title: components["schemas"]["__schema12"];
        };
        __schema21: {
            /** @default false */
            done?: boolean;
            due_at: components["schemas"]["__schema16"] | null;
            title: components["schemas"]["__schema12"];
        };
        __schema22: number;
        __schema23: string;
        __schema24: {
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
            importance?: components["schemas"]["__schema26"];
            learning?: components["schemas"]["__schema1"];
            objective: string;
            /** @default interactive */
            scheduling_class?: components["schemas"]["__schema25"];
            space_id: string;
            title: string;
            /** @default 3 */
            unread_threshold?: components["schemas"]["__schema27"];
        };
        /** @enum {string} */
        __schema25: "interactive" | "background" | "quiet";
        /** @enum {string} */
        __schema26: "routine" | "important";
        __schema27: number;
        __schema28: components["schemas"]["__schema25"];
        __schema29: components["schemas"]["__schema26"];
        __schema30: components["schemas"]["__schema27"];
        /** Format: date-time */
        __schema31: string;
        __schema32: number;
        __schema33: {
            [key: string]: components["schemas"]["__schema34"];
        };
        __schema34: (string | number | boolean | null) | components["schemas"]["__schema34"][] | {
            [key: string]: components["schemas"]["__schema34"];
        };
        __schema35: {
            corrects?: components["schemas"]["__schema15"];
            text: string;
        };
        __schema36: string;
        __schema37: number;
        __schema38: string;
        __schema39: string;
        __schema40: components["schemas"]["__schema5"][];
        __schema41: {
            content: string;
            /** @default [] */
            excerpts?: components["schemas"]["__schema42"][];
            handle: components["schemas"]["__schema6"];
            /** @default null */
            key?: components["schemas"]["__schema18"] | null;
        };
        __schema42: string;
        __schema43: string;
        __schema44: string;
        __schema45: string;
        /** @enum {string} */
        __schema46: "private" | "space" | "public";
        /** @enum {string} */
        __schema47: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema48: "active" | "superseded" | "retracted" | "disputed";
        /** @enum {string} */
        __schema49: "high" | "medium" | "low";
        /** @enum {string} */
        __schema50: "user" | "agent" | "document" | "tool";
        __schema51: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote?: string;
            ref: string;
            /** @default null */
            sha256?: string | null;
        };
        /** Format: date */
        __schema52: string;
        /** @default null */
        __schema53: components["schemas"]["__schema52"] | null;
        /** @default [] */
        __schema54: components["schemas"]["__schema43"][];
        /** @default null */
        __schema55: components["schemas"]["__schema43"] | null;
        /** @default [] */
        __schema56: string[];
        /** @default [] */
        __schema57: components["schemas"]["__schema43"][];
        /** @constant */
        __schema58: 1;
        __schema59: {
            /** Format: email */
            email: string;
            password: string;
        };
        __schema60: {
            field: string;
            /** @enum {string} */
            op: "eq" | "contains" | "matches" | "lt" | "gt" | "changed";
            /** @default null */
            value?: string | number | boolean | null;
        };
        /** @default 0 */
        __schema61: number;
        /** @default 200 */
        __schema62: number;
        __schema63: ("job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error")[];
        __schema64: {
            allowed_scopes: components["schemas"]["__schema66"];
            audience: components["schemas"]["__schema68"];
            id: components["schemas"]["__schema65"];
            tools: components["schemas"]["__schema69"];
            /** Format: uri */
            url: string;
        };
        __schema65: string;
        __schema66: components["schemas"]["__schema67"][];
        __schema67: string;
        /** @constant */
        __schema68: "owner";
        __schema69: components["schemas"]["__schema70"][];
        __schema70: {
            alias: string;
            /** @default write_external */
            effect_class?: components["schemas"]["EffectClass"];
            name: string;
            required_scopes: components["schemas"]["__schema67"][];
        };
        /** Format: uri */
        __schema71: string;
        __schema72: string;
        /** Format: uri */
        __schema73: string;
        /** @enum {string} */
        __schema74: "npx" | "uvx" | "image";
        __schema75: string;
        __schema76: string;
        /** @default [] */
        __schema77: components["schemas"]["__schema78"][];
        __schema78: string;
        /** @default [] */
        __schema79: components["schemas"]["__schema80"][];
        __schema80: "*" | string;
        /** @default [] */
        __schema81: components["schemas"]["__schema82"][];
        __schema82: {
            name: string;
            value: string;
        };
        __schema83: string;
        __schema84: {
            client_id: string;
            client_secret?: string;
        };
        __schema85: string;
        /** @constant */
        __schema86: "code";
        __schema87: string;
        __schema88: string;
        __schema89: string;
        /** @constant */
        __schema90: "S256";
        __schema91: string;
        __schema92: string;
        __schema93: string;
        __schema94: {
            calendar_label?: string;
            mail_label?: string;
            space_id?: string;
        };
        __schema95: string;
        __schema96: string;
        __schema97: {
            button: 0 | 1 | 2;
            clicks: 1 | 2 | 3;
            /** @enum {string} */
            k: "move" | "down" | "up";
            mods: components["schemas"]["__schema100"];
            x: components["schemas"]["__schema98"];
            y: components["schemas"]["__schema99"];
        } | {
            dx: components["schemas"]["__schema101"];
            dy: components["schemas"]["__schema101"];
            /** @constant */
            k: "wheel";
            mods: components["schemas"]["__schema100"];
            x: components["schemas"]["__schema98"];
            y: components["schemas"]["__schema99"];
        } | {
            code: string;
            down: boolean;
            /** @constant */
            k: "key";
            key: string;
            mods: components["schemas"]["__schema100"];
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
            points: components["schemas"]["__schema102"][];
        };
        __schema98: number;
        __schema99: number;
        __schema100: number;
        __schema101: number;
        __schema102: {
            id: number;
            x: components["schemas"]["__schema98"];
            y: components["schemas"]["__schema99"];
        };
        __schema103: string;
        __schema104: string;
        __schema105: string;
        __schema106: string;
        __schema107: string;
        __schema108: string;
        __schema109: string;
        __schema110: {
            height: number;
            pixel_ratio?: number;
            width: number;
        };
        /** @enum {string} */
        __schema111: "light" | "dark";
        __schema112: components["schemas"]["__schema113"][];
        __schema113: {
            at: components["schemas"]["__schema31"];
            message: string;
        };
        __schema114: components["schemas"]["__schema115"][];
        __schema115: {
            at: components["schemas"]["__schema31"];
            code: string | null;
            method: string;
            status: number | null;
            url: string;
        };
        /** @enum {string} */
        __schema116: "anthropic" | "openai" | "google" | "fireworks" | "openai-compatible";
        __schema117: string;
        /** @description The endpoint’s version prefix, for example https://models.example.net/v1 */
        __schema118: string;
        /** @enum {string} */
        __schema119: "chatgpt" | "openai-compatible";
        /** @enum {string} */
        __schema120: "device" | "browser";
        __schema121: string;
        __schema122: string;
        __schema123: number;
        __schema124: string;
        __schema125: string;
        /** @enum {string} */
        __schema126: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema127: string | null;
        __schema128: {
            captured_at: components["schemas"]["__schema31"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema129: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema130: string | null;
        __schema131: {
            compression_count?: number;
            in_place?: boolean;
            used_fallback?: boolean;
        };
        __schema132: string;
        __schema133: {
            created_at: components["schemas"]["__schema134"];
            device_label: string;
            endpoint_hash: string;
            id: string;
            last_used_at: components["schemas"]["__schema134"] | null;
        };
        /** Format: date-time */
        __schema134: string;
        __schema135: {
            subscription: components["schemas"]["__schema133"];
        };
        __schema136: {
            error: components["schemas"]["__schema137"];
        };
        __schema137: {
            code: string;
            detail?: {
                [key: string]: unknown;
            };
            message: string;
        };
        __schema138: {
            settings: {
                batch_minutes: number;
                daily_cap: number;
                decisions: boolean;
                quiet_hours: {
                    from: components["schemas"]["__schema139"];
                    time_zone: string;
                    until: components["schemas"]["__schema139"];
                };
                settled: boolean;
                weekly_summary: boolean;
            };
        };
        __schema139: string;
        __schema140: {
            actor: string;
            artifacts: components["schemas"]["__schema144"][];
            correctiveJobId?: string | null;
            createdAt: components["schemas"]["__schema134"];
            expiresAt: components["schemas"]["__schema134"];
            failureClass: string | null;
            generationStartedAt: components["schemas"]["__schema134"] | null;
            generationState: string;
            id: components["schemas"]["__schema141"];
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
            receipts: components["schemas"]["__schema144"][];
            restricted: boolean;
            scope: components["schemas"]["__schema142"];
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
                /** @enum {string} */
                workspace?: "job" | "persistent";
            }[];
        };
        __schema141: string;
        __schema142: {
            app: components["schemas"]["__schema143"];
            app_version: components["schemas"]["__schema143"];
            /** @constant */
            audience: "private";
            /** @constant */
            role: "owner";
            task_family: components["schemas"]["__schema143"];
        };
        __schema143: string;
        __schema144: {
            [key: string]: unknown;
        };
        __schema145: {
            candidate: components["schemas"]["__schema146"];
        };
        __schema146: {
            body: string;
            bodyHash: string;
            canarySpaceId: string | null;
            /** @default {} */
            caseTemplates: {
                final_pool?: components["schemas"]["__schema161"][];
                validation?: components["schemas"]["__schema160"][];
            };
            change: components["schemas"]["__schema144"];
            /** @default [] */
            checks: ({
                kind: components["schemas"]["__schema150"];
                max?: components["schemas"]["__schema152"];
                min?: components["schemas"]["__schema151"];
            } | {
                kind: components["schemas"]["__schema153"];
                max?: components["schemas"]["__schema155"];
                min?: components["schemas"]["__schema154"];
            } | {
                kind: components["schemas"]["__schema156"];
                max?: components["schemas"]["__schema158"];
                min?: components["schemas"]["__schema157"];
            } | {
                /** @constant */
                kind: "required_phrase";
                phrase: components["schemas"]["__schema159"];
            } | {
                /** @constant */
                kind: "forbidden_phrase";
                phrase: components["schemas"]["__schema159"];
            } | {
                /** @enum {string} */
                form: "bullets" | "numbered" | "paragraphs" | "table" | "json";
                /** @constant */
                kind: "output_format";
            } | {
                headings: components["schemas"]["__schema159"][];
                /** @constant */
                kind: "required_sections";
                /** @default true */
                ordered: boolean;
            } | {
                /** @enum {string} */
                direction: "ascending" | "descending";
                key: components["schemas"]["__schema159"];
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
                action_kind: components["schemas"]["__schema159"];
                /** @constant */
                kind: "action_kind_absent";
            } | {
                action_kind: components["schemas"]["__schema159"];
                /** @constant */
                kind: "action_kind_max";
                max: number;
            } | {
                action_kind: components["schemas"]["__schema159"];
                /** @constant */
                kind: "action_kind_present";
                /** @default 1 */
                min: number;
            })[];
            compatibleModels: string[];
            createdAt: components["schemas"]["__schema134"];
            /** @default null */
            description: string | null;
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
            episodeId: components["schemas"]["__schema141"] | null;
            /** @default [] */
            evidence: components["schemas"]["__schema149"][];
            /** @default null */
            holdReason: string | null;
            id: components["schemas"]["__schema147"];
            knownRisk: string;
            /**
             * @default owner_correction
             * @enum {string}
             */
            origin: "owner_correction" | "engine_staged";
            /** @default null */
            pausedAt: components["schemas"]["__schema134"] | null;
            predictedBenefit: string;
            /**
             * @default {
             *       "scope": "private",
             *       "principal_id": null
             *     }
             */
            promotion: {
                approved_at?: components["schemas"]["__schema134"];
                /** @enum {string} */
                basis?: "evaluation" | "owner_trial" | "owner_confirmed" | "engine_live";
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
            /** @default null */
            removedAt: components["schemas"]["__schema134"] | null;
            scope: components["schemas"]["__schema142"];
            selectedEvaluationId: string | null;
            /** @default null */
            skillName: string | null;
            spaceId: string;
            state: components["schemas"]["__schema148"];
            tests: string[];
            /** @default [] */
            triggers: {
                evidence: components["schemas"]["__schema149"];
                phrase: string;
            }[];
            version: number;
        };
        __schema147: string;
        /** @enum {string} */
        __schema148: "candidate" | "evaluated" | "enabled_canary" | "active" | "superseded" | "reverted";
        __schema149: {
            end: number;
            /** @constant */
            fallback?: "verbatim";
            quote: string;
            /** @enum {string} */
            source: "intervention" | "objective";
            start: number;
        };
        /** @constant */
        __schema150: "word_count";
        __schema151: number;
        __schema152: number;
        /** @constant */
        __schema153: "char_count";
        __schema154: number;
        __schema155: number;
        /** @constant */
        __schema156: "line_count";
        __schema157: number;
        __schema158: number;
        __schema159: string;
        __schema160: string;
        __schema161: string;
        __schema162: {
            candidate: components["schemas"]["__schema146"];
            evaluations: {
                budget: components["schemas"]["__schema144"];
                createdAt: components["schemas"]["__schema134"];
                id: string;
                passed: boolean;
                phase: string;
                selectedAt: components["schemas"]["__schema134"] | null;
            }[];
            history: {
                actor: string;
                candidateId: components["schemas"]["__schema147"];
                createdAt: components["schemas"]["__schema134"];
                fromState: string | null;
                id: string;
                reason: string;
                toState: components["schemas"]["__schema148"];
            }[];
        };
        __schema163: {
            actions: ("try" | "pause" | "resume" | "remove" | "share" | "approve" | "edit" | "stop")[];
            applies_when: string[];
            definition_hash: string;
            does: string[];
            expires_at: components["schemas"]["__schema134"] | null;
            expiring_soon: boolean;
            id: string;
            learned_at: components["schemas"]["__schema134"];
            name: string;
            reason: string | null;
            reason_code: string | null;
            shared: boolean;
            source: components["schemas"]["__schema164"];
            space_id: string;
            /** @enum {string} */
            state: "proposed" | "trial" | "active" | "paused" | "reverted";
        };
        /** @enum {string} */
        __schema164: "correction" | "engine";
        __schema165: {
            /** @enum {string} */
            action: "pause" | "resume" | "remove" | "keep" | "decline";
            created_at: components["schemas"]["__schema134"];
            id: string;
            item_id: string;
            name: string;
            source: components["schemas"]["__schema164"];
        };
        __schema166: {
            change: components["schemas"]["__schema165"] | null;
            item: components["schemas"]["__schema163"] | null;
        };
        __schema167: {
            answer: ("yes" | "no" | "change") | null;
            created_at: components["schemas"]["__schema134"];
            id: components["schemas"]["__schema168"];
            item_id: string;
            job_id: string | null;
            /** @constant */
            kind: "keep_question";
            name: string;
            options: {
                /** @enum {string} */
                id: "yes" | "no" | "change";
                label: string;
            }[];
            /** @enum {string} */
            state: "open" | "answered" | "withdrawn";
            text: string;
        } | {
            created_at: components["schemas"]["__schema134"];
            id: components["schemas"]["__schema168"];
            item_id: string;
            job_id: string | null;
            /** @constant */
            kind: "reverted";
            name: string;
            reason_code: string;
            /** @enum {string} */
            state: "open" | "read";
            text: string;
        };
        __schema168: string;
        __schema169: {
            skills: components["schemas"]["__schema170"][];
        };
        __schema170: {
            body: string;
            created_at: components["schemas"]["__schema134"];
            definition_hash: string;
            description: string;
            id: components["schemas"]["__schema147"];
            name: string;
            reason: string | null;
            source_job_id: string | null;
            /** @enum {string} */
            state: "live" | "held" | "paused" | "rejected" | "reverted";
        };
        __schema171: {
            body_sha256: string | null;
            created_at: components["schemas"]["__schema134"];
            id: string;
            name: string;
            reason: string;
            source_skill_id: components["schemas"]["__schema147"] | null;
            space_id: string | null;
        };
        __schema172: {
            skill: components["schemas"]["__schema170"];
        };
        __schema173: string;
        __schema174: string;
        /** @enum {string} */
        __schema175: "personal" | "shared";
        /** @enum {string} */
        __schema176: "owner" | "space";
        __schema177: string | null;
        __schema178: string;
        __schema179: {
            generation: number;
            principal_id: string;
            revoked_at: components["schemas"]["__schema134"] | null;
            /** @enum {string} */
            role: "owner" | "member";
            space_id: string;
        };
        __schema180: string;
        __schema181: string;
        __schema182: string;
        /** @enum {string} */
        __schema183: "removed" | "emptied";
        /** @enum {string} */
        __schema184: "pending" | "running" | "blocked" | "cleaning" | "complete";
        /** @enum {string} */
        __schema185: "fence" | "sessions" | "journal" | "sandboxes" | "browser" | "runtime" | "files" | "operational" | "principals" | "memory" | "verify" | "space";
        __schema186: {
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
        __schema187: string | null;
        __schema188: components["schemas"]["__schema134"] | null;
        __schema189: string;
        __schema190: string;
        __schema191: {
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
        __schema192: {
            label: string;
            provider: string;
        }[];
        __schema193: string[];
        __schema194: string;
        __schema195: string;
        __schema196: string[];
        __schema197: string[];
        __schema198: {
            agent_id: components["schemas"]["__schema199"];
            composer: components["schemas"]["__schema202"];
            created_at: components["schemas"]["__schema203"];
            id: components["schemas"]["__schema199"];
            plan_id: components["schemas"]["__schema199"] | null;
            progress?: {
                current: string | null;
                steps_done: components["schemas"]["__schema204"];
            };
            status: components["schemas"]["__schema201"];
            title: components["schemas"]["__schema200"];
            updated_at: components["schemas"]["__schema203"];
        };
        __schema199: string;
        __schema200: string;
        /** @enum {string} */
        __schema201: "idle" | "queued" | "working" | "streaming" | "needs_you" | "paused" | "done" | "failed" | "stopped";
        /** @enum {string} */
        __schema202: "send" | "pause" | "resume" | "stop";
        /** Format: date-time */
        __schema203: string;
        __schema204: number;
        __schema205: {
            reason: components["schemas"]["__schema200"];
            /** @constant */
            status: "not_available";
        };
        __schema206: {
            conversation: components["schemas"]["__schema198"];
        };
        /** Format: uri */
        __schema207: string;
        __schema208: {
            detail: {
                id: components["schemas"]["__schema199"];
                /** @enum {string} */
                type: "artifact" | "permission" | "receipt" | "memory" | "page";
                url?: components["schemas"]["__schema207"];
            } | null;
            ended_at: components["schemas"]["__schema203"] | null;
            id: components["schemas"]["__schema199"];
            input_summary: components["schemas"]["__schema209"] | null;
            /** @enum {string} */
            kind: "connector" | "web" | "file" | "artifact" | "browser" | "sandbox" | "skill" | "memory_recall" | "memory_write" | "memory_correct" | "memory_forget" | "model" | "retry" | "tool";
            output_summary: components["schemas"]["__schema209"] | null;
            parent: components["schemas"]["__schema199"] | null;
            started_at: components["schemas"]["__schema203"];
            /** @enum {string} */
            status: "running" | "done" | "failed" | "needs_approval" | "unknown";
            title: string;
        };
        __schema209: {
            quote?: {
                /** @enum {string} */
                from: "page" | "message" | "file" | "event" | "app" | "request";
                text: string;
            };
            text: string;
        };
        __schema210: {
            facts: components["schemas"]["__schema211"][];
            id: components["schemas"]["__schema199"];
            image?: components["schemas"]["__schema207"];
            meta: string;
            primary_action: components["schemas"]["__schema212"] | null;
            secondary_actions: components["schemas"]["__schema212"][];
            source_connection: components["schemas"]["__schema199"] | null;
            title: components["schemas"]["__schema200"];
        };
        __schema211: {
            label: components["schemas"]["__schema200"];
            value: components["schemas"]["__schema200"];
        };
        __schema212: {
            handle: components["schemas"]["__schema199"];
            /** @enum {string} */
            kind: "open" | "download" | "send" | "undo";
            label: components["schemas"]["__schema200"];
            url?: components["schemas"]["__schema207"];
        };
        __schema213: {
            because?: components["schemas"]["__schema215"][];
            id: components["schemas"]["__schema199"];
            review?: components["schemas"]["__schema214"];
            undo?: {
                handle: components["schemas"]["__schema199"];
                valid_until: components["schemas"]["__schema203"];
            };
            what: components["schemas"]["__schema200"];
            when: components["schemas"]["__schema203"];
            where: components["schemas"]["__schema200"];
        };
        __schema214: {
            /** @enum {string} */
            by: "policy" | "reviewer";
            /** @enum {string} */
            outcome: "auto_approved" | "escalated";
            reason: components["schemas"]["__schema200"];
            reviewed_at: components["schemas"]["__schema203"];
            risk: ("low" | "medium" | "high") | null;
        };
        __schema215: {
            /** @enum {string} */
            basis: "declared" | "recalled" | "rule";
            id: components["schemas"]["__schema216"];
            /** @enum {string} */
            kind: "belief" | "rule";
            label: components["schemas"]["__schema217"];
        };
        __schema216: string;
        __schema217: string;
        __schema218: {
            because?: components["schemas"]["__schema215"][];
            conversation_id: components["schemas"]["__schema199"];
            created_at: components["schemas"]["__schema203"];
            draft?: components["schemas"]["__schema220"];
            id: components["schemas"]["__schema199"];
            options: components["schemas"]["__schema219"][];
            preview: components["schemas"]["__schema210"] | null;
            review?: components["schemas"]["__schema214"];
            version: components["schemas"]["__schema199"];
            what: components["schemas"]["__schema200"];
            why: components["schemas"]["__schema200"][];
        };
        /** @enum {string} */
        __schema219: "allow_once" | "always" | "deny";
        __schema220: {
            bcc?: components["schemas"]["__schema200"][];
            body: string;
            cc?: components["schemas"]["__schema200"][];
            /** @enum {string} */
            channel: "email" | "message";
            connection_id: components["schemas"]["__schema199"];
            id: components["schemas"]["__schema199"];
            recipient: components["schemas"]["__schema200"];
            /** @enum {string} */
            status: "draft" | "awaiting_permission" | "denied" | "sent" | "discarded";
            subject?: string;
        };
        __schema221: {
            conversation_id: components["schemas"]["__schema199"] | null;
            created_at: components["schemas"]["__schema203"];
            id: components["schemas"]["__schema199"];
            if_ignored: components["schemas"]["__schema200"];
            options: components["schemas"]["__schema222"];
            text: components["schemas"]["__schema200"];
            why: components["schemas"]["__schema200"][];
        };
        __schema222: components["schemas"]["__schema223"][];
        __schema223: {
            id: components["schemas"]["__schema199"];
            label: components["schemas"]["__schema200"];
        };
        __schema224: {
            command: string;
            exit_code: number | null;
            id: components["schemas"]["__schema199"];
            output: string;
            started_at: components["schemas"]["__schema203"];
            /** @enum {string} */
            status: "running" | "done" | "failed" | "unknown";
        };
        __schema225: {
            bounds: {
                count_cap: number;
                expires_at: components["schemas"]["__schema203"];
                reconsent_after_days: number;
            };
            connection_id: components["schemas"]["__schema199"];
            created_at: components["schemas"]["__schema203"];
            id: components["schemas"]["__schema199"];
            /** @enum {string} */
            kind: "send_message" | "create_event" | "change_event" | "delete_event" | "save_file" | "restore_file" | "discard_draft";
            recipient_class: components["schemas"]["__schema200"];
            text: components["schemas"]["__schema200"];
            used: components["schemas"]["__schema204"];
        };
        __schema226: {
            reviewer_available: boolean;
            settings: {
                classes: {
                    app_changes: boolean;
                    calendar: boolean;
                    sandbox: boolean;
                };
                /** @enum {string} */
                mode: "ask" | "auto_review";
            };
        };
        __schema227: {
            /** @constant */
            status: "ok";
        };
        __schema228: {
            allowed_connection_ids: components["schemas"]["__schema236"];
            asks_before_acting: components["schemas"]["__schema237"];
            colour: components["schemas"]["__schema231"];
            eye_colour: components["schemas"]["__schema233"];
            face_image?: components["schemas"]["__schema238"];
            id: components["schemas"]["__schema199"];
            name: components["schemas"]["__schema229"];
            role: components["schemas"]["__schema230"];
            space_id: components["schemas"]["__schema199"];
            standing_instruction: components["schemas"]["__schema235"];
            surface: components["schemas"]["__schema232"];
            tone: components["schemas"]["__schema234"];
            usage: {
                conversations: components["schemas"]["__schema204"];
                last_used: components["schemas"]["__schema203"] | null;
            };
        };
        __schema229: string;
        __schema230: string;
        __schema231: string;
        /** @enum {string} */
        __schema232: "rounded" | "blob" | "diamond" | "octagon" | "gear";
        __schema233: string;
        __schema234: string;
        __schema235: string;
        __schema236: components["schemas"]["__schema199"][] | null;
        __schema237: boolean;
        __schema238: components["schemas"]["__schema207"];
        __schema239: {
            agent: components["schemas"]["__schema228"];
        };
        __schema240: {
            created: components["schemas"]["__schema203"];
            editable: boolean;
            id: components["schemas"]["__schema199"];
            key: components["schemas"]["__schema200"];
            last_used: components["schemas"]["__schema203"] | null;
            saved_by?: string;
            /** @enum {string} */
            source: "onboarding" | "conversation" | "inferred";
            value: string;
            version: components["schemas"]["__schema199"];
        };
        __schema241: {
            capture: boolean;
        };
        __schema242: string;
        __schema243: {
            at: components["schemas"]["__schema244"];
            /** @enum {string} */
            kind: "setup" | "chat" | "correction" | "import" | "email" | "calendar" | "contacts" | "connected" | "receipt" | "message" | "document" | "assistant" | "worked_out";
            link: {
                id: components["schemas"]["__schema216"];
                /** @enum {string} */
                kind: "conversation" | "receipt";
                label: components["schemas"]["__schema217"];
            } | null;
            text: components["schemas"]["__schema217"];
        };
        /** Format: date-time */
        __schema244: string;
        __schema245: number;
        /** Format: date */
        __schema246: string;
        __schema247: {
            created_at: components["schemas"]["__schema244"];
            id: components["schemas"]["__schema216"];
            label: components["schemas"]["__schema217"];
            skipped: components["schemas"]["__schema217"][];
            steps: components["schemas"]["__schema248"][];
            undone_at: components["schemas"]["__schema244"] | null;
        };
        __schema248: {
            belief_id: components["schemas"]["__schema216"];
            from: components["schemas"]["__schema242"] | null;
            label: components["schemas"]["__schema217"];
            to: components["schemas"]["__schema242"] | null;
        };
        __schema249: {
            rewind: components["schemas"]["__schema247"];
        };
        __schema250: {
            category: components["schemas"]["__schema200"];
            conversation_ids: components["schemas"]["__schema199"][];
            file_ids: components["schemas"]["__schema199"][];
            id: components["schemas"]["__schema199"];
            milestones: {
                assignee: {
                    /** @constant */
                    kind: "person";
                } | {
                    agent_id: components["schemas"]["__schema199"];
                    /** @constant */
                    kind: "agent";
                };
                done: boolean;
                id: components["schemas"]["__schema199"];
                schedule_at?: components["schemas"]["__schema203"];
                status: components["schemas"]["__schema201"];
                title: components["schemas"]["__schema200"];
            }[];
            next_step: components["schemas"]["__schema200"] | null;
            progress_percent: number;
            title: components["schemas"]["__schema200"];
            updated_at: components["schemas"]["__schema203"];
        };
        __schema251: {
            plan: components["schemas"]["__schema250"];
        };
        __schema252: {
            profile: {
                day_hours: {
                    end: string;
                    start: string;
                };
                name: string;
                sending_address: string | null;
                time_zone: string;
            };
        };
        __schema253: {
            created_at: components["schemas"]["__schema203"];
            /** @default false */
            done: boolean;
            due_at: components["schemas"]["__schema203"] | null;
            id: components["schemas"]["__schema199"];
            title: components["schemas"]["__schema200"];
            updated_at: components["schemas"]["__schema203"];
        };
        __schema254: {
            task: components["schemas"]["__schema253"];
        };
        __schema255: {
            enabled: boolean;
            id: components["schemas"]["__schema199"];
            runs: {
                finished_at: components["schemas"]["__schema203"] | null;
                id: components["schemas"]["__schema199"];
                started_at: components["schemas"]["__schema203"];
                status: components["schemas"]["__schema201"];
            }[];
            schedule: components["schemas"]["__schema200"];
            title: components["schemas"]["__schema200"];
        };
        __schema256: {
            automation: components["schemas"]["__schema255"];
        };
        __schema257: {
            session: {
                id: components["schemas"]["__schema199"];
                preview_frame: components["schemas"]["__schema207"] | null;
                /** @enum {string} */
                status: "working" | "needs_you" | "done" | "stopped";
                task_label: components["schemas"]["__schema200"];
                url: components["schemas"]["__schema207"];
            };
        };
        __schema258: {
            error?: components["schemas"]["__schema137"];
            job: components["schemas"]["__schema259"] | null;
            receipt: components["schemas"]["__schema281"];
        };
        __schema259: {
            /** @enum {string} */
            attention_status: "normal" | "frequency_reduced" | "needs_attention";
            budget: components["schemas"]["__schema270"];
            cadence_multiplier: number;
            constraints: components["schemas"]["__schema265"];
            created_at: components["schemas"]["__schema134"];
            created_by: components["schemas"]["__schema271"];
            /** @default [] */
            deferred_questions: {
                because: components["schemas"]["__schema275"];
                blocks_external_effect: components["schemas"]["__schema278"];
                created_at: components["schemas"]["__schema134"];
                deadline_at: components["schemas"]["__schema279"];
                if_ignored: components["schemas"]["__schema277"];
                options?: components["schemas"]["__schema280"];
                text: components["schemas"]["__schema274"];
            }[];
            id: components["schemas"]["__schema260"];
            /** @enum {string} */
            importance: "routine" | "important";
            lease_epoch: components["schemas"]["__schema267"];
            next_wake_at: components["schemas"]["__schema268"];
            objective: components["schemas"]["__schema264"];
            principal_id?: components["schemas"]["__schema262"];
            revision: components["schemas"]["__schema266"];
            /** @enum {string} */
            scheduling_class: "interactive" | "background" | "quiet";
            space_id: components["schemas"]["__schema261"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema272"];
            substrate_disposition: components["schemas"]["__schema273"];
            title: components["schemas"]["__schema263"];
            unread_results: number;
            unread_threshold: number;
            updated_at: components["schemas"]["__schema134"];
            visible_status: components["schemas"]["JobState"] | ("frequency_reduced" | "needs_attention");
            wait: components["schemas"]["__schema269"];
        };
        __schema260: string;
        __schema261: string;
        __schema262: string | null;
        __schema263: string;
        __schema264: string;
        __schema265: {
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
        __schema266: number;
        __schema267: number;
        __schema268: components["schemas"]["__schema134"] | null;
        __schema269: {
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
            wake_at: components["schemas"]["__schema134"];
        } | {
            deadline_at: components["schemas"]["__schema134"] | null;
            /** @constant */
            kind: "event";
            trigger_id: string;
        };
        __schema270: {
            max_actions: number;
            max_attempts: number;
            max_input_tokens?: number;
            max_output_tokens: number;
            max_turns: number;
            max_usd_est: number;
            max_wall_ms: number;
        };
        /** @enum {string} */
        __schema271: "owner" | "trigger" | "system";
        __schema272: number;
        /** @enum {string} */
        __schema273: "remote_recoverable" | "timer_or_event" | "local_process_interrupted" | "external_uncertain";
        __schema274: string;
        __schema275: components["schemas"]["__schema276"][];
        __schema276: string;
        __schema277: string;
        /** @default false */
        __schema278: boolean;
        /** @default null */
        __schema279: components["schemas"]["__schema134"] | null;
        __schema280: components["schemas"]["__schema222"];
        __schema281: {
            event_cursor: number | null;
            input_digest: components["schemas"]["__schema283"] | null;
            job_id: string | null;
            job_revision: number | null;
            /** @enum {string} */
            state: "accepted" | "rejected" | "unknown_durability";
            submission_id: components["schemas"]["__schema282"];
        };
        __schema282: string;
        __schema283: string;
        __schema284: {
            answer: string | null;
            answered_at: components["schemas"]["__schema134"] | null;
            attempt_id: string | null;
            because: components["schemas"]["__schema275"];
            blocks_external_effect: components["schemas"]["__schema278"];
            created_at: components["schemas"]["__schema134"];
            deadline_at: components["schemas"]["__schema279"];
            id: string;
            if_ignored: components["schemas"]["__schema277"];
            job_id: string | null;
            job_title: string | null;
            key: string | null;
            options?: components["schemas"]["__schema280"];
            /** @enum {string} */
            source: "job" | "memory";
            space_id: string | null;
            /** @enum {string} */
            state: "open" | "answered" | "withdrawn";
            text: components["schemas"]["__schema274"];
        };
        __schema285: {
            actions: {
                dispatched_at: components["schemas"]["__schema134"] | null;
                id: string;
                job_id: string;
                receipt: components["schemas"]["__schema286"] | null;
                status: string;
            }[];
            cursor: number;
            epoch: number | null;
            jobs: components["schemas"]["__schema259"][];
        };
        __schema286: {
            [key: string]: components["schemas"]["__schema287"];
        };
        __schema287: (string | number | boolean | null) | components["schemas"]["__schema287"][] | {
            [key: string]: components["schemas"]["__schema287"];
        };
        __schema288: {
            due_at: components["schemas"]["__schema134"];
            id: string;
            job_id: string;
            /** @enum {string} */
            kind: "timer" | "remote_task" | "local_process";
            operation_key: components["schemas"]["__schema282"];
            remote_ref: string | null;
            result: components["schemas"]["__schema286"] | null;
            /** @enum {string} */
            state: "registered" | "ready" | "claimed" | "settled" | "interrupted" | "unknown";
            substrate_disposition: components["schemas"]["__schema273"];
            version: number;
        };
        __schema289: {
            acknowledged_at: components["schemas"]["__schema134"] | null;
            coalesce_key: string;
            created_at: components["schemas"]["__schema134"];
            fulfilled_at: components["schemas"]["__schema134"] | null;
            id: string;
            job_id: string | null;
            /** @enum {string} */
            kind: "direct" | "quiet";
            message: string | null;
            /** @enum {string} */
            state: "owed" | "acknowledged" | "fulfilled" | "needs_retransmission";
            submission_id: components["schemas"]["__schema282"];
        };
        __schema290: {
            attempted_at: components["schemas"]["__schema134"] | null;
            because: components["schemas"]["__schema276"][];
            coalesce_key: string;
            content: {
                attempt_id: string;
                job_id: string;
                /** @enum {string} */
                kind: "answer" | "question" | "status";
                text: string;
            } | null;
            content_hash: components["schemas"]["__schema283"];
            created_at: components["schemas"]["__schema134"];
            delivered_at: components["schemas"]["__schema134"] | null;
            delivery_attempt: number;
            delivery_key: string;
            id: string;
            if_ignored: components["schemas"]["__schema277"];
            obligation_ids: string[];
            /** @enum {string} */
            state: "pending" | "attempted" | "delivered" | "superseded";
        };
        __schema291: {
            audience: components["schemas"]["__schema295"];
            /**
             * @default owner
             * @enum {string}
             */
            author: "owner" | "external";
            content_ref: string | null;
            eligibility_generation: components["schemas"]["__schema296"];
            event_at: components["schemas"]["__schema134"];
            ingested_at: components["schemas"]["__schema134"];
            origin_trust: components["schemas"]["__schema297"];
            owner_id: string;
            publisher: components["schemas"]["__schema293"];
            source_id: components["schemas"]["__schema292"];
            source_identity: components["schemas"]["__schema293"];
            /** @enum {string} */
            source_type: "message" | "document" | "observation" | "receipt" | "assistant" | "owner_edit";
            source_version: components["schemas"]["__schema293"];
            space_id: string;
            /** @enum {string} */
            state: "active" | "suppressed" | "deleted" | "revoked";
            stream: components["schemas"]["__schema293"];
            stream_sequence: components["schemas"]["__schema294"];
        };
        __schema292: string;
        __schema293: string;
        __schema294: number;
        /** @enum {string} */
        __schema295: "private" | "space" | "public";
        __schema296: number;
        /** @enum {string} */
        __schema297: "owner" | "verified_connector" | "external_content" | "inferred" | "unknown";
        __schema298: {
            access_generation: components["schemas"]["__schema296"];
            data_revision: components["schemas"]["__schema296"];
            eligibility_generation: components["schemas"]["__schema296"];
            policy_generation: components["schemas"]["__schema296"];
            restore_ready: boolean;
            space_id: string;
        };
        __schema299: string;
        __schema300: string;
        __schema301: string;
        /** @enum {string} */
        __schema302: "user_statement" | "document_assertion" | "checked_fact" | "inferred" | "preference" | "exception" | "historical";
        /** @enum {string} */
        __schema303: "attributed" | "checked" | "tentative" | "disputed";
        /** @enum {string} */
        __schema304: "active" | "superseded" | "historical" | "retracted" | "disputed";
        __schema305: {
            end: components["schemas"]["__schema294"];
            source_id: components["schemas"]["__schema292"];
            source_version: components["schemas"]["__schema293"];
            start: components["schemas"]["__schema296"];
        };
        __schema306: {
            claim_id: components["schemas"]["__schema299"];
            content: string | null;
            data_revision: components["schemas"]["__schema294"];
            factual_status: components["schemas"]["__schema303"];
            kind: components["schemas"]["__schema302"];
            /** @default inferred */
            origin_trust: components["schemas"]["__schema297"];
            protected: boolean;
            recorded_at: components["schemas"]["__schema134"];
            revision: components["schemas"]["__schema294"];
            sources: components["schemas"]["__schema305"][];
            status: components["schemas"]["__schema304"];
            superseded_at: components["schemas"]["__schema134"] | null;
            valid_from: components["schemas"]["__schema134"];
            valid_until: components["schemas"]["__schema134"] | null;
        };
        __schema307: {
            /** @enum {string} */
            cleanup: "pending" | "complete";
            generation: components["schemas"]["__schema298"];
        };
        __schema308: string;
        /** @default null */
        __schema309: components["schemas"]["__schema301"] | null;
        __schema310: boolean;
        __schema311: string;
        __schema312: string;
        __schema313: {
            field: string;
            handle: components["schemas"]["__schema300"];
            key: components["schemas"]["__schema301"] | null;
            /** @enum {string} */
            kind: "recipient" | "date" | "amount" | "identifier";
            value: string;
        };
        __schema314: {
            description: string;
            field: string;
            handle: (components["schemas"]["__schema300"] | string) | null;
            origin_trust: components["schemas"]["__schema297"];
            value: string;
        };
        __schema315: string;
        __schema316: string;
        __schema317: {
            /** @enum {string} */
            kind: "artifact" | "plan_step" | "action";
            location: string | null;
            output_id: components["schemas"]["__schema311"];
            output_version: components["schemas"]["__schema311"];
        };
        __schema318: {
            diff: string;
            id: components["schemas"]["__schema293"];
            path: string;
            /** @enum {string} */
            status: "pending" | "applied" | "discarded";
        };
        __schema319: {
            owner: {
                created_at: components["schemas"]["__schema134"];
                /** Format: email */
                email: string;
                id: string;
            };
        };
        __schema320: {
            spaces: components["schemas"]["Space"][];
        };
        __schema321: {
            job: components["schemas"]["Job"];
        };
        __schema322: {
            field: string;
            /** @enum {string} */
            op: "eq" | "contains" | "matches" | "lt" | "gt" | "changed";
            /** @default null */
            value: string | number | boolean | null;
        };
        __schema323: {
            /** @enum {string} */
            by: "person" | "assistant";
            created_at: components["schemas"]["__schema134"];
            emoji: string;
            job_id: string | null;
            message_id: string;
            seq: number;
        };
        __schema324: {
            reactions: components["schemas"]["__schema323"][];
        };
        __schema325: string;
        __schema326: string;
        __schema327: number;
        __schema328: string;
        __schema329: string;
        __schema330: string;
        __schema331: string | null;
        __schema332: {
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
        __schema333: components["schemas"]["__schema134"] | null;
        __schema334: ("completed" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "failed" | "budget_exhausted" | "fenced" | "unknown_check") | null;
        __schema335: components["schemas"]["__schema286"] | null;
        __schema336: string | null;
        __schema337: {
            events: components["schemas"]["Event"][];
            has_more: boolean;
            next_cursor: number;
        };
        __schema338: number;
        __schema339: string | null;
        __schema340: string | null;
        /** @enum {string} */
        __schema341: "job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error";
        __schema342: string;
        __schema343: string;
        __schema344: string;
        /** @enum {string} */
        __schema345: "completed" | "parked_until_retry" | "needs_reconciliation" | "needs_reconnect" | "needs_input" | "repair_exhausted";
        __schema346: {
            [key: string]: number;
        };
        __schema347: {
            at: components["schemas"]["__schema134"];
            attempt: number;
            /** @default null */
            candidate_id: string | null;
            /** @enum {string} */
            decision: "verified_completion" | "retry_with_backoff" | "park_until_retry_after" | "refresh_credential_once" | "stop_connection_revoked" | "rediscover_schema" | "record_repair_candidate" | "apply_safe_mapping" | "change_route" | "reconcile_by_verify" | "revise_and_revalidate" | "stop_needs_input" | "escalate_diagnosis";
            /** @default null */
            delay_ms: number | null;
            detail: string;
            /** @default null */
            fault_kind: components["schemas"]["__schema348"] | null;
            payload_hash: components["schemas"]["__schema343"];
            /** @default null */
            retry_after: components["schemas"]["__schema134"] | null;
            /** @default null */
            route: string | null;
        }[];
        /** @enum {string} */
        __schema348: "transient_before_dispatch" | "rate_limited" | "expired_credential" | "revoked_credential" | "schema_drift" | "unsupported_route" | "uncertain_outcome" | "bad_output" | "unclassified";
        __schema349: string;
        __schema350: string;
        __schema351: string;
        __schema352: string;
        __schema353: string;
        /** @default null */
        __schema354: components["schemas"]["__schema344"] | null;
        __schema355: string | null;
        __schema356: string | null;
        __schema357: string;
        __schema358: components["schemas"]["__schema134"] | null;
        __schema359: components["schemas"]["__schema286"] | null;
        __schema360: components["schemas"]["__schema134"] | null;
        __schema361: components["schemas"]["__schema286"] | null;
        /** @default [] */
        __schema362: components["schemas"]["__schema347"];
        /** @default {} */
        __schema363: components["schemas"]["__schema346"];
        /** @default null */
        __schema364: components["schemas"]["__schema345"] | null;
        /** @default null */
        __schema365: components["schemas"]["__schema134"] | null;
        __schema366: {
            action: components["schemas"]["Action"];
        };
        __schema367: string;
        __schema368: string;
        /** @enum {string} */
        __schema369: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp" | "sandbox";
        __schema370: string;
        __schema371: string[];
        /** @enum {string} */
        __schema372: "active" | "disabled" | "error" | "revoked";
        /** @enum {string} */
        __schema373: "unknown" | "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema374: "available" | "connecting" | "connected" | "error";
        __schema375: number;
        __schema376: boolean;
        __schema377: string[];
        __schema378: components["schemas"]["__schema134"] | null;
        __schema379: {
            check?: components["schemas"]["ConnectionCheck"];
            connection: components["schemas"]["Connection"];
        };
        /** @enum {string} */
        __schema380: "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema381: "ok" | "degraded" | "unavailable" | "credential_refused" | "sign_in_required" | "not_running" | "revoked";
        __schema382: string;
        __schema383: string;
        __schema384: string;
        __schema385: string;
        __schema386: string;
        __schema387: {
            help?: string;
            label: string;
            list: boolean;
            name: string;
            placeholder?: string;
            required: boolean;
            secret: boolean;
        }[];
        __schema388: {
            asks_first: boolean;
            effect_class: components["schemas"]["EffectClass"];
            label: string;
        }[];
        __schema389: string | null;
        __schema390: {
            label?: string;
            scope: string;
        };
        __schema391: {
            authorization_servers: string[];
            bearer_methods_supported: string[];
            /** Format: uri */
            resource: string;
            resource_name: string;
            scopes_supported: string[];
        };
        __schema392: {
            error: string;
            error_description?: string;
        };
        __schema393: {
            error?: {
                code: number;
                message: string;
            };
            id: string | number | null;
            /** @constant */
            jsonrpc: "2.0";
            result?: unknown;
        };
        __schema394: {
            available: boolean;
            redirect_uri: string | null;
        };
        __schema395: {
            /** Format: uri */
            authorize_url: string;
            expires_at: components["schemas"]["__schema134"];
            /** Format: uri */
            issuer: string;
            /** Format: uri */
            redirect_uri: string;
            scopes: components["schemas"]["__schema390"][];
            sign_in_id: string;
        };
        __schema396: {
            expires_at: components["schemas"]["__schema134"];
            /** @constant */
            state: "pending";
        } | {
            connection_ids: string[];
            /** @constant */
            state: "connected";
        } | {
            error: string;
            /** @constant */
            state: "failed";
        };
        __schema397: string;
        /** @enum {string} */
        __schema398: "mail" | "caldav" | "ics" | "mcp" | "mcp_stdio" | "sandbox";
        __schema399: string;
        __schema400: string;
        __schema401: {
            path: string;
            value: components["schemas"]["__schema402"];
        }[];
        __schema402: string | number | boolean;
        __schema403: components["schemas"]["ConnectionFormField"][];
        __schema404: string;
        __schema405: string;
        __schema406: string;
        __schema407: boolean;
        __schema408: boolean;
        __schema409: string;
        __schema410: components["schemas"]["__schema402"];
        __schema411: {
            label: string;
            value: string;
        }[];
        __schema412: components["schemas"]["__schema413"] | "list";
        /** @enum {string} */
        __schema413: "text" | "email" | "url" | "number" | "password" | "checkbox" | "select" | "string_list";
        __schema414: {
            default?: components["schemas"]["__schema410"];
            help?: components["schemas"]["__schema406"];
            input: components["schemas"]["__schema413"];
            label: components["schemas"]["__schema405"];
            options?: components["schemas"]["__schema411"];
            path: components["schemas"]["__schema404"];
            placeholder?: components["schemas"]["__schema409"];
            required: components["schemas"]["__schema407"];
            secret: components["schemas"]["__schema408"];
        }[];
        __schema415: {
            asks_first: boolean;
            default: boolean;
            effect_class: components["schemas"]["EffectClass"];
            label: string;
            scope: string;
        }[];
        __schema416: string;
        __schema417: string;
        __schema418: string;
        __schema419: ("mail" | "calendar" | "tools" | "execution")[];
        __schema420: {
            /** Format: uri */
            issuer: string;
            /** @constant */
            method: "sign_in";
            /** @enum {string} */
            provider: "google" | "microsoft";
            scopes: components["schemas"]["__schema390"][];
            start: string;
        } | {
            /** @constant */
            method: "mcp_sign_in";
            start: string;
            suggested_id: string;
            /** Format: uri */
            url: string;
        } | {
            kind_id: string;
            /** @constant */
            method: "form";
        };
        __schema421: boolean;
        __schema422: string;
        __schema423: string;
        __schema424: string;
        /** @enum {string} */
        __schema425: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema426: "active" | "superseded" | "retracted" | "disputed";
        __schema427: {
            body: string;
            frontmatter: components["schemas"]["KnowledgeFrontmatterOutput"];
            id: string;
            path: string;
        };
        __schema428: string;
        __schema429: string;
        __schema430: string;
        /** @enum {string} */
        __schema431: "private" | "space" | "public";
        /** @enum {string} */
        __schema432: "high" | "medium" | "low";
        /** @enum {string} */
        __schema433: "user" | "agent" | "document" | "tool";
        __schema434: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote: string;
            ref: string;
            /** @default null */
            sha256: string | null;
        };
        /** Format: date */
        __schema435: string;
        /** @default null */
        __schema436: components["schemas"]["__schema435"] | null;
        /** @default [] */
        __schema437: components["schemas"]["__schema428"][];
        /** @default null */
        __schema438: components["schemas"]["__schema428"] | null;
        /** @default [] */
        __schema439: string[];
        /** @default [] */
        __schema440: components["schemas"]["__schema428"][];
        /** @constant */
        __schema441: 1;
        __schema442: string;
        __schema443: string;
        __schema444: number;
        /** @enum {string} */
        __schema445: "automation" | "human";
        /** @constant */
        __schema446: true;
        __schema447: components["schemas"]["BrowserSite"][];
        __schema448: string;
        __schema449: string;
        __schema450: string;
        __schema451: string;
        /** @constant */
        __schema452: true;
        __schema453: string;
        __schema454: number;
        __schema455: {
            /** @constant */
            height: 768;
            /** @constant */
            width: 1024;
        };
        __schema456: components["schemas"]["__schema457"][];
        __schema457: string;
        __schema458: string;
        __schema459: number;
        __schema460: components["schemas"]["__schema461"][];
        __schema461: string;
        /** @constant */
        __schema462: true;
        __schema463: string;
        __schema464: {
            /** @default null */
            currency: components["schemas"]["__schema466"] | null;
            domain: string;
            first_seen_at: components["schemas"]["__schema134"];
            id: string;
            last_seen_at: components["schemas"]["__schema134"];
            message_count: number;
            /** @default null */
            monthly_spend_minor: components["schemas"]["__schema465"] | null;
            name: string;
            space_id: string;
        };
        __schema465: number;
        __schema466: string;
        __schema467: {
            /** @default null */
            amount_minor: components["schemas"]["__schema465"] | null;
            company_id: string;
            confidence: components["schemas"]["__schema432"];
            /** @default null */
            currency: components["schemas"]["__schema466"] | null;
            /** @enum {string} */
            direction: "owed_to_you" | "you_pay" | "you_owe" | "info";
            /** @default null */
            due_at: components["schemas"]["__schema134"] | null;
            due_date_only?: boolean;
            evidence: components["schemas"]["__schema469"][];
            id: string;
            /** @default null */
            job_id: string | null;
            /** @enum {string} */
            kind: "refund_owed" | "wrong_charge" | "subscription" | "price_rise" | "renewal" | "trial_ending" | "invoice_unpaid" | "compensation" | "warranty" | "deposit" | "data_held" | "promise";
            principal_id: string;
            space_id: string;
            status: components["schemas"]["__schema468"];
            /** @default null */
            suggested_playbook: string | null;
            summary: string;
        };
        /** @enum {string} */
        __schema468: "found" | "handling" | "waiting" | "settled" | "dropped";
        __schema469: {
            end: number;
            message_id: string;
            quote: string;
            start: number;
        };
        __schema470: {
            amount_minor: components["schemas"]["__schema465"] | null;
            currency: components["schemas"]["__schema466"] | null;
            due_at: components["schemas"]["__schema134"] | null;
            id: string;
            job_id: string | null;
            /** @enum {string} */
            kind: "owed" | "reply";
            sent_at: components["schemas"]["__schema134"] | null;
            status: components["schemas"]["__schema468"];
            what: string;
            who: string;
        };
        __schema471: {
            report: components["schemas"]["FeedbackReport"];
        };
        /**
         * @description A short report id, such as FB-7K3Q
         * @example FB-7K3Q
         */
        __schema472: string;
        __schema473: string;
        __schema474: string;
        __schema475: string | null;
        __schema476: string;
        __schema477: string;
        __schema478: string;
        __schema479: string;
        __schema480: string;
        __schema481: {
            height: number;
            pixel_ratio?: number;
            width: number;
        };
        /** @enum {string} */
        __schema482: "light" | "dark";
        __schema483: components["schemas"]["__schema484"][];
        __schema484: {
            at: components["schemas"]["__schema134"];
            message: string;
        };
        __schema485: components["schemas"]["__schema486"][];
        __schema486: {
            at: components["schemas"]["__schema134"];
            code: string | null;
            method: string;
            status: number | null;
            url: string;
        };
        __schema487: {
            email: string | null;
            principal_id: string | null;
        };
        __schema488: string | null;
        __schema489: {
            active: {
                /** @description The active provider has a credential */
                connected: boolean;
                model: string;
                provider: string;
                /**
                 * @description `app`: chosen in Settings, and used until it is cleared. `operator`: the server’s MELETE_DEFAULT_PROVIDER and MELETE_DEFAULT_MODEL, used while nothing is chosen in the app.
                 * @enum {string}
                 */
                source: "app" | "operator";
                updated_at: components["schemas"]["__schema134"] | null;
            };
            /** @description Whether this account may change keys and the model (the owner) */
            can_edit: boolean;
            /** @description False when MELETE_MASTER_KEY is unset, so no key can be sealed */
            can_store_keys: boolean;
            operator_default: {
                model: string;
                provider: string;
            };
            providers: {
                /** @description The OpenAI-compatible endpoint’s version prefix; null for the rest */
                base_url: components["schemas"]["__schema491"] | null;
                base_url_source: ("app" | "operator") | null;
                /** @description A key is set or the owner is signed in, so a model call has a credential. It is not a promise that the provider accepts it; test the connection for that. */
                connected: boolean;
                key: {
                    /** @description The last four characters of a key entered in the app */
                    last_four: components["schemas"]["__schema490"] | null;
                    /**
                     * @description `set`: entered in the app and stored sealed. `operator`: the server environment names a key for this provider; it is used, cannot be changed here, and is never shown.
                     * @enum {string}
                     */
                    state: "unset" | "set" | "operator";
                    updated_at: components["schemas"]["__schema134"] | null;
                };
                label: string;
                /** @description Whether a successful test returns the provider’s model list */
                lists_models: boolean;
                /** @enum {string} */
                method: "key" | "sign_in";
                /** @enum {string} */
                provider: "anthropic" | "openai" | "google" | "fireworks" | "openai-compatible" | "chatgpt";
            }[];
        };
        __schema490: string;
        __schema491: string;
        __schema492: string;
        __schema493: number;
        __schema494: {
            /** @description The signed-in account, when the provider names one */
            account: components["schemas"]["__schema495"] | null;
            /** @description When the current access token expires. The gateway refreshes before then. */
            expires_at: components["schemas"]["__schema134"] | null;
            /** @description The provider as the person knows it, for a "Sign in with" button */
            label: string;
            /** @description What happened and what to do, in plain words, whenever the person has something to do; null when signed in or signed out. */
            message: components["schemas"]["__schema497"] | null;
            methods: ("device" | "browser")[];
            /** @enum {string} */
            provider: "chatgpt" | "openai-compatible";
            /** @description Why a new sign-in is needed */
            reason: components["schemas"]["__schema496"] | null;
            /**
             * @description `sign_in_required` means the provider refused a refresh; model calls to it are refused with `provider_sign_in_required` until the owner signs in again.
             * @enum {string}
             */
            state: "signed_out" | "pending" | "signed_in" | "sign_in_required";
        };
        __schema495: string;
        /** @enum {string} */
        __schema496: "refresh_expired" | "refresh_reused" | "refresh_revoked" | "refresh_refused" | "access_expired";
        __schema497: string;
        __schema498: string;
        __schema499: number;
        __schema500: string;
        __schema501: string;
        /** @enum {string} */
        __schema502: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema503: string | null;
        __schema504: {
            captured_at: components["schemas"]["__schema134"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema505: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema506: string | null;
        __schema507: {
            compression_count?: number;
            in_place?: boolean;
            used_fallback?: boolean;
        };
        __schema508: string;
        Action: {
            attempt_id: components["schemas"]["__schema351"];
            authorization_ref: components["schemas"]["__schema355"];
            budget_reservation: components["schemas"]["__schema356"];
            canonical_payload: components["schemas"]["__schema286"];
            connection_id: components["schemas"]["__schema352"];
            created_at: components["schemas"]["__schema134"];
            dispatched_at: components["schemas"]["__schema358"];
            effect_class: components["schemas"]["EffectClass"];
            id: components["schemas"]["__schema349"];
            idempotency_key: components["schemas"]["__schema357"];
            intent_key: components["schemas"]["__schema354"];
            job_id: components["schemas"]["__schema350"];
            kind: components["schemas"]["__schema353"];
            payload_hash: components["schemas"]["__schema343"];
            receipt: components["schemas"]["__schema359"];
            reconciliation: components["schemas"]["__schema361"];
            repair_counters: components["schemas"]["__schema363"];
            repair_disposition: components["schemas"]["__schema364"];
            repair_trace: components["schemas"]["__schema362"];
            resolved_at: components["schemas"]["__schema360"];
            retry_after_at: components["schemas"]["__schema365"];
            status: components["schemas"]["ActionStatus"];
        };
        /** @enum {string} */
        ActionStatus: "proposed" | "needs_approval" | "approved" | "denied" | "admitted" | "dispatched" | "succeeded" | "failed" | "unknown" | "unresolved";
        Attempt: {
            context_snapshot_ref: components["schemas"]["__schema336"];
            ended_at: components["schemas"]["__schema333"];
            epoch: components["schemas"]["__schema327"];
            id: components["schemas"]["__schema325"];
            job_id: components["schemas"]["__schema326"];
            model: components["schemas"]["__schema330"];
            model_actual: components["schemas"]["__schema331"];
            outcome: components["schemas"]["__schema334"];
            outcome_detail: components["schemas"]["__schema335"];
            provider: components["schemas"]["__schema329"];
            runtime_version: components["schemas"]["__schema328"];
            started_at: components["schemas"]["__schema134"];
            usage: components["schemas"]["__schema332"];
        };
        BrowserControlResponse: {
            control: components["schemas"]["__schema445"];
            control_epoch: components["schemas"]["__schema444"];
            fresh_observation_required: components["schemas"]["__schema446"];
            session_id: components["schemas"]["__schema443"];
        };
        BrowserSite: {
            domain: components["schemas"]["__schema448"];
            label: components["schemas"]["__schema449"];
            last_used: components["schemas"]["__schema450"];
        };
        BrowserSiteForgotten: {
            domain: components["schemas"]["__schema451"];
            forgotten: components["schemas"]["__schema452"];
        };
        BrowserSiteList: {
            sites: components["schemas"]["__schema447"];
        };
        Connection: {
            builtin?: components["schemas"]["__schema376"];
            created_at: components["schemas"]["__schema134"];
            generation?: components["schemas"]["__schema375"];
            health: components["schemas"]["__schema373"];
            id: components["schemas"]["__schema367"];
            label: components["schemas"]["__schema370"];
            last_checked_at: components["schemas"]["__schema378"];
            needs_scope?: components["schemas"]["__schema377"];
            provider: components["schemas"]["__schema369"];
            scopes: components["schemas"]["__schema371"];
            setup_state?: components["schemas"]["__schema374"];
            space_id: components["schemas"]["__schema368"];
            status: components["schemas"]["__schema372"];
        };
        ConnectionCatalogEntry: {
            available: components["schemas"]["__schema421"];
            connect: components["schemas"]["__schema420"];
            covers: components["schemas"]["__schema419"];
            description: components["schemas"]["__schema418"];
            id: components["schemas"]["__schema416"];
            setup_hint?: components["schemas"]["__schema423"];
            title: components["schemas"]["__schema417"];
            unavailable_reason?: components["schemas"]["__schema422"];
            warning?: components["schemas"]["__schema424"];
        };
        ConnectionCheck: {
            checked_at: components["schemas"]["__schema134"];
            code: components["schemas"]["__schema381"];
            detail: components["schemas"]["__schema382"];
            status: components["schemas"]["__schema380"];
        };
        ConnectionFormField: {
            default?: components["schemas"]["__schema410"];
            help?: components["schemas"]["__schema406"];
            input: components["schemas"]["__schema412"];
            item_fields?: components["schemas"]["__schema414"];
            label: components["schemas"]["__schema405"];
            options?: components["schemas"]["__schema411"];
            path: components["schemas"]["__schema404"];
            placeholder?: components["schemas"]["__schema409"];
            required: components["schemas"]["__schema407"];
            secret: components["schemas"]["__schema408"];
        };
        ConnectionKind: {
            description: components["schemas"]["__schema400"];
            fields: components["schemas"]["__schema403"];
            fixed: components["schemas"]["__schema401"];
            id: components["schemas"]["__schema397"];
            kind: components["schemas"]["__schema398"];
            scopes: components["schemas"]["__schema415"];
            title: components["schemas"]["__schema399"];
        };
        /** @enum {string} */
        EffectClass: "read" | "write_reversible" | "write_external" | "spend";
        Event: {
            attempt_id: components["schemas"]["__schema340"];
            created_at: components["schemas"]["__schema134"];
            dedup_key: components["schemas"]["__schema342"];
            job_id: components["schemas"]["__schema339"];
            payload: components["schemas"]["__schema286"];
            seq: components["schemas"]["__schema338"];
            type: components["schemas"]["__schema341"];
        };
        FeedbackContext: {
            color_scheme?: components["schemas"]["__schema111"];
            console_errors?: components["schemas"]["__schema112"];
            failed_requests?: components["schemas"]["__schema114"];
            language?: components["schemas"]["__schema108"];
            route?: components["schemas"]["__schema106"];
            time_zone?: components["schemas"]["__schema109"];
            user_agent?: components["schemas"]["__schema107"];
            viewport?: components["schemas"]["__schema110"];
        };
        FeedbackContextOutput: {
            color_scheme?: components["schemas"]["__schema482"];
            console_errors?: components["schemas"]["__schema483"];
            failed_requests?: components["schemas"]["__schema485"];
            language?: components["schemas"]["__schema479"];
            route?: components["schemas"]["__schema477"];
            time_zone?: components["schemas"]["__schema480"];
            user_agent?: components["schemas"]["__schema478"];
            viewport?: components["schemas"]["__schema481"];
        };
        FeedbackReport: {
            app_version: components["schemas"]["__schema476"];
            context: components["schemas"]["FeedbackContextOutput"];
            created_at: components["schemas"]["__schema134"];
            id: components["schemas"]["__schema472"];
            message: components["schemas"]["__schema473"];
            note: components["schemas"]["__schema488"];
            reporter: components["schemas"]["__schema487"];
            route: components["schemas"]["__schema475"];
            status: components["schemas"]["FeedbackStatus"];
            summary: components["schemas"]["__schema474"];
            updated_at: components["schemas"]["__schema134"];
        };
        /** @enum {string} */
        FeedbackStatus: "open" | "fixing" | "fixed" | "wontfix";
        HookObservation: {
            capture_id: components["schemas"]["__schema501"];
            detail?: components["schemas"]["__schema507"];
            name: components["schemas"]["__schema502"];
            outcome: components["schemas"]["__schema505"];
            redacted_args_digest: components["schemas"]["__schema506"];
            timing: components["schemas"]["__schema504"];
            tool_name: components["schemas"]["__schema503"];
        };
        Job: {
            budget: components["schemas"]["__schema270"];
            constraints: components["schemas"]["__schema265"];
            created_at: components["schemas"]["__schema134"];
            created_by: components["schemas"]["__schema271"];
            id: components["schemas"]["__schema260"];
            lease_epoch: components["schemas"]["__schema267"];
            next_wake_at: components["schemas"]["__schema268"];
            objective: components["schemas"]["__schema264"];
            principal_id?: components["schemas"]["__schema262"];
            revision: components["schemas"]["__schema266"];
            space_id: components["schemas"]["__schema261"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema272"];
            title: components["schemas"]["__schema263"];
            updated_at: components["schemas"]["__schema134"];
            wait: components["schemas"]["__schema269"];
        };
        /** @enum {string} */
        JobState: "queued" | "running" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "needs_reconciliation" | "completed" | "failed" | "cancelled";
        KnowledgeFrontmatter: {
            asserted_by: components["schemas"]["__schema50"];
            audience: components["schemas"]["__schema46"];
            confidence: components["schemas"]["__schema49"];
            created: components["schemas"]["__schema52"];
            id: components["schemas"]["__schema43"];
            links?: components["schemas"]["__schema57"];
            observed_at: components["schemas"]["__schema52"];
            schema_version: components["schemas"]["__schema58"];
            source: components["schemas"]["__schema51"];
            space: components["schemas"]["__schema45"];
            status: components["schemas"]["__schema48"];
            superseded_by?: components["schemas"]["__schema55"];
            supersedes?: components["schemas"]["__schema54"];
            tags?: components["schemas"]["__schema56"];
            title: components["schemas"]["__schema44"];
            type: components["schemas"]["__schema47"];
            updated: components["schemas"]["__schema52"];
            valid_from: components["schemas"]["__schema52"];
            valid_until?: components["schemas"]["__schema53"];
        };
        KnowledgeFrontmatterOutput: {
            asserted_by: components["schemas"]["__schema433"];
            audience: components["schemas"]["__schema431"];
            confidence: components["schemas"]["__schema432"];
            created: components["schemas"]["__schema435"];
            id: components["schemas"]["__schema428"];
            links: components["schemas"]["__schema440"];
            observed_at: components["schemas"]["__schema435"];
            schema_version: components["schemas"]["__schema441"];
            source: components["schemas"]["__schema434"];
            space: components["schemas"]["__schema430"];
            status: components["schemas"]["__schema426"];
            superseded_by: components["schemas"]["__schema438"];
            supersedes: components["schemas"]["__schema437"];
            tags: components["schemas"]["__schema439"];
            title: components["schemas"]["__schema429"];
            type: components["schemas"]["__schema425"];
            updated: components["schemas"]["__schema435"];
            valid_from: components["schemas"]["__schema435"];
            valid_until: components["schemas"]["__schema436"];
        };
        LiveClose: {
            live_id: components["schemas"]["__schema95"];
        };
        LiveClosed: {
            closed: components["schemas"]["__schema462"];
        };
        LiveInputResponse: {
            accepted: components["schemas"]["__schema459"];
        };
        LiveOpen: {
            control_epoch: components["schemas"]["__schema454"];
            expires_at: components["schemas"]["__schema458"];
            live_id: components["schemas"]["__schema453"];
            site_scope: components["schemas"]["__schema456"];
            viewport: components["schemas"]["__schema455"];
        };
        LiveScope: {
            host: components["schemas"]["__schema103"];
            live_id: components["schemas"]["__schema95"];
        };
        LiveScopeResponse: {
            site_scope: components["schemas"]["__schema460"];
        };
        Plugin: {
            description: components["schemas"]["__schema385"];
            fields: components["schemas"]["__schema387"];
            id: components["schemas"]["__schema383"];
            installed: components["schemas"]["__schema389"];
            title: components["schemas"]["__schema384"];
            tools: components["schemas"]["__schema388"];
            version: components["schemas"]["__schema386"];
        };
        RuntimeEvent: {
            at: components["schemas"]["__schema134"];
            attempt_id: components["schemas"]["__schema498"];
            capture_id: components["schemas"]["__schema501"];
            dedup_key: components["schemas"]["__schema500"];
            detail?: components["schemas"]["__schema507"];
            local_seq: components["schemas"]["__schema499"];
            name: components["schemas"]["__schema502"];
            outcome: components["schemas"]["__schema505"];
            redacted_args_digest: components["schemas"]["__schema506"];
            timing: components["schemas"]["__schema504"];
            tool_name: components["schemas"]["__schema503"];
            /** @constant */
            type: "hook_event";
        } | {
            at: components["schemas"]["__schema134"];
            attempt_id: components["schemas"]["__schema498"];
            capture_id: components["schemas"]["__schema501"];
            dedup_key: components["schemas"]["__schema500"];
            detail?: components["schemas"]["__schema507"];
            /** @enum {string} */
            error_code: "observer_failed" | "delivery_failed" | "capture_gap";
            local_seq: components["schemas"]["__schema499"];
            name: components["schemas"]["__schema502"];
            outcome: components["schemas"]["__schema505"];
            redacted_args_digest: components["schemas"]["__schema506"];
            timing: components["schemas"]["__schema504"];
            tool_name: components["schemas"]["__schema503"];
            /** @constant */
            type: "hook_error";
        } | {
            at: components["schemas"]["__schema134"];
            attempt_id: components["schemas"]["__schema498"];
            dedup_key: components["schemas"]["__schema500"];
            local_seq: components["schemas"]["__schema499"];
            turn: number;
            /** @constant */
            type: "turn_started";
        } | {
            at: components["schemas"]["__schema134"];
            attempt_id: components["schemas"]["__schema498"];
            dedup_key: components["schemas"]["__schema500"];
            local_seq: components["schemas"]["__schema499"];
            text: string;
            /** @constant */
            type: "text_delta";
        } | {
            arguments: components["schemas"]["__schema286"];
            at: components["schemas"]["__schema134"];
            attempt_id: components["schemas"]["__schema498"];
            call_id: string;
            dedup_key: components["schemas"]["__schema500"];
            local_seq: components["schemas"]["__schema499"];
            tool: string;
            /** @constant */
            type: "tool_call_proposed";
        } | {
            at: components["schemas"]["__schema134"];
            attempt_id: components["schemas"]["__schema498"];
            call_id: string;
            dedup_key: components["schemas"]["__schema500"];
            local_seq: components["schemas"]["__schema499"];
            ok: boolean;
            result: components["schemas"]["__schema286"];
            /** @constant */
            type: "tool_result";
        } | {
            action_id: string;
            at: components["schemas"]["__schema134"];
            attempt_id: components["schemas"]["__schema498"];
            dedup_key: components["schemas"]["__schema500"];
            kind: string;
            local_seq: components["schemas"]["__schema499"];
            /** @constant */
            type: "action_requested";
        } | {
            at: components["schemas"]["__schema134"];
            attempt_id: components["schemas"]["__schema498"];
            dedup_key: components["schemas"]["__schema500"];
            local_seq: components["schemas"]["__schema499"];
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
                action_ids: components["schemas"]["__schema508"][];
                /** @constant */
                kind: "waiting_for_approval";
            } | {
                /** @constant */
                kind: "waiting_for_event_or_time";
                wait: components["schemas"]["__schema269"];
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
            usage?: components["schemas"]["__schema332"];
        } | {
            after_seq: number;
            at: components["schemas"]["__schema134"];
            attempt_id: components["schemas"]["__schema498"];
            dedup_key: components["schemas"]["__schema500"];
            local_seq: components["schemas"]["__schema499"];
            reason: string;
            /** @constant */
            type: "gap";
        };
        Space: {
            audience: components["schemas"]["__schema176"];
            created_at: components["schemas"]["__schema134"];
            git_path: components["schemas"]["__schema178"];
            id: components["schemas"]["__schema173"];
            kind: components["schemas"]["__schema175"];
            name: components["schemas"]["__schema174"];
            owner_principal_id?: components["schemas"]["__schema177"];
        };
        SpaceRemoval: {
            blocked_reason: components["schemas"]["__schema187"];
            counts: components["schemas"]["__schema186"];
            finished_at: components["schemas"]["__schema188"];
            id: components["schemas"]["__schema180"];
            kind: components["schemas"]["__schema183"];
            phase: components["schemas"]["__schema185"];
            space_id: components["schemas"]["__schema181"];
            space_name: components["schemas"]["__schema182"];
            started_at: components["schemas"]["__schema134"];
            state: components["schemas"]["__schema184"];
        };
        SpaceRemovalPreview: {
            confirmation: components["schemas"]["__schema194"];
            counts: components["schemas"]["__schema191"];
            kind: components["schemas"]["__schema183"];
            name: components["schemas"]["__schema190"];
            providers: components["schemas"]["__schema192"];
            space_id: components["schemas"]["__schema189"];
            stays: components["schemas"]["__schema193"];
        };
        SpaceRemovalReport: {
            cleared: components["schemas"]["__schema196"];
            headline: components["schemas"]["__schema195"];
            removal: components["schemas"]["SpaceRemoval"];
            still_yours: components["schemas"]["__schema197"];
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
