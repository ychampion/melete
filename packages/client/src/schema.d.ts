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
                        "application/json": components["schemas"]["__schema525"];
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
                        "application/json": components["schemas"]["__schema525"];
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
    "/account/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /account/password
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
                        current_password: string;
                        new_password: components["schemas"]["__schema27"];
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
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
        /**
         * The action ledger
         * @description Every field of each action, or with `view=summary` only what a person is shown of it. GET /actions/{actionId} always returns the full record.
         */
        get: {
            parameters: {
                query?: {
                    effect_class?: components["schemas"]["EffectClass"];
                    job_id?: string;
                    limit?: number;
                    status?: components["schemas"]["ActionStatus"];
                    view?: "full" | "summary";
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
                        } | {
                            actions: components["schemas"]["ActionSummary"][];
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
                        "application/json": components["schemas"]["__schema498"];
                    };
                };
                /** @description No such action */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema498"];
                    };
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
                        "application/json": components["schemas"]["__schema498"];
                    };
                };
                /** @description No signed-in person to record the answer for */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such action among the caller's own */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Action is not awaiting reconciliation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /activity
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
                            activity: components["schemas"]["__schema344"][];
                        } | components["schemas"]["__schema262"];
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
    "/activity/{id}/undo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /activity/{id}/undo
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
                            entry: components["schemas"]["__schema344"];
                        } | components["schemas"]["__schema262"];
                    };
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
                            agents: components["schemas"]["__schema294"][];
                            removed?: components["schemas"]["__schema294"][];
                        } | components["schemas"]["__schema262"];
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
                    "application/json": components["schemas"]["__schema20"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema308"] | components["schemas"]["__schema262"];
                    };
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
        /**
         * DELETE /agents/{id}
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
                        "application/json": {
                            conversations: number;
                            id: components["schemas"]["__schema256"];
                            moved_to: components["schemas"]["__schema256"];
                            routines: number;
                            routines_paused: number;
                        } | components["schemas"]["__schema262"];
                    };
                };
            };
        };
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
                    "application/json": components["schemas"]["__schema20"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema308"] | components["schemas"]["__schema262"];
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
                                    allowed_connection_ids: components["schemas"]["__schema302"];
                                    asks_before_acting: components["schemas"]["__schema303"];
                                    colour: components["schemas"]["__schema297"];
                                    eye_colour: components["schemas"]["__schema299"];
                                    face_image?: components["schemas"]["__schema307"];
                                    name: components["schemas"]["__schema295"];
                                    reads_memory: components["schemas"]["__schema305"];
                                    role: components["schemas"]["__schema296"];
                                    standing_instruction: components["schemas"]["__schema301"];
                                    surface: components["schemas"]["__schema298"];
                                    tone: components["schemas"]["__schema300"];
                                    uses_computer: components["schemas"]["__schema304"];
                                    writes_memory: components["schemas"]["__schema306"];
                                };
                                benefit: string;
                                /** @enum {string} */
                                category: "Personal" | "Home & family" | "Money" | "Work & email" | "Research" | "Writing" | "Travel" | "Health & routines" | "Learning" | "Code & projects" | "Small business" | "Shopping & subscriptions";
                                day: {
                                    answer: string;
                                    ask: string;
                                    opening: string;
                                    question: {
                                        options: components["schemas"]["__schema318"][];
                                        text: string;
                                    };
                                    work: components["schemas"]["__schema317"][];
                                };
                                does: components["schemas"]["__schema309"][];
                                featured: boolean;
                                id: components["schemas"]["__schema256"];
                                questions: components["schemas"]["__schema314"][];
                                relies_on: components["schemas"]["__schema312"][];
                                skills: components["schemas"]["__schema316"][];
                                starter_routine: {
                                    at: string;
                                    instruction: string;
                                    title: string;
                                    weekdays: components["schemas"]["__schema313"][];
                                } | null;
                                title: components["schemas"]["__schema257"];
                                wont: components["schemas"]["__schema310"][];
                                works_best_with: components["schemas"]["__schema311"][];
                            }[];
                        } | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema292"] | components["schemas"]["__schema262"];
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
                            apps: boolean;
                            calendar: boolean;
                            own_calendar: boolean;
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
                        "application/json": components["schemas"]["__schema292"] | components["schemas"]["__schema262"];
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
                                canonical_payload: components["schemas"]["__schema412"];
                                connection_id: string;
                                effect_class: components["schemas"]["EffectClass"];
                                expires_at: components["schemas"]["__schema189"] | null;
                                job_id: string;
                                job_revision: number;
                                kind: string;
                                /** @default [] */
                                origin_warnings: {
                                    description: string;
                                    field: string;
                                    handle: string | null;
                                    origin_trust: components["schemas"]["__schema423"];
                                }[];
                                payload_hash: components["schemas"]["__schema469"];
                                requested_at: components["schemas"]["__schema189"];
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
                            decided_at: components["schemas"]["__schema189"];
                            /** @enum {string} */
                            decision: "approved" | "denied";
                            payload_hash: components["schemas"]["__schema469"];
                        };
                    };
                };
                /** @description The payload changed since this approval was requested */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/apps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The apps this person can open, newest change first
         * @description Apps published by this person, and apps others shared with them by name or with everyone who has an account here. `role` says whether they may change it.
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
                /** @description Apps */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            apps: components["schemas"]["__schema685"][];
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
    "/apps/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** One app: its current files and data, and for managers its versions and grants */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: components["schemas"]["__schema171"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description App */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema693"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /**
         * Delete an app with every version and grant
         * @description Only the person who published the app can delete it. Its files are kept for a grace period while nothing else uses them, then removed.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: components["schemas"]["__schema171"];
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
                            id: components["schemas"]["__schema686"];
                        };
                    };
                };
                /** @description Not the person who published it */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/apps/{id}/current": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Choose which version of an app people see
         * @description The change is immediate: the next time anyone opens the app, they get this version. The manager makes it from the Apps screen, so it is not asked about first.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: components["schemas"]["__schema171"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        version_id: string;
                    };
                };
            };
            responses: {
                /** @description App */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema693"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not a manager of this app */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app, or that version is not one of its own */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/apps/{id}/data-updates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * New data versions waiting for the publisher to review
         * @description Only for data the publisher chose to review. Each update says what changed: for JSON, the top-level keys added, removed and changed, and the size before and after.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: components["schemas"]["__schema171"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Waiting updates */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema695"];
                    };
                };
                /** @description Not the publisher or the space owner */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Let one new data version through to viewers
         * @description Viewers see that version from their next read. The version must be the newest one written; an older one is refused, so what is let through is what was reviewed.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: components["schemas"]["__schema171"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        artifact_id: string;
                        binding: components["schemas"]["__schema173"];
                    };
                };
            };
            responses: {
                /** @description Updates still waiting */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema695"];
                    };
                };
                /** @description Not the publisher or the space owner */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app or data name, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description A newer version was written, or the file changed, since it was shown */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/apps/{id}/data/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * One of an app's data, for the person viewing it
         * @description The newest version of the file the app's current version names under `name`, read from the publisher's conversation in the app's own space. When the publisher reviews updates, the newest version they let through. A JSON file is returned parsed, any other text as a string. The app reads it through the page around it, with the viewer's session; the app itself holds no session.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: string;
                    /** @description A data name the app's version declares */
                    name: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The data */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            format: ("json" | "text") | null;
                            name: components["schemas"]["__schema694"];
                            /** @enum {string} */
                            state: "ready" | "none";
                            updated_at: components["schemas"]["__schema189"] | null;
                            value: components["schemas"]["__schema413"];
                        };
                    };
                };
                /** @description No such app or data name, or this person cannot open the app */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The file is not readable as data: too large, not text, or not JSON */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/apps/{id}/grants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Replace the list of who can open an app
         * @description The list given becomes the whole list. Any change ends every view opened under the old list. People are named by the email of their account on this installation.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: components["schemas"]["__schema171"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        grants: components["schemas"]["__schema172"][];
                    };
                };
            };
            responses: {
                /** @description App */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema693"];
                    };
                };
                /** @description Invalid request, or an email with no account here */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not a manager of this app */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/apps/{id}/submissions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** An app's responses, newest first */
        get: {
            parameters: {
                query?: {
                    /** @description Responses older than this one, from `next_before` */
                    before?: components["schemas"]["__schema175"];
                    /** @description Only this collection */
                    collection?: components["schemas"]["__schema174"];
                };
                header?: never;
                path: {
                    /** @description App id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Responses */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            next_before: string | null;
                            submissions: {
                                by: components["schemas"]["__schema687"] | null;
                                collection: components["schemas"]["__schema694"];
                                created_at: components["schemas"]["__schema189"];
                                data: components["schemas"]["__schema412"];
                                id: string;
                                version_id: components["schemas"]["__schema689"];
                            }[];
                        };
                    };
                };
                /** @description Not a manager of this app */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Send a response from an app
         * @description Stored with the viewer's account, for a collection the app's current version declares. A record is at most the size the collection declares (16 KiB at most). One person may send one app 30 responses a minute, and an app keeps 500 from any one person and 10,000 in all.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: components["schemas"]["__schema171"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        collection: components["schemas"]["__schema173"];
                        record: components["schemas"]["__schema56"];
                    };
                };
            };
            responses: {
                /** @description Stored */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            created_at: components["schemas"]["__schema189"];
                            id: string;
                        };
                    };
                };
                /** @description Invalid request, or a collection the app does not declare */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The record is larger than the collection allows */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Too many responses in the last minute, or the app holds its most */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        /**
         * Delete every response one person sent an app
         * @description Their contents are removed; the app keeps no copy.
         */
        delete: {
            parameters: {
                query: {
                    /** @description The account whose responses are deleted */
                    from: string;
                };
                header?: never;
                path: {
                    /** @description App id */
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
                            deleted: number;
                            from: string;
                        };
                    };
                };
                /** @description No account named */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not a manager of this app */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/apps/{id}/submissions/{submission_id}": {
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
         * Delete one response
         * @description Its contents are removed; the app keeps no copy.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: string;
                    /** @description Response id */
                    submission_id: string;
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
                            id: string;
                        };
                    };
                };
                /** @description Not a manager of this app */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app or response, or this person cannot open the app */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/apps/{id}/views": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open a view of an app for the person asking
         * @description Returns where the app's current version loads for this person. The view belongs to the browser session that asked, and lasts until it signs out, or twelve hours at most. The page is meant to be framed by Melete with `sandbox="allow-scripts allow-forms allow-downloads"`. A change to who may open the app, or to its version, ends the view on its next file request. Only a browser session can open one.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description App id */
                    id: components["schemas"]["__schema171"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A view */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            expires_at: components["schemas"]["__schema189"];
                            version_id: components["schemas"]["__schema689"];
                            view_path: string;
                        };
                    };
                };
                /** @description Asked with an assistant token rather than a browser session */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/apps/view/{token}/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * One file of an app, as its view loads it
         * @description Raw bytes, typed from the version's manifest. No session is read: the token in the path is the whole authorisation, and it is checked again on every request against the app's viewers and current version. Every response carries `Content-Security-Policy: sandbox ...`, so the file runs with an opaque origin and can load only its own files. A browser asking for one as a page of its own, rather than in a frame, is refused.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description A file path in the version's manifest */
                    path: string;
                    /** @description The view token */
                    token: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The file */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/octet-stream": string;
                    };
                };
                /** @description Opened as a page of its own rather than framed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description An unknown, expired or ended view, or a path the version does not hold */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No matching artifact in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/attachments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload a file to send with a message
         * @description Multipart form data: the file in `file`, and for a picture optionally a small copy in `preview` (at most 1280 pixels on its longest side, small enough for a model request). Pictures, PDFs, Word documents, spreadsheets and text files are taken, up to the size `GET /attachments/limits` gives (20 MB unless the operator sets another). The file waits, visible only to whoever uploaded it, until a message names it in `attachments`; one never sent is deleted after a day. A sent file belongs to its chat and is deleted with it.
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
                    "multipart/form-data": {
                        /** Format: binary */
                        file: string;
                        /** Format: binary */
                        preview?: string;
                    };
                };
            };
            responses: {
                /** @description The file, ready to send */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema577"];
                    };
                };
                /** @description Empty, unreadable, or not the kind of file it says it is */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description A session is required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Larger than the limit */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description A kind of file Melete does not read */
                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description More uploads at once, or in a while, than the operator allows */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/attachments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Take back a file not sent yet */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Attachment id */
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
                            ok: true;
                        };
                    };
                };
                /** @description No such file for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Already sent; it is deleted with its chat */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/attachments/{id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read back a file sent, or about to be sent, in chat
         * @description For whoever uploaded it before it is sent, and for the person whose chat it is after. `variant=preview` reads the small copy a picture has.
         */
        get: {
            parameters: {
                query?: {
                    variant?: "original" | "preview";
                };
                header?: never;
                path: {
                    /** @description Attachment id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The bytes */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/octet-stream": string;
                    };
                };
                /** @description A session is required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such file for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/attachments/limits": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What files this installation takes
         * @description The largest file, the most files in one message, and how many uploads one person may have under way at once: half of what the whole service holds (8 by default), or the operator's lower limit. A client queues its uploads to that number, so a person never meets the refusal past it.
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
                /** @description The limits */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            file_bytes: number;
                            per_message: number;
                            uploads_at_once: number | null;
                        };
                    };
                };
                /** @description A session is required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                            automations: components["schemas"]["__schema337"][];
                        } | components["schemas"]["__schema262"];
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
                        agent_id?: components["schemas"]["__schema13"];
                        at: string;
                        instruction: components["schemas"]["__schema12"];
                        title: components["schemas"]["__schema12"];
                        weekdays: components["schemas"]["__schema25"][];
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
                        "application/json": components["schemas"]["__schema338"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/automations/{id}": {
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
         * DELETE /automations/{id}
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/automations/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /automations/{id}/pause
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
                        "application/json": components["schemas"]["__schema338"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/automations/{id}/restart": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /automations/{id}/restart
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
                        "application/json": components["schemas"]["__schema338"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/automations/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /automations/{id}/resume
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
                        "application/json": components["schemas"]["__schema338"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
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
                        agent_id?: components["schemas"]["__schema13"];
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
                        "application/json": components["schemas"]["__schema338"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema345"] | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema345"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The live view could not open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The live view was already closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                    after?: components["schemas"]["__schema128"];
                    /** @description The live id this view was opened with */
                    live_id: components["schemas"]["__schema127"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                    "application/json": components["schemas"]["__schema129"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Input above the rate cap; the view closes */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The host was refused or the scope is full */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not the owner of this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not the owner of this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The browser could not be cleared */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                            calendar_url?: components["schemas"]["__schema99"];
                            server_url?: components["schemas"]["__schema101"];
                            username: components["schemas"]["__schema100"];
                        };
                        command_line?: components["schemas"]["CommandLineConnectionConfig"];
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
                        mcp?: components["schemas"]["__schema92"];
                        mcp_stdio?: {
                            allowed_scopes: components["schemas"]["__schema94"];
                            args?: components["schemas"]["__schema105"];
                            audience: components["schemas"]["__schema96"];
                            command?: components["schemas"]["__schema104"];
                            egress?: components["schemas"]["__schema107"];
                            id: components["schemas"]["__schema93"];
                            runner: components["schemas"]["__schema102"];
                            secret_env?: components["schemas"]["__schema109"];
                            source: components["schemas"]["__schema103"];
                            tools: components["schemas"]["__schema97"];
                        };
                        /** @enum {string} */
                        provider: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp" | "sandbox" | "device" | "command_line" | "apps" | "room" | "notes";
                        sandbox?: {
                            /** @enum {string} */
                            adapter: "e2b" | "daytona" | "modal" | "docker";
                            cidrs?: components["schemas"]["__schema111"][];
                            /** @enum {string} */
                            egress: "deny_all" | "cidr_allowlist" | "connected_hosts_only" | "open";
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
                        "application/json": components["schemas"]["__schema513"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description MCP installation name already exists */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema513"];
                    };
                };
                /** @description No such connection */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            conversations: components["schemas"]["__schema255"][];
                            next_cursor: string | null;
                        } | components["schemas"]["__schema262"];
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
                        agent_id?: components["schemas"]["__schema13"];
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
                        "application/json": components["schemas"]["__schema263"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema263"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /**
         * DELETE /conversations/{id}
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        delete: {
            parameters: {
                query?: {
                    forget_memory?: "true" | "false";
                };
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
                            forgotten: components["schemas"]["__schema261"];
                            id: components["schemas"]["__schema256"];
                            stopped: boolean;
                            withdrawn: components["schemas"]["__schema261"];
                        } | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /**
         * PATCH /conversations/{id}
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
                        title: string;
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
                        "application/json": components["schemas"]["__schema263"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
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
                        "application/json": components["schemas"]["__schema263"] | components["schemas"]["__schema262"];
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
                            cards: components["schemas"]["__schema272"][];
                        } | components["schemas"]["__schema262"];
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
                                    artifact_id: components["schemas"]["__schema256"];
                                } | null;
                                seen_at: components["schemas"]["__schema260"] | null;
                                session_id: components["schemas"]["__schema256"];
                                title: string | null;
                                url: string | null;
                            } | null;
                            /** @default [] */
                            processes: components["schemas"]["__schema288"][];
                            terminal: components["schemas"]["__schema287"][];
                        } | components["schemas"]["__schema262"];
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
                            drafts: components["schemas"]["__schema282"][];
                        } | components["schemas"]["__schema262"];
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
                            events: components["schemas"]["__schema266"][];
                            has_more: boolean;
                            next_cursor: components["schemas"]["__schema261"];
                        } | components["schemas"]["__schema262"];
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
                            turns: components["schemas"]["__schema264"][];
                        } | components["schemas"]["__schema262"];
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
                        attachments?: components["schemas"]["__schema18"];
                        corrects?: components["schemas"]["__schema16"];
                        text: components["schemas"]["__schema15"];
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
                                id: components["schemas"]["__schema256"];
                                received_at: components["schemas"]["__schema260"];
                                /** @enum {string} */
                                status: "accepted" | "failed_retry";
                            };
                            turn_id: components["schemas"]["__schema256"];
                        } | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema263"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/privacy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /conversations/{id}/privacy
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
                        "application/json": components["schemas"]["__schema350"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        /**
         * PUT /conversations/{id}/privacy
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        put: {
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
                        sensitive: components["schemas"]["SensitiveTopic"] | null;
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
                        "application/json": components["schemas"]["__schema350"] | components["schemas"]["__schema262"];
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
    "/conversations/{id}/privacy/reveal": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /conversations/{id}/privacy/reveal
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
                        turn_id: string;
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
                            items: {
                                category: components["schemas"]["PrivacyCategory"];
                                placeholder: string;
                                value: string;
                            }[];
                        } | components["schemas"]["__schema262"];
                    };
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
                            receipts: components["schemas"]["__schema275"][];
                        } | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema263"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema263"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/voice/aside": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Talk with Melete while the conversation’s turn runs
         * @description A light model call alongside the running turn. It sees the conversation, the activity sent with the request and the agent’s name, and goes through the privacy router like every model call. It has no tools and acts on nothing: it answers, says how the work is going, or says that what was heard is an instruction for the work (`steer`) or a request to stop it (`stop`), which the caller carries out through the ordinary routes. The words are not kept; like every model call it leaves a privacy log entry and adds any redacted details to the conversation’s vault. Each aside counts against the person’s daily voice allowance.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Conversation id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        activity: components["schemas"]["__schema163"];
                        /** @constant */
                        kind: "heard";
                        text: string;
                    } | {
                        activity: components["schemas"]["__schema163"];
                        /** @constant */
                        kind: "progress";
                    };
                };
            };
            responses: {
                /** @description What to say, and what was meant */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            intent: "talk" | "steer" | "stop" | "quiet";
                            say: string | null;
                        };
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Voice is off in a private space, agent or sensitive conversation */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such conversation, or voice mode is not set up */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Too many asides in a short time, or the daily allowance is used up */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/voice/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open a realtime transcription session for voice mode
         * @description Answers with an address carrying a single-use token; the provider key never reaches the browser. Each finished utterance is sent as an ordinary message to this conversation.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Conversation id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Open `url` as a WebSocket */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            expires_at: string;
                            sample_rate: number;
                            url: string;
                        };
                    };
                };
                /** @description Voice is off in a private space, agent or sensitive conversation */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such conversation, or voice mode is not set up */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The daily allowance of voice sessions is used up */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The speech provider could not open a session */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/voice/speech": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Read part of a reply aloud
         * @description Streams speech for the text as it is made. Nothing is kept. Each request counts its characters against the person’s daily allowance.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Conversation id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        text: string;
                    };
                };
            };
            responses: {
                /** @description Speech, streamed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "audio/mpeg": string;
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Voice is off in a private space, agent or sensitive conversation */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such conversation, or voice mode is not set up */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The daily allowance for reading aloud is used up */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The speech provider could not speak it */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/device/browser/leave": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** The browser extension was switched off (companion) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Received */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            status: "ok";
                        };
                    };
                };
                /** @description Token unknown or revoked */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/device/hello": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Say what this computer allows, on start and after a change (companion) */
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
                        capabilities: components["schemas"]["DeviceCapabilities"];
                        companion_version: string;
                        folders: components["schemas"]["__schema170"][];
                    };
                };
            };
            responses: {
                /** @description What Settings allows */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            capabilities: components["schemas"]["DeviceCapabilitiesOutput"];
                            device_id: string;
                            name: string;
                        };
                    };
                };
                /** @description Token unknown or revoked */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/device/pair": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pair a computer with a one-time code (companion) */
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
                        capabilities: components["schemas"]["DeviceCapabilities"];
                        code: string;
                        companion_version: string;
                        folders: components["schemas"]["__schema170"][];
                        name: string;
                        /** @enum {string} */
                        platform: "windows" | "macos" | "linux" | "other";
                    };
                };
            };
            responses: {
                /** @description The device token, shown once */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            capabilities: components["schemas"]["DeviceCapabilitiesOutput"];
                            device_id: string;
                            name: string;
                            token: string;
                        };
                    };
                };
                /** @description The code is wrong, used or expired */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Too many wrong codes */
                429: {
                    headers: {
                        /** @description Seconds to wait before the next attempt */
                        "Retry-After": string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/device/requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Wait for work for this computer (companion)
         * @description Answers as soon as there is work, or empty after about 25 seconds. `channel=browser` is the browser bridge, which collects only browser work.
         */
        get: {
            parameters: {
                query?: {
                    channel?: "main" | "browser";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Work to do */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            requests: components["schemas"]["DeviceRequest"][];
                        };
                    };
                };
                /** @description Token unknown or revoked */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Using the browser is turned off for this computer */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/device/requests/{id}/result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Answer one request (companion) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Request id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        ok: true;
                        result: {
                            [key: string]: unknown;
                        };
                    } | {
                        error: {
                            /** @enum {string} */
                            code: "capability_off" | "outside_folders" | "not_found" | "too_large" | "invalid_request" | "failed" | "unknown_tab" | "protected_field" | "page_changed";
                            message: string;
                        };
                        /** @constant */
                        ok: false;
                    };
                };
            };
            responses: {
                /** @description Received */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            status: "ok";
                        };
                    };
                };
                /** @description Token unknown or revoked */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No request by that id is waiting */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The computers connected to this space, with what each may do */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Devices */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            devices: components["schemas"]["Device"][];
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
    "/devices/{id}": {
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
        /** Change what a connected computer may do */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Device id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        capabilities?: {
                            browser?: components["schemas"]["__schema169"];
                            commands?: components["schemas"]["__schema165"];
                            files?: components["schemas"]["__schema166"];
                            open_url?: components["schemas"]["__schema167"];
                            screenshot?: components["schemas"]["__schema168"];
                        };
                        cloud_screenshots?: boolean | null;
                    };
                };
            };
            responses: {
                /** @description Device */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema680"];
                    };
                };
                /** @description Device not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Device revoked */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/devices/{id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Disconnect a computer for good
         * @description The computer loses access at once: its token stops working, work waiting for it is refused, and its connection is revoked. Pair again to reconnect it.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Device id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Revoked device */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema680"];
                    };
                };
                /** @description Device not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/devices/pairings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Make a one-time code that connects a computer
         * @description The code works once, for ten minutes. The capabilities chosen here are what the computer may do once paired; running commands is off unless it is chosen.
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
                        /**
                         * @default {
                         *       "commands": false,
                         *       "files": true,
                         *       "open_url": true,
                         *       "screenshot": false,
                         *       "browser": false
                         *     }
                         */
                        capabilities?: components["schemas"]["DeviceCapabilities"];
                    };
                };
            };
            responses: {
                /** @description Code to type into the companion */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["DevicePairing"];
                    };
                };
                /** @description Space owner required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            draft: components["schemas"]["__schema282"];
                            permission: components["schemas"]["__schema280"] | null;
                            receipt: components["schemas"]["__schema275"] | null;
                        } | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema226"];
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
                        "application/json": components["schemas"]["__schema229"];
                    };
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
                        "application/json": components["schemas"]["__schema229"];
                    };
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
                        "application/json": components["schemas"]["__schema229"];
                    };
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
                        "application/json": components["schemas"]["__schema229"];
                    };
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
                        "application/json": components["schemas"]["__schema229"];
                    };
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
                        "application/json": components["schemas"]["__schema229"];
                    };
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
                        "application/json": components["schemas"]["__schema229"];
                    };
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
                        "application/json": components["schemas"]["__schema226"];
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
                            prohibitions: components["schemas"]["__schema228"][];
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
                            prohibition: components["schemas"]["__schema228"];
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
                            episodes: components["schemas"]["__schema197"][];
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
                        "application/json": components["schemas"]["__schema202"];
                    };
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
                    after?: components["schemas"]["__schema89"];
                    limit?: components["schemas"]["__schema90"];
                    types?: components["schemas"]["__schema91"];
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
                        "application/json": components["schemas"]["__schema463"];
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
                        "application/json": components["schemas"]["__schema343"] | components["schemas"]["__schema262"];
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
    "/experience/connections/{id}/watching": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * PUT /experience/connections/{id}/watching
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        put: {
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
                        on: boolean;
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
                        "application/json": components["schemas"]["__schema343"] | components["schemas"]["__schema262"];
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
                            source_connection: components["schemas"]["__schema256"];
                            title: components["schemas"]["__schema257"];
                            updated_at: components["schemas"]["__schema260"];
                            value: components["schemas"]["__schema257"];
                        } | components["schemas"]["__schema262"];
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
                            artist: components["schemas"]["__schema257"];
                            image?: components["schemas"]["__schema267"];
                            playing: boolean;
                            source_connection: components["schemas"]["__schema256"];
                            title: components["schemas"]["__schema257"];
                        } | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema610"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description A session is required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema610"];
                    };
                };
                /** @description No such report, or not one this person sent */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema610"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only the person who runs the installation changes a status */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such report */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema528"];
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
                    "application/json": components["schemas"]["__schema126"];
                };
            };
            responses: {
                /** @description Open `authorize_url` in the browser */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema529"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No OAuth client, no public address to return to, or no master key */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema530"];
                    };
                };
                /** @description No sign-in by that id for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/handoffs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Work rooms asked the signed-in person to run with their own setup
         * @description Each handoff carries the whole task, exactly as it would run, and, once it has run, the exact result. Nothing from the person's own space reaches the room until they share that result.
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
                /** @description Handoffs, newest first */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            handoffs: components["schemas"]["__schema289"][];
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
    "/handoffs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run a handoff with my setup, or decline it
         * @description Accepting names the task's hash, so only the task the person read runs. It runs in the person's own space with their own connections, and anything it sends asks them as usual. Declining tells the room.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Handoff id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        decision: "accept";
                        task_hash: components["schemas"]["__schema45"];
                    } | {
                        /** @constant */
                        decision: "decline";
                    };
                };
            };
            responses: {
                /** @description The handoff */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema379"];
                    };
                };
                /** @description No such handoff for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Already answered or expired, the task changed, or the person is no longer in the room */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/handoffs/{id}/result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Share the result with the room, or keep it
         * @description Sharing names the result's hash and posts that exact text to the thread as the person, through their agent. Keeping tells the room only that the person kept it.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Handoff id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        decision: "share";
                        result_hash: components["schemas"]["__schema45"];
                    } | {
                        /** @constant */
                        decision: "keep";
                    };
                };
            };
            responses: {
                /** @description The handoff */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema379"];
                    };
                };
                /** @description No such handoff for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No result yet, already shared or kept, the result changed, or the person is no longer in the room */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
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
                                embedding?: {
                                    configured: boolean;
                                    consecutive_failures: number;
                                    last_error: string | null;
                                    last_success_at: components["schemas"]["__schema189"] | null;
                                    local: boolean;
                                    model: string | null;
                                    paused_until: components["schemas"]["__schema189"] | null;
                                    spaces_not_embedded: number;
                                };
                                failed: number;
                                failed_reason: ("provider_auth" | "provider_refused" | "provider_unavailable" | "provider_slow" | "daily_budget" | "unreadable_answer" | "answer_cut_off" | "answer_refused" | "too_large" | "no_memory_model" | "other") | null;
                                reason: ("provider_unavailable" | "provider_slow" | "daily_budget") | null;
                                /** @enum {string} */
                                status: "ok" | "waiting";
                                waiting: number;
                            };
                            runtime_adapter?: string;
                            runtime_supervisor?: ("process" | "docker") | null;
                            /** @enum {string} */
                            status: "ok" | "degraded";
                            time: components["schemas"]["__schema189"];
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
    "/health/detail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Each health check the operator alerts on, with what it found
         * @description The database, the runtime that runs attempts, the job queue (work due more than ten minutes ago that has not started) and the error rate over the last fifteen minutes. Takes MELETE_OPERATOR_TOKEN as a bearer token; without that setting the route answers 404. Answers 503 while any check fails, so an uptime monitor can watch it.
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
                /** @description Every check passed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema443"];
                    };
                };
                /** @description The operator token is missing or wrong */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description MELETE_OPERATOR_TOKEN is not set */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description At least one check failed */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema443"];
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
                            date: components["schemas"]["__schema257"];
                            greeting: components["schemas"]["__schema257"];
                            handoffs?: components["schemas"]["__schema289"][];
                            open_task_count: components["schemas"]["__schema261"];
                            routine_results: {
                                automation_id: components["schemas"]["__schema256"];
                                conversation_id: components["schemas"]["__schema256"];
                                run: components["schemas"]["__schema335"];
                                title: components["schemas"]["__schema257"];
                            }[];
                            tasks: components["schemas"]["__schema334"][];
                            time_zone: components["schemas"]["__schema257"];
                            upcoming: {
                                connection_id: components["schemas"]["__schema256"];
                                ends_at: components["schemas"]["__schema260"];
                                id: components["schemas"]["__schema256"];
                                starts_at: components["schemas"]["__schema260"];
                                title: components["schemas"]["__schema257"];
                                url?: components["schemas"]["__schema267"];
                            }[] | components["schemas"]["__schema262"];
                            within_day_hours: boolean;
                        } | components["schemas"]["__schema262"];
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
                        payload: components["schemas"]["__schema56"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The connection is not active */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invites/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept an invite
         * @description For someone not signed in it makes the guest account with the password given and signs it in. When the email already has a guest account, sign in as it first. The link works once.
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
                        display_name?: components["schemas"]["__schema33"];
                        password?: string;
                        token: components["schemas"]["__schema32"];
                    };
                };
            };
            responses: {
                /** @description In the room, signed in */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            room_id: components["schemas"]["__schema351"];
                        };
                    };
                };
                /** @description A new account needs a password */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The link is wrong, used, withdrawn or out of date */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The email has an account: sign in as it first, or it is a full account an owner adds */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/invites/view": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * What an invite link is for
         * @description Public. It names the room and nothing about the room's people.
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
                        token: components["schemas"]["__schema32"];
                    };
                };
            };
            responses: {
                /** @description The invite */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            existing_account: boolean;
                            expires_at: components["schemas"]["__schema189"];
                            room_name: string;
                        };
                    };
                };
                /** @description The link is wrong, used, withdrawn or out of date */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                    "Idempotency-Key"?: components["schemas"]["__schema35"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema47"];
                };
            };
            responses: {
                /** @description A retried submission whose first status was not recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description Accepted, or the same key and input submitted again */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"] | components["schemas"]["__schema191"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"] | components["schemas"]["__schema191"];
                    };
                };
                /** @description No such space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
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
                    "Idempotency-Key"?: components["schemas"]["__schema35"];
                };
                path: {
                    /** @description Job ID */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema58"];
                };
            };
            responses: {
                /** @description Accepted, or the same key and input submitted again */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"] | components["schemas"]["__schema191"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"] | components["schemas"]["__schema191"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
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
                            episode: components["schemas"]["__schema197"];
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
                            createdAt: components["schemas"]["__schema189"];
                            inputRefs: string[];
                            jobId: string;
                            scope: components["schemas"]["__schema199"];
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
                        due_at?: components["schemas"]["__schema54"];
                        /** @enum {string} */
                        kind: "timer" | "remote_task" | "local_process";
                        operation_key: components["schemas"]["__schema35"];
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
                        "application/json": components["schemas"]["__schema414"];
                    };
                };
                /** @description Operation key conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema384"];
                    };
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
                                    created_at: components["schemas"]["__schema189"];
                                    /** @default null */
                                    evaluation: {
                                        detail: string;
                                        evaluated_at: components["schemas"]["__schema189"];
                                        passed: boolean;
                                    } | null;
                                    fault_kind: components["schemas"]["__schema474"];
                                    id: string;
                                    job_id: string;
                                    kind: string;
                                    /** @default null */
                                    observed_schema: components["schemas"]["__schema412"] | null;
                                    proposed_mapping: {
                                        [key: string]: string;
                                    };
                                    safe: boolean;
                                    /** @enum {string} */
                                    state: "candidate" | "evaluated" | "applied" | "rejected";
                                    test: {
                                        expected: components["schemas"]["__schema412"];
                                        input: components["schemas"]["__schema412"];
                                        name: string;
                                        operation: string;
                                        /** @default [] */
                                        preserves: {
                                            path: string;
                                            value: string;
                                        }[];
                                    };
                                    updated_at: components["schemas"]["__schema189"];
                                }[];
                                /** @default {} */
                                counters: components["schemas"]["__schema472"];
                                /** @default null */
                                disposition: components["schemas"]["__schema471"] | null;
                                effect_class: components["schemas"]["EffectClass"];
                                /** @default null */
                                intent_key: components["schemas"]["__schema470"] | null;
                                job_id: string;
                                kind: string;
                                payload_hash: components["schemas"]["__schema469"];
                                /** @default null */
                                retry_after_at: components["schemas"]["__schema189"] | null;
                                safe_stop: boolean;
                                status: components["schemas"]["ActionStatus"];
                                /** @default [] */
                                trace: components["schemas"]["__schema473"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema384"];
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
                        importance?: components["schemas"]["__schema52"];
                        scheduling_class?: components["schemas"]["__schema51"];
                        unread_threshold?: components["schemas"]["__schema53"];
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
                        "application/json": components["schemas"]["__schema384"];
                    };
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
                        "application/json": components["schemas"]["__schema411"];
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
                            all?: components["schemas"]["__schema86"];
                            any?: components["schemas"]["__schema88"];
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
                                created_at: components["schemas"]["__schema189"];
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
                                        all: components["schemas"]["__schema446"];
                                        any?: components["schemas"]["__schema448"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The job has finished */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema445"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema445"];
                    };
                };
                /** @description Job is already finished */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                    after?: components["schemas"]["__schema89"];
                    limit?: components["schemas"]["__schema90"];
                    types?: components["schemas"]["__schema91"];
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
                        "application/json": components["schemas"]["__schema463"];
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
                    "Idempotency-Key"?: components["schemas"]["__schema35"];
                };
                path: {
                    /** @description Job id */
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema58"];
                };
            };
            responses: {
                /** @description Accepted, or the same key and input submitted again */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"] | components["schemas"]["__schema191"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"] | components["schemas"]["__schema191"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
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
                        "application/json": components["schemas"]["__schema450"];
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
                                status: components["schemas"]["__schema560"];
                                tags: string[];
                                title: string;
                                type: components["schemas"]["__schema559"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema561"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema561"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        expected_revision: components["schemas"]["__schema64"];
                        frontmatter: components["schemas"]["KnowledgeFrontmatter"];
                        idempotency_key: components["schemas"]["__schema63"];
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
                        "application/json": components["schemas"]["__schema430"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            proposals: components["schemas"]["__schema442"][];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema442"];
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
                        "application/json": components["schemas"]["__schema442"];
                    };
                };
                /** @description Proposal is stale */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                                status: components["schemas"]["__schema560"];
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
                            items: components["schemas"]["__schema220"][];
                            last_change: components["schemas"]["__schema222"] | null;
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
                        "application/json": components["schemas"]["__schema223"];
                    };
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
                        "application/json": components["schemas"]["__schema223"];
                    };
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
                        "application/json": components["schemas"]["__schema223"];
                    };
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
                        "application/json": components["schemas"]["__schema223"];
                    };
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
                        "application/json": components["schemas"]["__schema223"];
                    };
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
                        "application/json": components["schemas"]["__schema223"];
                    };
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
                            notices: components["schemas"]["__schema224"][];
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
                            episode_id: components["schemas"]["__schema198"] | null;
                            item: components["schemas"]["__schema220"] | null;
                            notice: components["schemas"]["__schema224"];
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
                            notice: components["schemas"]["__schema224"];
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
                    space_id?: components["schemas"]["__schema139"];
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
                            company: components["schemas"]["__schema601"];
                            item: components["schemas"]["__schema604"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema604"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Already finished, or no longer quotable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Handling is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema604"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The item is already settled or dropped */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Stopping is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                    "application/json": components["schemas"]["__schema85"];
                };
            };
            responses: {
                /** @description Signed in */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema444"];
                    };
                };
                /** @description An email and a password of 8 to 1024 characters are required */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The email or the password is wrong */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The request came from another origin */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No database is configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema527"];
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
                        "application/json": components["schemas"]["__schema527"];
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
                        "application/json": components["schemas"]["__schema527"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Too many tool calls from this connection */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema527"];
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
                        "application/json": components["schemas"]["__schema527"];
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
                        client?: components["schemas"]["__schema116"];
                        label: string;
                        mcp: components["schemas"]["__schema92"];
                        space_id?: string;
                    } | {
                        client?: components["schemas"]["__schema116"];
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
                            expires_at: components["schemas"]["__schema189"];
                            /** Format: uri */
                            issuer: string;
                            /** Format: uri */
                            redirect_uri: string;
                            scopes: components["schemas"]["__schema524"][];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No public address to return to, no master key, a server that needs no sign-in, or one that needs a client registered by hand */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The server or its authorization server did not answer as required */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            expires_at: components["schemas"]["__schema189"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema444"];
                    };
                };
                /** @description No session, or the session has expired */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Change the name other people in a room see */
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
                        display_name: components["schemas"]["__schema33"] | null;
                    };
                };
            };
            responses: {
                /** @description The signed-in account */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            owner: {
                                created_at: components["schemas"]["__schema189"];
                                display_name: string | null;
                                /** Format: email */
                                email: string;
                                id: string;
                                /** @enum {string} */
                                kind?: "person" | "guest";
                            };
                        };
                    };
                };
                /** @description No session, or the session has expired */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/me/linked-accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The chat platform accounts linked to the signed-in person
         * @description A linked account speaks, answers permissions and hears threads in the rooms the person is in, as them. A chat platform links an account after its own sign-in proves who holds it.
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
                /** @description Linked accounts */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            accounts: {
                                created_at: components["schemas"]["__schema189"];
                                external_id: string;
                                provider: string;
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
    "/me/linked-accounts/{provider}/{externalId}": {
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
         * Unlink one of the signed-in person's chat platform accounts
         * @description From then on the account can no longer post, answer or hear anything as the person. Changing or resetting the password unlinks every account too.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    externalId: string;
                    provider: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Whether a link of this person was removed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            removed: boolean;
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
                        delivered: components["schemas"]["__schema67"][];
                        payload: components["schemas"]["__schema56"];
                        uses: components["schemas"]["__schema66"];
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
                            findings: components["schemas"]["__schema437"][];
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
                                changed_at: components["schemas"]["__schema325"];
                                corrected: boolean;
                                disputed: boolean;
                                earlier: components["schemas"]["__schema326"];
                                id: components["schemas"]["__schema278"];
                                label: components["schemas"]["__schema279"];
                                last_used: components["schemas"]["__schema325"] | null;
                                learned_at: components["schemas"]["__schema325"];
                                source: components["schemas"]["__schema324"];
                                /** @enum {string} */
                                trust: "yours" | "connected" | "outside" | "worked_out";
                                trust_label: components["schemas"]["__schema279"];
                                value: components["schemas"]["__schema323"];
                                version: components["schemas"]["__schema278"];
                            }[];
                            time_zone: components["schemas"]["__schema279"];
                        } | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
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
                            label: components["schemas"]["__schema279"];
                            versions: {
                                at: components["schemas"]["__schema325"];
                                current: boolean;
                                source: components["schemas"]["__schema324"];
                                value: components["schemas"]["__schema323"];
                            }[];
                        } | components["schemas"]["__schema262"];
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
                                created_at: components["schemas"]["__schema325"];
                                id: components["schemas"]["__schema278"];
                                label: components["schemas"]["__schema279"];
                            }[];
                        } | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
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
                                audience: components["schemas"]["__schema421"];
                                current: components["schemas"]["__schema430"];
                                domain_key: components["schemas"]["__schema419"];
                                head_revision: components["schemas"]["__schema420"];
                                hidden: components["schemas"]["__schema434"];
                                id: components["schemas"]["__schema380"];
                                key: components["schemas"]["__schema433"];
                                space_id: components["schemas"]["__schema432"];
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
                                audience: components["schemas"]["__schema421"];
                                domain_key: components["schemas"]["__schema419"];
                                head_revision: components["schemas"]["__schema420"];
                                hidden: components["schemas"]["__schema434"];
                                id: components["schemas"]["__schema380"];
                                key: components["schemas"]["__schema433"];
                                space_id: components["schemas"]["__schema432"];
                            };
                            revisions: components["schemas"]["__schema430"][];
                        };
                    };
                };
                /** @description No such claim */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                                alternative: components["schemas"]["__schema425"];
                                /** @enum {string} */
                                audience: "private" | "space" | "public";
                                claim_id: string;
                                head: components["schemas"]["__schema425"];
                                id: components["schemas"]["__schema435"];
                                key: components["schemas"]["__schema315"];
                                question_id: components["schemas"]["__schema435"] | null;
                                recorded_at: components["schemas"]["__schema189"];
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
                        claim_id: components["schemas"]["__schema46"];
                        content: string;
                        expected_revision: components["schemas"]["__schema64"];
                        idempotency_key: components["schemas"]["__schema63"];
                        text: string;
                        valid_from: components["schemas"]["__schema54"];
                        /** @default null */
                        valid_until?: components["schemas"]["__schema54"] | null;
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
                        "application/json": components["schemas"]["__schema430"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                                created_at: components["schemas"]["__schema325"];
                                id: components["schemas"]["__schema278"];
                                items: {
                                    at: components["schemas"]["__schema325"];
                                    belief_id: components["schemas"]["__schema278"];
                                    /** @enum {string} */
                                    change: "learned" | "changed" | "corrected";
                                    current: boolean;
                                    label: components["schemas"]["__schema279"];
                                    previous: components["schemas"]["__schema323"] | null;
                                    value: components["schemas"]["__schema323"];
                                    version: components["schemas"]["__schema278"] | null;
                                }[];
                                seen_at: components["schemas"]["__schema325"] | null;
                                title: components["schemas"]["__schema279"];
                                week_of: components["schemas"]["__schema327"];
                                window_end: components["schemas"]["__schema325"];
                                window_start: components["schemas"]["__schema325"];
                            } | null;
                            next_at: components["schemas"]["__schema325"];
                        } | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
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
                            filename: components["schemas"]["__schema279"];
                            /** @enum {string} */
                            format: "json" | "markdown";
                        } | components["schemas"]["__schema262"];
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
                        claim_id?: components["schemas"]["__schema46"];
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
                        "application/json": components["schemas"]["__schema431"];
                    };
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
                            imported: components["schemas"]["__schema326"];
                            notes: components["schemas"]["__schema279"][];
                            skipped: components["schemas"]["__schema326"];
                        } | components["schemas"]["__schema262"];
                    };
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
                            items: components["schemas"]["__schema319"][];
                            next?: components["schemas"]["__schema256"] | null;
                        } | components["schemas"]["__schema262"];
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
                        key: components["schemas"]["__schema21"];
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
                            item: components["schemas"]["__schema319"];
                        } | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
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
                            reasons: components["schemas"]["__schema257"][];
                            used_at: components["schemas"]["__schema260"] | null;
                        } | components["schemas"]["__schema262"];
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
                                affected: components["schemas"]["__schema441"][];
                                changed_handle: components["schemas"]["__schema425"];
                                created_at: components["schemas"]["__schema189"];
                                id: components["schemas"]["__schema435"];
                                job_id: string;
                                key: components["schemas"]["__schema315"] | null;
                                new_value: components["schemas"]["__schema440"];
                                old_value: components["schemas"]["__schema440"];
                                replacement_handle: components["schemas"]["__schema425"] | null;
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
    "/memory/notes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /memory/notes
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
                            notes: {
                                chat: {
                                    id: components["schemas"]["__schema256"];
                                    title: string;
                                } | null;
                                created: components["schemas"]["__schema260"];
                                id: components["schemas"]["__schema256"];
                                text: string;
                            }[];
                        } | components["schemas"]["__schema262"];
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
    "/memory/notes/{id}": {
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
         * DELETE /memory/notes/{id}
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
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
                        output_id: components["schemas"]["__schema65"];
                        output_version: components["schemas"]["__schema65"];
                        uses: components["schemas"]["__schema66"];
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
                            output_id: components["schemas"]["__schema435"];
                            output_version: components["schemas"]["__schema435"];
                            unknown_handles: components["schemas"]["__schema436"][];
                        };
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                                because: components["schemas"]["__schema425"][];
                                created_at: components["schemas"]["__schema189"];
                                id: components["schemas"]["__schema435"];
                                if_ignored: string;
                                key: components["schemas"]["__schema315"];
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
                        at?: components["schemas"]["__schema54"];
                        job_id?: string;
                        /** @default 10 */
                        limit?: components["schemas"]["__schema64"];
                        /** @default 2000 */
                        max_tokens?: components["schemas"]["__schema64"];
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
                                authoritative_revision: components["schemas"]["__schema422"];
                                indexed_revision: components["schemas"]["__schema422"];
                                /** @enum {string} */
                                reason: "ready" | "index_lag" | "budget" | "timeout" | "index_failure" | "restore_pending" | "public_compartment" | "withheld" | "dense_unavailable";
                                supplemented: components["schemas"]["__schema422"];
                                truncated: boolean;
                            };
                            /** @default [] */
                            disputed_keys: components["schemas"]["__schema315"][];
                            index_generation: components["schemas"]["__schema422"] | null;
                            items: {
                                claim_id: components["schemas"]["__schema380"];
                                content: string;
                                /** @default false */
                                disputed: boolean;
                                domain_key: components["schemas"]["__schema419"];
                                excerpts: string[];
                                factual_status: components["schemas"]["__schema427"];
                                handle: components["schemas"]["__schema425"];
                                /** @default null */
                                key: components["schemas"]["__schema315"] | null;
                                kind: components["schemas"]["__schema426"];
                                /** @default inferred */
                                origin_trust: components["schemas"]["__schema423"];
                                recorded_at: components["schemas"]["__schema189"];
                                revision: components["schemas"]["__schema420"];
                                sources: components["schemas"]["__schema429"][];
                                status: components["schemas"]["__schema428"];
                                superseded_at: components["schemas"]["__schema189"] | null;
                                valid_from: components["schemas"]["__schema189"];
                                valid_until: components["schemas"]["__schema189"] | null;
                            }[];
                            recipe: components["schemas"]["__schema419"];
                            snapshot: components["schemas"]["__schema424"] | null;
                            /** @enum {string} */
                            status: "complete" | "degraded" | "unavailable";
                            token_budget: {
                                /** @enum {string} */
                                counter: "utf8-bytes-upper-bound-v1" | "utf8-bytes-quarter-v1";
                                limit: components["schemas"]["__schema420"];
                                used: components["schemas"]["__schema422"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                                reason: "key_not_in_registry" | "span_not_verbatim" | "span_outside_segment" | "value_not_in_evidence" | "date_not_parseable" | "value_not_well_formed" | "confidence_is_not_a_status" | "checked_status_requires_tier0" | "invalid_shape" | "blocked_by_person" | "unsupported_attribution" | "change_set_refused";
                                recorded_at: components["schemas"]["__schema189"];
                                work_id: components["schemas"]["__schema435"];
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
                    "application/json": components["schemas"]["__schema22"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema330"] | components["schemas"]["__schema262"];
                    };
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
                    "application/json": components["schemas"]["__schema22"];
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
                            label: components["schemas"]["__schema279"];
                            skipped: components["schemas"]["__schema279"][];
                            steps: components["schemas"]["__schema329"][];
                        } | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema330"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema320"] | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema320"] | components["schemas"]["__schema262"];
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
                        event_at: components["schemas"]["__schema54"];
                        source_identity: components["schemas"]["__schema63"];
                        /** @enum {string} */
                        source_type: "message" | "document" | "observation" | "receipt" | "assistant";
                        source_version: components["schemas"]["__schema63"];
                        stream: components["schemas"]["__schema63"];
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
                            committed_sequence: components["schemas"]["__schema420"];
                            duplicate: boolean;
                            source: components["schemas"]["__schema417"];
                        };
                    };
                };
                /** @description Invalid evidence */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            source: components["schemas"]["__schema417"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema431"];
                    };
                };
                /** @description No such source */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                                    at: components["schemas"]["__schema325"];
                                    belief_id: components["schemas"]["__schema278"];
                                    /** @enum {string} */
                                    change: "learned" | "changed" | "corrected" | "restored" | "removed";
                                    label: components["schemas"]["__schema279"];
                                    previous: components["schemas"]["__schema323"] | null;
                                    value: components["schemas"]["__schema323"] | null;
                                }[];
                                day: components["schemas"]["__schema327"];
                                label: components["schemas"]["__schema279"];
                                rewinds: components["schemas"]["__schema328"][];
                            }[];
                            time_zone: components["schemas"]["__schema279"];
                        } | components["schemas"]["__schema262"];
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
                        handles: components["schemas"]["__schema66"];
                        payload: components["schemas"]["__schema56"];
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
                            fields: components["schemas"]["__schema438"][];
                            minimum_trust: components["schemas"]["__schema423"];
                            unresolved: components["schemas"]["__schema439"][];
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
                        "application/json": components["schemas"]["__schema450"];
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
                            reaction: components["schemas"]["__schema449"];
                        };
                    };
                };
                /** @description No such message */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description That event is not a message */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema528"];
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
                    "application/json": components["schemas"]["__schema126"];
                };
            };
            responses: {
                /** @description Open `authorize_url` in the browser */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema529"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No OAuth client, no public address to return to, or no master key */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema530"];
                    };
                };
                /** @description No sign-in by that id for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                    provider: components["schemas"]["__schema158"];
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
                        "application/json": components["schemas"]["__schema659"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                    provider: components["schemas"]["__schema158"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description `device` shows a code to enter at the provider; `browser` returns an address to open, after which the address the browser was sent back to is pasted into complete. Left out, the provider’s first method. */
                        method?: components["schemas"]["__schema159"];
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
                            expires_at: components["schemas"]["__schema189"];
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
                            expires_at: components["schemas"]["__schema189"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The provider could not be reached or refused the request */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                    provider: components["schemas"]["__schema158"];
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
                        "application/json": components["schemas"]["__schema659"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                    provider: components["schemas"]["__schema158"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description For a browser sign-in: the whole address the provider sent the browser back to. Its state must match the sign-in it completes. */
                        callback_url?: components["schemas"]["__schema160"];
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
                        "application/json": components["schemas"]["__schema659"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No unfinished sign-in by that id */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The provider could not be reached or refused the code */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            providers: components["schemas"]["__schema659"][];
                        };
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set, so nothing can be sealed */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema644"];
                    };
                };
                /** @description Not signed in */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        provider: components["schemas"]["__schema154"];
                        /** @description Whether this model reads images. Left out or null, Melete’s model catalog decides; set it for a model the catalog does not know. */
                        supports_vision?: components["schemas"]["__schema155"];
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
                        "application/json": components["schemas"]["__schema644"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The provider has no key or sign-in yet */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema644"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                    provider: components["schemas"]["__schema151"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        api_key: string;
                        /** @description Required for, and only for, the OpenAI-compatible endpoint */
                        base_url?: components["schemas"]["__schema153"];
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
                        "application/json": components["schemas"]["__schema644"];
                    };
                };
                /** @description Invalid key or endpoint address */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The server environment already sets this provider’s key */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set, so the key cannot be sealed */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                    provider: components["schemas"]["__schema151"];
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
                        "application/json": components["schemas"]["__schema644"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-settings/secondary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Choose this account’s secondary model
         * @description A second model for cheaper work beside the primary. It applies to work in the owner’s spaces from the next call, as `secondary.uses` says. The person’s own messages stay on the primary, and the action reviewer never uses it. The provider must already have a key or a sign-in.
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
                        provider: components["schemas"]["__schema154"];
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
                        "application/json": components["schemas"]["__schema644"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The provider has no key or sign-in yet */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        post?: never;
        /** Remove this account’s secondary model, so all its work uses the primary */
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
                        "application/json": components["schemas"]["__schema644"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-settings/secondary/uses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Choose which of this account’s work runs on the secondary model
         * @description Each kind left out keeps its setting. The choice is kept while no secondary model is set, and applies once one is.
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
                        scheduled?: components["schemas"]["__schema157"];
                        side_tasks?: components["schemas"]["__schema157"];
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
                        "application/json": components["schemas"]["__schema644"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        api_key?: components["schemas"]["__schema152"];
                        base_url?: components["schemas"]["__schema153"];
                        provider: components["schemas"]["__schema151"];
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
                            models: components["schemas"]["__schema657"][];
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
                            status: components["schemas"]["__schema658"] | null;
                        };
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/model-settings/vision": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Say whether the model in use reads images
         * @description Applies to the model in use, for the next attempt. Null hands it back to Melete’s list. The model, and whether it was chosen here or is the server’s default, do not change.
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
                        /** @description The model in use, as the page showed it; a different one is refused */
                        provider: string;
                        /** @description Whether this model reads images. Null hands it back to Melete’s list. Neither changes the model in use or where it came from. */
                        supports_vision: components["schemas"]["__schema156"] | null;
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
                        "application/json": components["schemas"]["__schema644"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The model in use has changed since the page loaded */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/needs-you": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What needs the signed-in person, ranked
         * @description New mail and calendar changes from the accounts the person connected, as sorted by a small model into needs you, for your information, or ignore, together with what Melete noticed on its own. Only items that need the person are listed, most pressing first; ones the person dismissed are left out. Sorting only labels: it never makes anything urgent, starts work or sends anything. Reads only.
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
                /** @description What needs the person, and how many items went unsorted today */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["__schema608"][];
                            unsorted: number;
                            unsorted_reason: ("kept_private" | "limit_reached" | "failed" | "off") | null;
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
    "/needs-you/{id}/ack": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark a sorted item as seen
         * @description For items whose `source` is `triage`. Something Melete noticed on its own is acknowledged through its own situation routes.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sorted item id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The item, now seen */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema609"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/needs-you/{id}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Dismiss a sorted item: it leaves the list
         * @description For items whose `source` is `triage`. The item is not shown again.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sorted item id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The item, now dismissed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema609"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/needs-you/{id}/source": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Attach a sorted item’s source to a new chat
         * @description Writes the message’s headers, or the calendar change’s fields, into a text file in the signed-in space, for "Handle it" to send with its message. The message itself names only the item’s source handle; the file reaches the agent as untrusted data. An item from another space is refused.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sorted item id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The attached file */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema577"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The item came from another space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            notifications: components["schemas"]["__schema416"][];
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
                        "application/json": components["schemas"]["__schema416"];
                    };
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
                        "application/json": components["schemas"]["__schema416"];
                    };
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
                    client_id: components["schemas"]["__schema119"];
                    code_challenge: components["schemas"]["__schema121"];
                    code_challenge_method: components["schemas"]["__schema122"];
                    redirect_uri: components["schemas"]["__schema120"];
                    resource?: components["schemas"]["__schema125"];
                    response_type: components["schemas"]["__schema118"];
                    scope?: components["schemas"]["__schema124"];
                    state?: components["schemas"]["__schema123"];
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
                        client_id: components["schemas"]["__schema119"];
                        code_challenge: components["schemas"]["__schema121"];
                        code_challenge_method: components["schemas"]["__schema122"];
                        consent: string;
                        /** @enum {string} */
                        decision: "allow" | "deny";
                        redirect_uri: components["schemas"]["__schema120"];
                        resource?: components["schemas"]["__schema125"];
                        response_type: components["schemas"]["__schema118"];
                        scope?: components["schemas"]["__schema124"];
                        state?: components["schemas"]["__schema123"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        redirect_uris: components["schemas"]["__schema117"][];
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
                        "application/json": components["schemas"]["__schema526"];
                    };
                };
                /** @description Too many registrations from this address, or too many waiting for a person to allow them */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema526"];
                    };
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
                        "application/json": components["schemas"]["__schema526"];
                    };
                };
                /** @description The client is not registered */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema526"];
                    };
                };
                /** @description Too many requests from this address */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema526"];
                    };
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
                            operations: components["schemas"]["__schema414"][];
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
                        version: components["schemas"]["__schema55"];
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
                        "application/json": components["schemas"]["__schema414"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        due_at: components["schemas"]["__schema54"];
                        version: components["schemas"]["__schema55"];
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
                        "application/json": components["schemas"]["__schema414"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        result: components["schemas"]["__schema56"];
                        version: components["schemas"]["__schema55"];
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
                        "application/json": components["schemas"]["__schema414"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /password-reset
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/password-reset/consume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /password-reset/consume
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
                        new_password: components["schemas"]["__schema27"];
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/people": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** People on this installation who can be added to a room */
        get: {
            parameters: {
                query?: {
                    query?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description People */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            people: {
                                display_name: string;
                                /** Format: email */
                                email: string;
                                id: components["schemas"]["__schema358"];
                            }[];
                        };
                    };
                };
                /** @description Only a person can look up people */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                            handoffs?: components["schemas"]["__schema289"][];
                            permissions: components["schemas"]["__schema280"][];
                        } | components["schemas"]["__schema262"];
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
                            expires_at: components["schemas"]["__schema19"];
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
                            rule: components["schemas"]["__schema291"] | null;
                            /** @constant */
                            status: "ok";
                        } | components["schemas"]["__schema262"];
                    };
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
                            plans: components["schemas"]["__schema331"][];
                        } | components["schemas"]["__schema262"];
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
                        milestones: components["schemas"]["__schema23"][];
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
                        "application/json": components["schemas"]["__schema332"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema332"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /**
         * DELETE /plans/{id}
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
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
                        "application/json": components["schemas"]["__schema263"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema332"] | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema262"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such plugin */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The plugin is already added to this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/previews/{token}/": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The page a previewed server answers at its root
         * @description Forwarded to the port the process declared, at its computer's own address, and nowhere else. No session is read and none is sent on: the token in the path is the whole authorisation, checked again on every request. Every response carries `Content-Security-Policy: sandbox ...`, so the page runs with an opaque origin. Only reads are forwarded, with no connection upgrade. A browser asking for it as a page of its own, rather than in a frame, is refused.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The preview token */
                    token: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description What the server answered */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/octet-stream": string;
                    };
                };
                /** @description A live connection was asked for */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Opened as a page of its own rather than framed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description An unknown, expired or ended preview */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The server did not answer, answered too much, or sent the page elsewhere */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/previews/{token}/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A page or file from a previewed server
         * @description Forwarded to the port the process declared, at its computer's own address, and nowhere else. No session is read and none is sent on: the token in the path is the whole authorisation, checked again on every request. Every response carries `Content-Security-Policy: sandbox ...`, so the page runs with an opaque origin. Only reads are forwarded, with no connection upgrade. A browser asking for it as a page of its own, rather than in a frame, is refused.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The path on the server */
                    path: string;
                    /** @description The preview token */
                    token: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description What the server answered */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/octet-stream": string;
                    };
                };
                /** @description A live connection was asked for */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Opened as a page of its own rather than framed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description An unknown, expired or ended preview */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The server did not answer, answered too much, or sent the page elsewhere */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                                created_at: components["schemas"]["__schema189"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Email already registered */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/privacy/local-model/check": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /privacy/local-model/check
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
                        api_key?: string;
                        /** Format: uri */
                        base_url?: string;
                        model?: string;
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
                            message: string;
                            models: components["schemas"]["__schema349"][];
                            ok: boolean;
                        } | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/privacy/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /privacy/preview
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
                        agent_id?: string;
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
                            details: {
                                category: components["schemas"]["PrivacyCategory"];
                                end: number;
                                placeholder: string;
                                start: number;
                            }[];
                            route: components["schemas"]["PrivacyRoute"];
                            sensitive: components["schemas"]["SensitiveTopic"] | null;
                            sent: string;
                        } | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/privacy/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /privacy/settings
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
                        "application/json": components["schemas"]["__schema346"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        /**
         * PUT /privacy/settings
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
                        add_known_values?: components["schemas"]["__schema29"][];
                        enabled?: components["schemas"]["PrivacyCategory"][];
                        local_detection?: boolean;
                        local_model?: {
                            api_key?: string | null;
                            /** Format: uri */
                            base_url: string;
                            model: string;
                        } | null;
                        model_on_device?: boolean;
                        private_agent_ids?: components["schemas"]["__schema28"][];
                        private_space?: boolean;
                        remove_known_values?: components["schemas"]["__schema30"][];
                        screenshots_own_computer?: boolean;
                        screenshots_paired_devices?: boolean;
                        sensitive_topics?: components["schemas"]["SensitiveTopic"][];
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
                        "application/json": components["schemas"]["__schema346"] | components["schemas"]["__schema262"];
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
                            procedures: components["schemas"]["__schema203"][];
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
                        "application/json": components["schemas"]["__schema219"];
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
                        "application/json": components["schemas"]["__schema202"];
                    };
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
                        "application/json": components["schemas"]["__schema202"];
                    };
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
                        "application/json": components["schemas"]["__schema219"];
                    };
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
                        "application/json": components["schemas"]["__schema202"];
                    };
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
                        "application/json": components["schemas"]["__schema202"];
                    };
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
                        "application/json": components["schemas"]["__schema202"];
                    };
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
                        "application/json": components["schemas"]["__schema333"] | components["schemas"]["__schema262"];
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
                        onboarded?: boolean;
                        time_zone: string;
                        time_zone_confirmed?: boolean;
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
                        "application/json": components["schemas"]["__schema333"] | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema193"];
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
                        "application/json": components["schemas"]["__schema193"];
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
                            subscriptions: components["schemas"]["__schema188"][];
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
                        "application/json": components["schemas"]["__schema190"];
                    };
                };
                /** @description Not a push service this installation sends to, or keys a browser does not subscribe with */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Push is not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema190"];
                    };
                };
                /** @description No such subscription for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                            questions: components["schemas"]["__schema410"][];
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
                            error?: components["schemas"]["__schema192"];
                            job: components["schemas"]["__schema384"] | null;
                            question: components["schemas"]["__schema410"];
                            receipt: components["schemas"]["__schema407"] | null;
                        };
                    };
                };
                /** @description The question is no longer open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            questions: components["schemas"]["__schema284"][];
                        } | components["schemas"]["__schema262"];
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
                    } | {
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
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
                            receipt: components["schemas"]["__schema275"];
                        } | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
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
                            obligations: components["schemas"]["__schema415"][];
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
                        "application/json": components["schemas"]["__schema415"];
                    };
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
                    "Idempotency-Key"?: components["schemas"]["__schema35"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema47"];
                };
            };
            responses: {
                /** @description A retried submission whose first status was not recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description Accepted, or the same key and input submitted again */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"] | components["schemas"]["__schema191"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"] | components["schemas"]["__schema191"];
                    };
                };
                /** @description No such space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema383"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The rooms the signed-in person is in */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Rooms */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            rooms: {
                                created_at: components["schemas"]["__schema189"];
                                id: components["schemas"]["__schema351"];
                                my_role: components["schemas"]["__schema354"];
                                name: components["schemas"]["__schema352"];
                                purpose: components["schemas"]["__schema353"];
                                unread: components["schemas"]["__schema355"];
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        /**
         * Make a room; its maker owns it
         * @description A room is a shared space where several people talk to one agent. The agent acts as the room, never as any one person, and reads only what the room has.
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
                        name: string;
                        purpose?: string;
                    };
                };
            };
            responses: {
                /** @description The new room */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema356"];
                    };
                };
                /** @description Only a person can make a room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A room, its people and how it works */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The room */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema356"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/rooms/{id}/approvals/{approvalId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Answer one of a room's permissions
         * @description Only the people the room's rule names may answer: the person who asked (the default), any member who is not a guest, or the room's owners. The answer names the exact content and the card it answers; if either changed, it is refused. The answer is recorded as the person's.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    approvalId: string;
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        option: "allow_once";
                        payload_hash: components["schemas"]["__schema44"];
                        version: components["schemas"]["__schema44"];
                    } | {
                        /** @constant */
                        option: "deny";
                        payload_hash: components["schemas"]["__schema44"];
                        version: components["schemas"]["__schema44"];
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
                            decided_by: components["schemas"]["__schema362"];
                            /** @enum {string} */
                            option: "allow_once" | "deny";
                            /** @constant */
                            status: "ok";
                        };
                    };
                };
                /** @description The room's rule does not name this person */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description What it asks for changed, it was withdrawn, or someone already answered it (the message says who, and how) */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The connections in a room's space
         * @description A connection marked `room` serves the room's requests; one marked `owner` serves only the owner's own work there.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
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
                            connections: components["schemas"]["__schema378"][];
                        };
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/rooms/{id}/connections/{connectionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Let a connection serve the room's requests, or keep it to the owner
         * @description Owners only. Work under way in the room starts again, and permissions waiting in it are withdrawn.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    connectionId: string;
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        shared_use: "owner" | "room";
                    };
                };
            };
            responses: {
                /** @description The connection */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            connection: components["schemas"]["__schema378"];
                        };
                    };
                };
                /** @description Only an owner of the room changes this */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/rooms/{id}/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A room's guest invites, open and used */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Invites */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            invites: components["schemas"]["__schema360"][];
                        };
                    };
                };
                /** @description Only an owner of the room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Invite a guest into a room
         * @description Makes a link that works once, for the number of days given (30 by default), which is also how long the guest stays. The owner sends it themselves. It uses the installation's public address (`MELETE_PUBLIC_URL`) when one is set; the path works on its sign-in page either way. A guest reads and posts only in the rooms they were invited to, asks the agent where the room allows it, never answers a permission, and has no people list and no work of their own.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: email */
                        email: string;
                        expires_in_days?: number;
                    };
                };
            };
            responses: {
                /** @description The invite, with its link shown once */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            invite: components["schemas"]["__schema360"];
                            link: string | null;
                            path: string;
                        };
                    };
                };
                /** @description Only an owner of the room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description That email belongs to someone with a full account, or is in the room */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/invites/{inviteId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Withdraw an invite before it is used */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    inviteId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Withdrawn */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            invite: components["schemas"]["__schema360"];
                        };
                    };
                };
                /** @description Only an owner of the room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such invite in this room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The invite was already used */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add a person to a room
         * @description Who can read the room changes, so work under way in it starts again with the new people.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
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
                /** @description The new member */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            member: components["schemas"]["__schema357"];
                        };
                    };
                };
                /** @description Only an owner of the room adds people */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/members/{principalId}": {
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
         * Remove someone from a room, or leave it
         * @description Their access ends at once, including any thread they have open. What they said stays in the room.
         */
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
                /** @description Removed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            removed: components["schemas"]["__schema358"];
                        };
                    };
                };
                /** @description Only an owner removes someone else; the owner cannot be removed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/memory": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * What the room's agent remembers, with whose words each detail rests on
         * @description Details people said in the room, and details people shared into it from their own memory. The agent reads nothing else of anyone's memory.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Room memory */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                can_forget: boolean;
                                claim_id: components["schemas"]["__schema380"];
                                content: string;
                                key: string | null;
                                label: string;
                                recorded_at: components["schemas"]["__schema189"];
                                said_by: components["schemas"]["__schema362"][];
                            }[];
                            shares: components["schemas"]["__schema381"][];
                        };
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/rooms/{id}/memory/{claimId}/forget": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Forget a detail from the room's memory
         * @description An owner of the room forgets any detail; anyone else only a detail from their own words. Forgetting holds across a restore from an older backup.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    claimId: string;
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Forgotten */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            forgotten: components["schemas"]["__schema380"];
                        };
                    };
                };
                /** @description Only an owner of the room, or the person whose words it rests on */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/messages/{messageId}": {
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
         * Delete your own message
         * @description Its words leave the thread, the request it asked, and the room's memory, and stay gone after a restore from an older backup. Work under way in the thread starts again without them.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    messageId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The message, with no words */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            message: components["schemas"]["__schema365"];
                        };
                    };
                };
                /** @description Only the person who wrote it */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * How a room works
         * @description Who decides the permissions its requests ask for, when its agent answers, whether guests may ask, and the room's hourly limits.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The settings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema377"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        /**
         * Change how a room works
         * @description Owners only. Settings left out stay as they are. Who may answer a permission is checked when the answer is given, so a new rule covers the permissions already waiting.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        agent_turns?: components["schemas"]["__schema40"];
                        approvers?: components["schemas"]["__schema38"];
                        guests_may_ask?: components["schemas"]["__schema41"];
                        requests_per_hour?: components["schemas"]["__schema42"];
                        requests_per_person_hour?: components["schemas"]["__schema43"];
                        team_account_approvers?: components["schemas"]["__schema39"];
                    };
                };
            };
            responses: {
                /** @description The settings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema377"];
                    };
                };
                /** @description A person cannot ask more often than the whole room */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Only an owner of the room changes how it works */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/rooms/{id}/presence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Say the signed-in person is looking at the room
         * @description Display only: who may read a room is decided by membership, not presence.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Who is here now */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            present: components["schemas"]["__schema358"][];
                        };
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/requests/{jobId}/computers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The computers one of the room's requests is using
         * @description Everyone in the room may watch them through `/sandbox/sessions/{id}/live`; only the room's owners take one over.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Computers */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SandboxComputerList"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/rooms/{id}/requests/{jobId}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Stop what the agent is doing for one request */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The request */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            request: components["schemas"]["__schema366"];
                        };
                    };
                };
                /** @description Only the person who asked, or an owner of the room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/shares": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Share a detail from your own memory into a room
         * @description A reference, not a copy: the room reads the current value, and forgetting it in your own memory takes it out of the room at once. Members-only shares stay out of the agent's work while a guest is in the room.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        claim_id: components["schemas"]["__schema46"];
                        members_only?: boolean;
                    };
                };
            };
            responses: {
                /** @description Already shared */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema382"];
                    };
                };
                /** @description Shared */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema382"];
                    };
                };
                /** @description Guests share nothing into a room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such detail in your own memory */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The detail came from a private conversation and stays yours */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/shares/{shareId}": {
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
         * Withdraw a shared detail from a room
         * @description The person who shared it, or an owner of the room.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    shareId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Withdrawn */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            withdrawn: components["schemas"]["__schema361"];
                        };
                    };
                };
                /** @description Only the person who shared it, or an owner of the room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/threads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A room's threads, most recently active first */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Threads */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            threads: components["schemas"]["__schema363"][];
                        };
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Start a thread with its first message
         * @description With `ask_agent`, or a message that names the agent, the first message asks the agent.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Room id */
                    id: components["schemas"]["__schema31"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        ask_agent?: boolean;
                        submission_id: components["schemas"]["__schema35"];
                        text: components["schemas"]["__schema34"];
                        title?: string;
                    };
                };
            };
            responses: {
                /** @description The thread and its first message */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema364"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The submission ID belongs to a different message */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/rooms/{id}/threads/{threadId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** A thread: every message with its author, and each request the agent was asked */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: components["schemas"]["__schema36"];
                    threadId: components["schemas"]["__schema37"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The thread */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            messages: components["schemas"]["__schema365"][];
                            requests: components["schemas"]["__schema366"][];
                            thread: components["schemas"]["__schema363"];
                        };
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/rooms/{id}/threads/{threadId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * A thread's live frames: messages and the agent's work, in order
         * @description With `Accept: text/event-stream`, a stream of frames; otherwise one page. Each frame carries `seq`; resume with `Last-Event-ID`. The stream closes once the reader is no longer in the room.
         */
        get: {
            parameters: {
                query?: {
                    after?: string;
                };
                header?: {
                    "Last-Event-ID"?: string;
                };
                path: {
                    id: string;
                    threadId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Frames */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            frames: ({
                                /** @constant */
                                kind: "message";
                                message: components["schemas"]["__schema365"];
                                seq: number;
                            } | {
                                event: components["schemas"]["__schema266"];
                                /** @constant */
                                kind: "request";
                                request_job_id: components["schemas"]["__schema361"];
                                seq: number;
                            })[];
                            next_cursor: number;
                        };
                        /**
                         * @example id: 42
                         *     event: message
                         *     data: {"seq":42,"kind":"message"}
                         */
                        "text/event-stream": string;
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/rooms/{id}/threads/{threadId}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Post a message in a thread
         * @description A message asks the agent when it names the agent, or follows straight on from the agent's answer to its author. An ask reaches the asker's own request, never anyone else's; while another request in the thread is under way, it waits its turn. A message that does not ask starts nothing.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: components["schemas"]["__schema36"];
                    threadId: components["schemas"]["__schema37"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        submission_id: components["schemas"]["__schema35"];
                        text: components["schemas"]["__schema34"];
                    };
                };
            };
            responses: {
                /** @description The message */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema364"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The thread is closed, or the submission ID belongs to a different message */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            rules: components["schemas"]["__schema291"][];
                        } | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /runs
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: {
                    conversation_id?: string;
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
                            runs: components["schemas"]["__schema339"][];
                        } | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        put?: never;
        /**
         * POST /runs
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
                        agent_id?: string;
                        check_result?: boolean;
                        done_when?: string;
                        goal: string;
                        limit?: components["schemas"]["__schema26"];
                        metric?: {
                            /** @enum {string} */
                            direction: "higher" | "lower";
                            name: string;
                        };
                        repeat?: {
                            cron: string;
                            timezone?: string;
                        };
                        title?: string;
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
                        "application/json": components["schemas"]["__schema342"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /runs/{id}
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
                        "application/json": components["schemas"]["__schema342"] | components["schemas"]["__schema262"];
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
    "/runs/{id}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /runs/{id}/export
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
                            markdown: string;
                        } | components["schemas"]["__schema262"];
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
    "/runs/{id}/limit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * PUT /runs/{id}/limit
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        put: {
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
                        check_result?: boolean;
                        limit?: components["schemas"]["__schema26"] | null;
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
                        "application/json": components["schemas"]["__schema342"] | components["schemas"]["__schema262"];
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
    "/runs/{id}/message": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /runs/{id}/message
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
                        "application/json": components["schemas"]["__schema342"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/runs/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /runs/{id}/pause
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
                        "application/json": components["schemas"]["__schema342"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/runs/{id}/record": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /runs/{id}/record
         * @description Uses the authenticated session space. Unsupported capabilities return not_available with a plain reason.
         */
        get: {
            parameters: {
                query?: {
                    after?: string;
                };
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
                            entries: {
                                body: string;
                                created_at: components["schemas"]["__schema189"];
                                data: {
                                    [key: string]: unknown;
                                };
                                id: string;
                                /** @enum {string} */
                                kind: "plan" | "note" | "finding" | "decision" | "experiment" | "report" | "checkpoint" | "step_started" | "step_finished" | "proposed" | "check" | "finished";
                                step_id: string | null;
                                title: string;
                            }[];
                            next_cursor: string | null;
                        } | components["schemas"]["__schema262"];
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
    "/runs/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /runs/{id}/resume
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
                        "application/json": components["schemas"]["__schema342"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/runs/{id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * POST /runs/{id}/stop
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
                        "application/json": components["schemas"]["__schema342"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandbox/computers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Find the computer in a job's sandbox
         * @description The desktop of the sandbox the job's agent works in, with who is driving it. Only the person who owns the job may ask. Empty when the job has used no sandbox with a desktop.
         */
        get: {
            parameters: {
                query: {
                    job_id: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The job's computers */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SandboxComputerList"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/sandbox/processes/{id}/output": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The end of what a background process printed */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Process id from the conversation's computer view */
                    id: components["schemas"]["__schema176"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Its latest output */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProcessOutput"];
                    };
                };
                /** @description No such process, or this person cannot watch its computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/sandbox/processes/{id}/previews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open a preview of the server a background process runs
         * @description Returns where the page the process serves on its declared port loads for this person. Only the person whose job started the process may open one, from a browser session, while the process runs and listens on that port. The preview belongs to that session and ends when it signs out, when the process stops, or after half an hour; ask again for a new one while it is shown. It is meant to be framed by Melete with `sandbox="allow-scripts allow-forms allow-downloads"`: the page runs with an opaque origin, holds no Melete session, and reaches nothing but that port of that computer. A computer with no network cannot be previewed.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Process id from the conversation's computer view */
                    id: components["schemas"]["__schema176"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description A preview */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProcessPreview"];
                    };
                };
                /** @description Asked with an assistant token rather than a browser session */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such process, or this person cannot watch its computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The process is not running, serves no port, or cannot be reached */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandbox/processes/{id}/stop": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stop a background process
         * @description Sends TERM to the process and everything it started, then KILL after ten seconds. Only the person whose job started it may stop it.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Process id from the conversation's computer view */
                    id: components["schemas"]["__schema176"];
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description How it stands now */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProcessStopped"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such process, or this person cannot watch its computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandbox/sessions/{id}/handback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Give the computer back to the agent
         * @description Increments the control epoch again. The job stays parked until the person answers it. With `control_epoch`, control changes only from that epoch; otherwise 409.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sandbox session id from GET /sandbox/computers */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["SandboxControlRequest"];
                };
            };
            responses: {
                /** @description The agent holds control */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SandboxControlResponse"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandbox/sessions/{id}/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Open a live view of the sandbox's desktop
         * @description Watching is allowed while the agent drives; input only while the person holds control. The live id is held in memory and bound to this principal, session, control epoch and address. One view per computer.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sandbox session id from GET /sandbox/computers */
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The live view could not open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandbox/sessions/{id}/live/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Close the live view of the desktop
         * @description Ends the view; control stays where it is.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sandbox session id from GET /sandbox/computers */
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The live view was already closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandbox/sessions/{id}/live/frames": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Follow the desktop as Server-Sent Events
         * @description JPEG frames of the whole desktop, paced and written through, never stored, and the end of the view. Only frames carry an id; a reconnect is repainted from the screen as it is now.
         */
        get: {
            parameters: {
                query: {
                    /** @description Frame sequence to resume after, for clients without Last-Event-ID */
                    after?: components["schemas"]["__schema138"];
                    /** @description The live id this view was opened with */
                    live_id: components["schemas"]["__schema127"];
                };
                header?: never;
                path: {
                    /** @description Sandbox session id from GET /sandbox/computers */
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/sandbox/sessions/{id}/live/input": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send a person's input to the desktop
         * @description Pointer, wheel, key and text events at the live viewport, dispatched in order. Refused unless the person holds control under the epoch the view was opened with.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sandbox session id from GET /sandbox/computers */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema129"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The person does not hold control */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sandbox/sessions/{id}/takeover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Take control of the computer from the agent
         * @description Requires the owner session and same-origin protection. The control epoch is incremented and the job is parked waiting for input before this answers; every computer action the agent planned before is refused from then on. With `control_epoch`, control changes only from that epoch; otherwise 409. Control returns to the agent after 30 minutes with no live view open.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Sandbox session id from GET /sandbox/computers */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["SandboxControlRequest"];
                };
            };
            responses: {
                /** @description The person holds control */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SandboxControlResponse"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/screenshots/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Retrieve the picture a screenshot took, for its own conversation
         * @description A succeeded screenshot of the agent’s own computer or of a paired computer, for the person whose work it was. Served only while it is the picture the receipt recorded.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The screenshot action, from a trail entry */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description The picture */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "image/png": string;
                    };
                };
                /** @description A session is required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such screenshot for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                                conversation_id: components["schemas"]["__schema256"] | null;
                                id: components["schemas"]["__schema256"];
                                /** @enum {string} */
                                kind: "conversation" | "plan" | "task" | "event" | "connection" | "action";
                                meta: string;
                                title: components["schemas"]["__schema257"];
                            }[];
                        } | components["schemas"]["__schema262"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                    "application/json": components["schemas"]["__schema85"];
                };
            };
            responses: {
                /** @description The owner, signed in */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema444"];
                    };
                };
                /** @description An email and a password of 8 to 1024 characters are required */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The request came from another origin */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The owner is already set up */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No database is configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema262"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema262"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema262"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/situations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** What Melete noticed that may need this person, still live, newest first */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Situations */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            situations: components["schemas"]["__schema195"][];
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
    "/situations/{id}/ack": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Say the person saw it; nothing more is pushed about it */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Situation id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Seen */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema196"];
                    };
                };
                /** @description No such situation for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/situations/{id}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Say it was not useful; it is closed */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Situation id */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Dismissed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema196"];
                    };
                };
                /** @description No such situation for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                                    keeps_memory?: boolean;
                                    /** @default 400 */
                                    max_tokens: number;
                                    name: string;
                                    /** @default [] */
                                    tools: string[];
                                    triggers: components["schemas"]["__schema576"][];
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
                        "application/json": components["schemas"]["__schema411"];
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
    "/space/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /space/members
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
                            members: {
                                email: string;
                                principal_id: components["schemas"]["__schema256"];
                                /** @enum {string} */
                                role: "owner" | "member";
                                you: boolean;
                            }[];
                            space: {
                                id: components["schemas"]["__schema256"];
                                /** @enum {string} */
                                kind: "personal" | "shared";
                                name: components["schemas"]["__schema257"];
                                /** @enum {string} */
                                role: "owner" | "member";
                            };
                        } | components["schemas"]["__schema262"];
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
    "/space/members/{id}": {
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
         * DELETE /space/members/{id}
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
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
                        "application/json": {
                            spaces: components["schemas"]["Space"][];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Space owner required, or no such space */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The browser worker uses this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                            membership: components["schemas"]["__schema236"];
                        };
                    };
                };
                /** @description Space owner required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            membership: components["schemas"]["__schema236"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                            companies: components["schemas"]["__schema601"][];
                            currency: components["schemas"]["__schema603"];
                            items: components["schemas"]["__schema604"][];
                            totals: {
                                data_holders: number;
                                monthly_spend_minor: components["schemas"]["__schema602"];
                                owed_to_you_minor: components["schemas"]["__schema602"];
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
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No mailbox is connected to this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            note?: components["schemas"]["__schema600"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description No such scan in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                            receipt: components["schemas"]["__schema407"];
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
                            tasks: components["schemas"]["__schema334"][];
                        } | components["schemas"]["__schema262"];
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
                    "application/json": components["schemas"]["__schema24"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema336"] | components["schemas"]["__schema262"];
                    };
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
                        "application/json": components["schemas"]["__schema293"] | components["schemas"]["__schema262"];
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
                    "application/json": components["schemas"]["__schema24"];
                };
            };
            responses: {
                /** @description Outcome or unavailable capability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema336"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Model spending today and this month, the limits, and any notice
         * @description Every model call counts: agent turns, routines and background work, memory reads, voice asides and reviews. Dollars are estimates from the price table. Past a `reached` notice, new model calls are refused until the period resets. Days and months are UTC.
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
                /** @description Usage */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @description The part of this account’s calls that ran in the background */
                            background?: components["schemas"]["__schema630"];
                            /** @description Background dollars per active person-day over the last seven finished days; only for the installation’s owner */
                            background_per_person_day?: components["schemas"]["__schema641"];
                            /** @description This month’s calls for this account, by purpose and class */
                            by_purpose?: components["schemas"]["__schema635"];
                            /** @description This month’s calls for this account, by tier */
                            by_tier?: components["schemas"]["__schema639"];
                            day_resets_at: components["schemas"]["__schema189"];
                            /** @description This account’s last 30 UTC days, oldest first */
                            days?: components["schemas"]["__schema640"];
                            /** @description Every account’s calls; only for the installation’s owner */
                            installation: components["schemas"]["__schema628"] | null;
                            limits: {
                                /** @description This account’s limits on background calls alone; its own messages never count here */
                                background?: components["schemas"]["__schema631"];
                                /** @description Only for the installation’s owner */
                                installation: components["schemas"]["__schema631"] | null;
                                person: components["schemas"]["__schema631"];
                            };
                            /** @description This month’s calls for this account, by the model that served them */
                            models: components["schemas"]["__schema642"][];
                            month_resets_at: components["schemas"]["__schema189"];
                            month_start: components["schemas"]["__schema189"];
                            notice: {
                                /**
                                 * @description `warning`: a limit is past the notice level (80% by default). `reached`: new model calls are refused until it resets.
                                 * @enum {string}
                                 */
                                level: "warning" | "reached";
                                /** @description The sentence the person reads */
                                message: string;
                                /** @enum {string} */
                                period: "day" | "month";
                                resets_at: components["schemas"]["__schema189"];
                                /** @enum {string} */
                                scope: "person" | "installation";
                            } | null;
                            /** @description This account’s own model calls */
                            person: components["schemas"]["__schema628"] | null;
                        };
                    };
                };
                /** @description Not signed in */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
    "/voice": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Which voice features this installation has
         * @description Both are false until the operator sets a speech provider key. Push-to-talk needs a provider that transcribes; voice mode needs ElevenLabs. Given a conversation, or the agent a new chat will have, `off_reason` says why voice is off there: the space or agent is marked private, or the conversation is about a sensitive topic.
         */
        get: {
            parameters: {
                query?: {
                    agent_id?: components["schemas"]["__schema162"];
                    conversation_id?: components["schemas"]["__schema161"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Voice features and their limits */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            max_recording_bytes: number;
                            max_recording_seconds: number;
                            off_reason: string | null;
                            push_to_talk: boolean;
                            voice_mode: boolean;
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
    "/voice/transcriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Transcribe a push-to-talk clip
         * @description The body is the recording itself. The words come back for the person to review; nothing is sent, and the audio is not kept. A clip over two minutes or 5 MB is refused, and so is one past the person’s daily allowance.
         */
        post: {
            parameters: {
                query: {
                    agent_id?: components["schemas"]["__schema162"];
                    conversation_id?: components["schemas"]["__schema161"];
                    duration_ms: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "audio/mp4": string;
                    "audio/ogg": string;
                    "audio/wav": string;
                    "audio/webm": string;
                };
            };
            responses: {
                /** @description What was heard */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            language: string | null;
                            text: string;
                        };
                    };
                };
                /** @description Not a recording this service reads */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Voice is off in a private space, agent or sensitive conversation */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Voice is not set up on this installation, or no such conversation */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The recording is longer or larger than the limit */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The daily allowance for transcription is used up */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description The speech provider could not transcribe it */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
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
                    space_id?: components["schemas"]["__schema140"];
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
                            currency: components["schemas"]["__schema603"];
                            owed: components["schemas"]["__schema607"][];
                            owed_minor: components["schemas"]["__schema602"];
                            replies: components["schemas"]["__schema607"][];
                            scan: {
                                connected: boolean;
                                finished_at: components["schemas"]["__schema189"] | null;
                                space_id: string | null;
                                stale: boolean;
                                /** @enum {string} */
                                status: "none" | "running" | "done" | "failed";
                            };
                            top: components["schemas"]["__schema607"][];
                        };
                    };
                };
                /** @description This space is not accessible to the signed-in account */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Already finished, or no longer quotable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Chasing is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
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
                            evidence: components["schemas"]["__schema606"];
                            id: string;
                            job_id: string | null;
                            message_id: string;
                            principal_id: string;
                            sent_at: components["schemas"]["__schema189"];
                            space_id: string;
                            status: components["schemas"]["__schema605"];
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
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
                /** @description Stopping its chase is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema191"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/web/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * GET /web/settings
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
                        "application/json": components["schemas"]["WebReadStatus"] | components["schemas"]["__schema262"];
                    };
                };
            };
        };
        /**
         * PUT /web/settings
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
                        enabled: boolean;
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
                        "application/json": components["schemas"]["WebReadStatus"] | components["schemas"]["__schema262"];
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
        __schema16: components["schemas"]["__schema17"];
        __schema17: string;
        __schema18: components["schemas"]["__schema13"][];
        /** Format: date-time */
        __schema19: string;
        __schema20: {
            allowed_connection_ids: components["schemas"]["__schema13"][] | null;
            asks_before_acting: boolean;
            colour: string;
            eye_colour: string;
            /** Format: uri */
            face_image?: string;
            name: string;
            /** @default true */
            reads_memory?: boolean;
            role: string;
            standing_instruction: string;
            /** @enum {string} */
            surface: "rounded" | "blob" | "diamond" | "octagon" | "gear";
            tone: string;
            /** @default true */
            uses_computer?: boolean;
            /** @default true */
            writes_memory?: boolean;
        };
        __schema21: string;
        __schema22: {
            /** Format: date */
            day: string;
        } | {
            belief_id: string;
            /** Format: date-time */
            since: string;
        };
        __schema23: {
            assignee: {
                /** @constant */
                kind: "person";
            } | {
                agent_id: components["schemas"]["__schema13"];
                /** @constant */
                kind: "agent";
            };
            schedule_at?: components["schemas"]["__schema19"];
            title: components["schemas"]["__schema12"];
        };
        __schema24: {
            /** @default false */
            done?: boolean;
            due_at: components["schemas"]["__schema19"] | null;
            title: components["schemas"]["__schema12"];
        };
        __schema25: number;
        __schema26: {
            max_hours?: number;
            max_output_tokens?: number;
            max_shifts?: number;
        };
        __schema27: string;
        __schema28: string;
        __schema29: {
            category: components["schemas"]["PrivacyCategory"];
            label: string;
            value: string;
        };
        __schema30: string;
        /** @description Room id */
        __schema31: string;
        __schema32: string;
        __schema33: string;
        __schema34: string;
        __schema35: string;
        __schema36: string;
        __schema37: string;
        /** @enum {string} */
        __schema38: "requester" | "any_member" | "owners";
        /** @enum {string} */
        __schema39: "any_member" | "owners";
        /** @enum {string} */
        __schema40: "asked" | "every_message";
        __schema41: boolean;
        __schema42: number;
        __schema43: number;
        __schema44: string;
        __schema45: string;
        __schema46: string;
        __schema47: {
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
            importance?: components["schemas"]["__schema49"];
            learning?: components["schemas"]["__schema1"];
            objective: string;
            /** @default interactive */
            scheduling_class?: components["schemas"]["__schema48"];
            space_id: string;
            title: string;
            /** @default 3 */
            unread_threshold?: components["schemas"]["__schema50"];
        };
        /** @enum {string} */
        __schema48: "interactive" | "background" | "quiet";
        /** @enum {string} */
        __schema49: "routine" | "important";
        __schema50: number;
        __schema51: components["schemas"]["__schema48"];
        __schema52: components["schemas"]["__schema49"];
        __schema53: components["schemas"]["__schema50"];
        /** Format: date-time */
        __schema54: string;
        __schema55: number;
        __schema56: {
            [key: string]: components["schemas"]["__schema57"];
        };
        __schema57: (string | number | boolean | null) | components["schemas"]["__schema57"][] | {
            [key: string]: components["schemas"]["__schema57"];
        };
        __schema58: {
            attachments?: components["schemas"]["__schema61"];
            corrects?: components["schemas"]["__schema60"];
            text: components["schemas"]["__schema59"];
        };
        __schema59: string;
        __schema60: components["schemas"]["__schema17"];
        __schema61: components["schemas"]["__schema62"][];
        __schema62: string;
        __schema63: string;
        __schema64: number;
        __schema65: string;
        __schema66: components["schemas"]["__schema5"][];
        __schema67: {
            content: string;
            /** @default [] */
            excerpts?: components["schemas"]["__schema68"][];
            handle: components["schemas"]["__schema6"];
            /** @default null */
            key?: components["schemas"]["__schema21"] | null;
        };
        __schema68: string;
        __schema69: string;
        __schema70: string;
        __schema71: string;
        /** @enum {string} */
        __schema72: "private" | "space" | "public";
        /** @enum {string} */
        __schema73: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema74: "active" | "superseded" | "retracted" | "disputed";
        /** @enum {string} */
        __schema75: "high" | "medium" | "low";
        /** @enum {string} */
        __schema76: "user" | "agent" | "document" | "tool";
        __schema77: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote?: string;
            ref: string;
            /** @default null */
            sha256?: string | null;
        };
        /** Format: date */
        __schema78: string;
        /** @default null */
        __schema79: components["schemas"]["__schema78"] | null;
        /** @default [] */
        __schema80: components["schemas"]["__schema69"][];
        /** @default null */
        __schema81: components["schemas"]["__schema69"] | null;
        /** @default [] */
        __schema82: string[];
        /** @default [] */
        __schema83: components["schemas"]["__schema69"][];
        /** @constant */
        __schema84: 1;
        __schema85: {
            /** Format: email */
            email: string;
            password: string;
        };
        /** @default [] */
        __schema86: components["schemas"]["__schema87"][];
        __schema87: {
            field: string;
            /** @enum {string} */
            op: "eq" | "contains" | "matches" | "lt" | "gt" | "changed" | "before" | "after" | "older_than" | "absent";
            /** @default null */
            value?: string | number | boolean | null;
        };
        __schema88: components["schemas"]["__schema87"][];
        /** @default 0 */
        __schema89: number;
        /** @default 200 */
        __schema90: number;
        __schema91: ("job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "reasoning_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error")[];
        __schema92: {
            allowed_scopes: components["schemas"]["__schema94"];
            audience: components["schemas"]["__schema96"];
            id: components["schemas"]["__schema93"];
            tools: components["schemas"]["__schema97"];
            /** Format: uri */
            url: string;
        };
        __schema93: string;
        __schema94: components["schemas"]["__schema95"][];
        __schema95: string;
        /** @constant */
        __schema96: "owner";
        __schema97: components["schemas"]["__schema98"][];
        __schema98: {
            alias: string;
            /** @default write_external */
            effect_class?: components["schemas"]["EffectClass"];
            name: string;
            required_scopes: components["schemas"]["__schema95"][];
        };
        /** Format: uri */
        __schema99: string;
        __schema100: string;
        /** Format: uri */
        __schema101: string;
        /** @enum {string} */
        __schema102: "npx" | "uvx" | "image";
        __schema103: string;
        __schema104: string;
        /** @default [] */
        __schema105: components["schemas"]["__schema106"][];
        __schema106: string;
        /** @default [] */
        __schema107: components["schemas"]["__schema108"][];
        __schema108: "*" | string;
        /** @default [] */
        __schema109: components["schemas"]["__schema110"][];
        __schema110: {
            name: string;
            value: string;
        };
        __schema111: string;
        /** @enum {string} */
        __schema112: "github" | "aws" | "gitlab" | "npm";
        __schema113: string;
        __schema114: string;
        __schema115: string;
        __schema116: {
            client_id: string;
            client_secret?: string;
        };
        __schema117: string;
        /** @constant */
        __schema118: "code";
        __schema119: string;
        __schema120: string;
        __schema121: string;
        /** @constant */
        __schema122: "S256";
        __schema123: string;
        __schema124: string;
        __schema125: string;
        __schema126: {
            calendar_label?: string;
            mail_label?: string;
            space_id?: string;
        };
        __schema127: string;
        __schema128: string;
        __schema129: {
            ack_through: number;
            events: components["schemas"]["__schema130"][];
            live_id: components["schemas"]["__schema127"];
        };
        __schema130: {
            button: 0 | 1 | 2;
            clicks: 1 | 2 | 3;
            /** @enum {string} */
            k: "move" | "down" | "up";
            mods: components["schemas"]["__schema133"];
            x: components["schemas"]["__schema131"];
            y: components["schemas"]["__schema132"];
        } | {
            dx: components["schemas"]["__schema134"];
            dy: components["schemas"]["__schema134"];
            /** @constant */
            k: "wheel";
            mods: components["schemas"]["__schema133"];
            x: components["schemas"]["__schema131"];
            y: components["schemas"]["__schema132"];
        } | {
            code: string;
            down: boolean;
            /** @constant */
            k: "key";
            key: string;
            mods: components["schemas"]["__schema133"];
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
            points: components["schemas"]["__schema135"][];
        };
        __schema131: number;
        __schema132: number;
        __schema133: number;
        __schema134: number;
        __schema135: {
            id: number;
            x: components["schemas"]["__schema131"];
            y: components["schemas"]["__schema132"];
        };
        __schema136: string;
        __schema137: number;
        __schema138: string;
        __schema139: string;
        __schema140: string;
        __schema141: string;
        __schema142: string;
        __schema143: string;
        __schema144: string;
        __schema145: {
            height: number;
            pixel_ratio?: number;
            width: number;
        };
        /** @enum {string} */
        __schema146: "light" | "dark";
        __schema147: components["schemas"]["__schema148"][];
        __schema148: {
            at: components["schemas"]["__schema54"];
            message: string;
        };
        __schema149: components["schemas"]["__schema150"][];
        __schema150: {
            at: components["schemas"]["__schema54"];
            code: string | null;
            method: string;
            status: number | null;
            url: string;
        };
        /** @enum {string} */
        __schema151: "anthropic" | "openai" | "google" | "fireworks" | "openai-compatible";
        __schema152: string;
        /** @description The endpoint’s version prefix, for example https://models.example.net/v1 */
        __schema153: string;
        /** @enum {string} */
        __schema154: "anthropic" | "openai" | "google" | "fireworks" | "openai-compatible" | "chatgpt";
        __schema155: boolean | null;
        __schema156: boolean;
        /** @enum {string} */
        __schema157: "primary" | "secondary";
        /** @enum {string} */
        __schema158: "chatgpt" | "openai-compatible";
        /** @enum {string} */
        __schema159: "device" | "browser";
        __schema160: string;
        __schema161: string;
        __schema162: string;
        __schema163: {
            now: string | null;
            steps: components["schemas"]["__schema164"][];
        };
        __schema164: string;
        __schema165: boolean;
        __schema166: boolean;
        __schema167: boolean;
        __schema168: boolean;
        /** @default false */
        __schema169: boolean;
        __schema170: {
            name: string;
            path: string;
        };
        /** @description App id */
        __schema171: string;
        __schema172: {
            /** Format: email */
            email: string;
            /** @constant */
            kind: "principal";
            /**
             * @default view
             * @enum {string}
             */
            role?: "view" | "manage";
        } | {
            /** @constant */
            kind: "installation";
            /**
             * @default view
             * @constant
             */
            role?: "view";
        };
        __schema173: string;
        __schema174: string;
        __schema175: string;
        /** @description Process id from the conversation's computer view */
        __schema176: string;
        __schema177: string;
        __schema178: number;
        __schema179: string;
        __schema180: string;
        /** @enum {string} */
        __schema181: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema182: string | null;
        __schema183: {
            captured_at: components["schemas"]["__schema54"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema184: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema185: string | null;
        __schema186: {
            compression_count?: number;
            in_place?: boolean;
            used_fallback?: boolean;
        };
        __schema187: string;
        __schema188: {
            created_at: components["schemas"]["__schema189"];
            device_label: string;
            endpoint_hash: string;
            id: string;
            last_used_at: components["schemas"]["__schema189"] | null;
        };
        /** Format: date-time */
        __schema189: string;
        __schema190: {
            subscription: components["schemas"]["__schema188"];
        };
        __schema191: {
            error: components["schemas"]["__schema192"];
        };
        __schema192: {
            code: string;
            detail?: {
                [key: string]: unknown;
            };
            message: string;
        };
        __schema193: {
            settings: {
                batch_minutes: number;
                daily_cap: number;
                decisions: boolean;
                quiet_hours: {
                    from: components["schemas"]["__schema194"];
                    time_zone: string;
                    until: components["schemas"]["__schema194"];
                };
                settled: boolean;
                weekly_summary: boolean;
            };
        };
        __schema194: string;
        __schema195: {
            acked_at: components["schemas"]["__schema189"] | null;
            because: string[];
            created_at: components["schemas"]["__schema189"];
            deadline_at: components["schemas"]["__schema189"] | null;
            fired_at: components["schemas"]["__schema189"] | null;
            id: string;
            /** @enum {string} */
            kind: "meeting.changed" | "meeting.conflict" | "deadline.at_risk" | "reply.overdue";
            person_set: boolean;
            reason: string;
            /** @enum {string} */
            state: "open" | "routed" | "dismissed" | "resolved" | "expired";
            subject_key: string;
            title: string;
            updated_at: components["schemas"]["__schema189"];
            /** @enum {string} */
            urgency: "normal" | "soon" | "urgent";
        };
        __schema196: {
            situation: components["schemas"]["__schema195"];
        };
        __schema197: {
            actor: string;
            artifacts: components["schemas"]["__schema201"][];
            correctiveJobId?: string | null;
            createdAt: components["schemas"]["__schema189"];
            expiresAt: components["schemas"]["__schema189"];
            failureClass: string | null;
            generationStartedAt: components["schemas"]["__schema189"] | null;
            generationState: string;
            id: components["schemas"]["__schema198"];
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
            receipts: components["schemas"]["__schema201"][];
            restricted: boolean;
            scope: components["schemas"]["__schema199"];
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
        __schema198: string;
        __schema199: {
            app: components["schemas"]["__schema200"];
            app_version: components["schemas"]["__schema200"];
            /** @constant */
            audience: "private";
            /** @constant */
            role: "owner";
            task_family: components["schemas"]["__schema200"];
        };
        __schema200: string;
        __schema201: {
            [key: string]: unknown;
        };
        __schema202: {
            candidate: components["schemas"]["__schema203"];
        };
        __schema203: {
            body: string;
            bodyHash: string;
            canarySpaceId: string | null;
            /** @default {} */
            caseTemplates: {
                final_pool?: components["schemas"]["__schema218"][];
                validation?: components["schemas"]["__schema217"][];
            };
            change: components["schemas"]["__schema201"];
            /** @default [] */
            checks: ({
                kind: components["schemas"]["__schema207"];
                max?: components["schemas"]["__schema209"];
                min?: components["schemas"]["__schema208"];
            } | {
                kind: components["schemas"]["__schema210"];
                max?: components["schemas"]["__schema212"];
                min?: components["schemas"]["__schema211"];
            } | {
                kind: components["schemas"]["__schema213"];
                max?: components["schemas"]["__schema215"];
                min?: components["schemas"]["__schema214"];
            } | {
                /** @constant */
                kind: "required_phrase";
                phrase: components["schemas"]["__schema216"];
            } | {
                /** @constant */
                kind: "forbidden_phrase";
                phrase: components["schemas"]["__schema216"];
            } | {
                /** @enum {string} */
                form: "bullets" | "numbered" | "paragraphs" | "table" | "json";
                /** @constant */
                kind: "output_format";
            } | {
                headings: components["schemas"]["__schema216"][];
                /** @constant */
                kind: "required_sections";
                /** @default true */
                ordered: boolean;
            } | {
                /** @enum {string} */
                direction: "ascending" | "descending";
                key: components["schemas"]["__schema216"];
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
                action_kind: components["schemas"]["__schema216"];
                /** @constant */
                kind: "action_kind_absent";
            } | {
                action_kind: components["schemas"]["__schema216"];
                /** @constant */
                kind: "action_kind_max";
                max: number;
            } | {
                action_kind: components["schemas"]["__schema216"];
                /** @constant */
                kind: "action_kind_present";
                /** @default 1 */
                min: number;
            })[];
            compatibleModels: string[];
            createdAt: components["schemas"]["__schema189"];
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
            episodeId: components["schemas"]["__schema198"] | null;
            /** @default [] */
            evidence: components["schemas"]["__schema206"][];
            /** @default null */
            holdReason: string | null;
            id: components["schemas"]["__schema204"];
            knownRisk: string;
            /**
             * @default owner_correction
             * @enum {string}
             */
            origin: "owner_correction" | "engine_staged";
            /** @default null */
            pausedAt: components["schemas"]["__schema189"] | null;
            predictedBenefit: string;
            /**
             * @default {
             *       "scope": "private",
             *       "principal_id": null
             *     }
             */
            promotion: {
                approved_at?: components["schemas"]["__schema189"];
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
            removedAt: components["schemas"]["__schema189"] | null;
            scope: components["schemas"]["__schema199"];
            selectedEvaluationId: string | null;
            /** @default null */
            skillName: string | null;
            spaceId: string;
            state: components["schemas"]["__schema205"];
            tests: string[];
            /** @default [] */
            triggers: {
                evidence: components["schemas"]["__schema206"];
                phrase: string;
            }[];
            version: number;
        };
        __schema204: string;
        /** @enum {string} */
        __schema205: "candidate" | "evaluated" | "enabled_canary" | "active" | "superseded" | "reverted";
        __schema206: {
            end: number;
            /** @constant */
            fallback?: "verbatim";
            quote: string;
            /** @enum {string} */
            source: "intervention" | "objective";
            start: number;
        };
        /** @constant */
        __schema207: "word_count";
        __schema208: number;
        __schema209: number;
        /** @constant */
        __schema210: "char_count";
        __schema211: number;
        __schema212: number;
        /** @constant */
        __schema213: "line_count";
        __schema214: number;
        __schema215: number;
        __schema216: string;
        __schema217: string;
        __schema218: string;
        __schema219: {
            candidate: components["schemas"]["__schema203"];
            evaluations: {
                budget: components["schemas"]["__schema201"];
                createdAt: components["schemas"]["__schema189"];
                id: string;
                passed: boolean;
                phase: string;
                selectedAt: components["schemas"]["__schema189"] | null;
            }[];
            history: {
                actor: string;
                candidateId: components["schemas"]["__schema204"];
                createdAt: components["schemas"]["__schema189"];
                fromState: string | null;
                id: string;
                reason: string;
                toState: components["schemas"]["__schema205"];
            }[];
        };
        __schema220: {
            actions: ("try" | "pause" | "resume" | "remove" | "share" | "approve" | "edit" | "stop")[];
            applies_when: string[];
            definition_hash: string;
            does: string[];
            expires_at: components["schemas"]["__schema189"] | null;
            expiring_soon: boolean;
            id: string;
            learned_at: components["schemas"]["__schema189"];
            name: string;
            reason: string | null;
            reason_code: string | null;
            shared: boolean;
            source: components["schemas"]["__schema221"];
            space_id: string;
            /** @enum {string} */
            state: "proposed" | "trial" | "active" | "paused" | "reverted";
        };
        /** @enum {string} */
        __schema221: "correction" | "engine";
        __schema222: {
            /** @enum {string} */
            action: "pause" | "resume" | "remove" | "keep" | "decline";
            created_at: components["schemas"]["__schema189"];
            id: string;
            item_id: string;
            name: string;
            source: components["schemas"]["__schema221"];
        };
        __schema223: {
            change: components["schemas"]["__schema222"] | null;
            item: components["schemas"]["__schema220"] | null;
        };
        __schema224: {
            answer: ("yes" | "no" | "change") | null;
            created_at: components["schemas"]["__schema189"];
            id: components["schemas"]["__schema225"];
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
            created_at: components["schemas"]["__schema189"];
            id: components["schemas"]["__schema225"];
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
        __schema225: string;
        __schema226: {
            skills: components["schemas"]["__schema227"][];
        };
        __schema227: {
            body: string;
            created_at: components["schemas"]["__schema189"];
            definition_hash: string;
            description: string;
            id: components["schemas"]["__schema204"];
            name: string;
            reason: string | null;
            source_job_id: string | null;
            /** @enum {string} */
            state: "live" | "held" | "paused" | "rejected" | "reverted";
        };
        __schema228: {
            body_sha256: string | null;
            created_at: components["schemas"]["__schema189"];
            id: string;
            name: string;
            reason: string;
            source_skill_id: components["schemas"]["__schema204"] | null;
            space_id: string | null;
        };
        __schema229: {
            skill: components["schemas"]["__schema227"];
        };
        __schema230: string;
        __schema231: string;
        /** @enum {string} */
        __schema232: "personal" | "shared";
        /** @enum {string} */
        __schema233: "owner" | "space";
        __schema234: string | null;
        __schema235: string;
        __schema236: {
            generation: number;
            principal_id: string;
            revoked_at: components["schemas"]["__schema189"] | null;
            /** @enum {string} */
            role: "owner" | "member" | "guest";
            space_id: string;
        };
        __schema237: string;
        __schema238: string;
        __schema239: string;
        /** @enum {string} */
        __schema240: "removed" | "emptied";
        /** @enum {string} */
        __schema241: "pending" | "running" | "blocked" | "cleaning" | "complete";
        /** @enum {string} */
        __schema242: "fence" | "sessions" | "journal" | "sandboxes" | "browser" | "runtime" | "files" | "operational" | "principals" | "memory" | "verify" | "space";
        __schema243: {
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
        __schema244: string | null;
        __schema245: components["schemas"]["__schema189"] | null;
        __schema246: string;
        __schema247: string;
        __schema248: {
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
        __schema249: {
            label: string;
            provider: string;
        }[];
        __schema250: string[];
        __schema251: string;
        __schema252: string;
        __schema253: string[];
        __schema254: string[];
        __schema255: {
            agent_id: components["schemas"]["__schema256"];
            automation_id?: components["schemas"]["__schema256"];
            composer: components["schemas"]["__schema259"];
            created_at: components["schemas"]["__schema260"];
            id: components["schemas"]["__schema256"];
            plan_id: components["schemas"]["__schema256"] | null;
            progress?: {
                current: string | null;
                steps_done: components["schemas"]["__schema261"];
            };
            status: components["schemas"]["__schema258"];
            title: components["schemas"]["__schema257"];
            updated_at: components["schemas"]["__schema260"];
        };
        __schema256: string;
        __schema257: string;
        /** @enum {string} */
        __schema258: "idle" | "queued" | "working" | "streaming" | "needs_you" | "paused" | "done" | "failed" | "stopped";
        /** @enum {string} */
        __schema259: "send" | "pause" | "resume" | "stop";
        /** Format: date-time */
        __schema260: string;
        __schema261: number;
        __schema262: {
            reason: components["schemas"]["__schema257"];
            /** @constant */
            status: "not_available";
        };
        __schema263: {
            conversation: components["schemas"]["__schema255"];
        };
        __schema264: {
            agent_id: components["schemas"]["__schema256"];
            answer: string;
            attachments?: components["schemas"]["__schema265"][];
            conversation_id: components["schemas"]["__schema256"];
            created_at: components["schemas"]["__schema260"];
            delivery: ("sending" | "queued_offline" | "failed_retry") | null;
            id: components["schemas"]["__schema256"];
            status: components["schemas"]["__schema258"];
            text: string;
        };
        __schema265: {
            created_at: string;
            has_preview: boolean;
            has_text: boolean;
            id: string;
            /** @enum {string} */
            kind: "image" | "pdf" | "docx" | "xlsx" | "csv" | "text";
            media_type: string;
            name: string;
            pages: number | null;
            size: number;
        };
        __schema266: {
            conversation_id: components["schemas"]["__schema256"];
            created_at: components["schemas"]["__schema260"];
            item: ({
                text: string;
                /** @constant */
                type: "say";
            } | {
                label: components["schemas"]["__schema257"];
                meta: string;
                sources: {
                    app: components["schemas"]["__schema257"];
                    connection_id: components["schemas"]["__schema256"];
                    /** @enum {string} */
                    kind: "event" | "message" | "draft" | "file" | "page" | "task";
                    title: components["schemas"]["__schema257"];
                    url?: components["schemas"]["__schema267"];
                }[];
                tool?: components["schemas"]["__schema268"];
                /** @constant */
                type: "action";
            } | {
                text: components["schemas"]["__schema257"];
                /** @constant */
                type: "note";
            } | {
                apps: components["schemas"]["__schema257"][];
                elapsed_ms: components["schemas"]["__schema261"];
                source_count: components["schemas"]["__schema261"];
                summary: components["schemas"]["__schema257"];
                /** @constant */
                type: "done";
            }) | {
                /** @constant */
                restart?: true;
                text: string;
                /** @constant */
                type: "text_delta";
            } | {
                text: string;
                /** @constant */
                type: "reasoning";
            } | {
                card: components["schemas"]["__schema272"];
                /** @constant */
                type: "card";
            } | {
                receipt: components["schemas"]["__schema275"];
                /** @constant */
                type: "receipt";
            } | {
                permission: components["schemas"]["__schema280"];
                /** @constant */
                type: "permission";
            } | {
                question: components["schemas"]["__schema284"];
                /** @constant */
                type: "question";
            } | {
                decision: {
                    answer: string | null;
                    decided_at: components["schemas"]["__schema260"];
                    id: components["schemas"]["__schema256"];
                    /** @enum {string} */
                    kind: "permission" | "question";
                    /** @enum {string} */
                    outcome: "allow_once" | "always" | "deny" | "replaced" | "answered" | "withdrawn" | "outdated";
                };
                /** @constant */
                type: "decision";
            } | {
                composer: components["schemas"]["__schema259"];
                status: components["schemas"]["__schema258"];
                /** @constant */
                type: "status";
            } | {
                tool: components["schemas"]["__schema268"];
                /** @constant */
                type: "tool";
            } | {
                /** @constant */
                type: "compacted";
            };
            seq: components["schemas"]["__schema261"];
            turn_id: components["schemas"]["__schema256"] | null;
        };
        /** Format: uri */
        __schema267: string;
        __schema268: {
            detail: {
                id: components["schemas"]["__schema256"];
                /** @enum {string} */
                type: "artifact" | "permission" | "receipt" | "memory" | "page" | "screenshot";
                url?: components["schemas"]["__schema267"];
            } | null;
            ended_at: components["schemas"]["__schema260"] | null;
            /** @enum {string} */
            failure?: "error" | "refused" | "declined";
            id: components["schemas"]["__schema256"];
            input_excerpt?: components["schemas"]["__schema271"];
            input_summary: components["schemas"]["__schema269"] | null;
            /** @enum {string} */
            kind: "connector" | "web" | "file" | "artifact" | "browser" | "sandbox" | "skill" | "memory_recall" | "memory_write" | "memory_correct" | "memory_forget" | "model" | "retry" | "tool";
            output_excerpt?: components["schemas"]["__schema271"];
            output_summary: components["schemas"]["__schema269"] | null;
            parent: components["schemas"]["__schema256"] | null;
            started_at: components["schemas"]["__schema260"];
            /** @enum {string} */
            status: "running" | "done" | "failed" | "needs_approval" | "unknown";
            title: string;
        };
        __schema269: {
            quote?: {
                from: components["schemas"]["__schema270"];
                text: string;
            };
            text: string;
        };
        /** @enum {string} */
        __schema270: "page" | "message" | "file" | "event" | "app" | "request";
        __schema271: {
            from: components["schemas"]["__schema270"];
            more: boolean;
            text: string;
        };
        __schema272: {
            facts: components["schemas"]["__schema273"][];
            id: components["schemas"]["__schema256"];
            image?: components["schemas"]["__schema267"];
            meta: string;
            primary_action: components["schemas"]["__schema274"] | null;
            secondary_actions: components["schemas"]["__schema274"][];
            source_connection: components["schemas"]["__schema256"] | null;
            title: components["schemas"]["__schema257"];
        };
        __schema273: {
            label: components["schemas"]["__schema257"];
            value: components["schemas"]["__schema257"];
        };
        __schema274: {
            handle: components["schemas"]["__schema256"];
            /** @enum {string} */
            kind: "open" | "download" | "send" | "undo";
            label: components["schemas"]["__schema257"];
            url?: components["schemas"]["__schema267"];
        };
        __schema275: {
            because?: components["schemas"]["__schema277"][];
            id: components["schemas"]["__schema256"];
            reverses?: components["schemas"]["__schema256"];
            review?: components["schemas"]["__schema276"];
            sending_until?: components["schemas"]["__schema260"];
            undo?: {
                handle: components["schemas"]["__schema256"];
                valid_until: components["schemas"]["__schema260"];
            };
            what: components["schemas"]["__schema257"];
            when: components["schemas"]["__schema260"];
            where: components["schemas"]["__schema257"];
        };
        __schema276: {
            /** @enum {string} */
            by: "policy" | "reviewer";
            /** @enum {string} */
            outcome: "auto_approved" | "escalated";
            reason: components["schemas"]["__schema257"];
            reviewed_at: components["schemas"]["__schema260"];
            risk: ("low" | "medium" | "high") | null;
        };
        __schema277: {
            /** @enum {string} */
            basis: "declared" | "recalled" | "rule";
            id: components["schemas"]["__schema278"];
            /** @enum {string} */
            kind: "belief" | "rule";
            label: components["schemas"]["__schema279"];
        };
        __schema278: string;
        __schema279: string;
        __schema280: {
            because?: components["schemas"]["__schema277"][];
            conversation_id: components["schemas"]["__schema256"];
            created_at: components["schemas"]["__schema260"];
            draft?: components["schemas"]["__schema282"];
            eligible_approvers?: components["schemas"]["__schema283"][];
            file?: {
                bytes: components["schemas"]["__schema261"];
                content: string;
                path: components["schemas"]["__schema257"];
                truncated: boolean;
            };
            id: components["schemas"]["__schema256"];
            options: components["schemas"]["__schema281"][];
            payload_hash?: components["schemas"]["__schema256"];
            preview: components["schemas"]["__schema272"] | null;
            requested_by?: components["schemas"]["__schema283"];
            review?: components["schemas"]["__schema276"];
            version: components["schemas"]["__schema256"];
            what: components["schemas"]["__schema257"];
            why: components["schemas"]["__schema257"][];
        };
        /** @enum {string} */
        __schema281: "allow_once" | "always" | "deny";
        __schema282: {
            bcc?: components["schemas"]["__schema257"][];
            body: string;
            cc?: components["schemas"]["__schema257"][];
            /** @enum {string} */
            channel: "email" | "message";
            connection_id: components["schemas"]["__schema256"];
            id: components["schemas"]["__schema256"];
            recipient: components["schemas"]["__schema257"];
            /** @enum {string} */
            status: "draft" | "awaiting_permission" | "denied" | "sent" | "discarded";
            subject?: string;
        };
        __schema283: {
            display_name: string;
            principal_id: components["schemas"]["__schema256"];
        };
        __schema284: {
            conversation_id: components["schemas"]["__schema256"] | null;
            created_at: components["schemas"]["__schema260"];
            free_text: boolean;
            id: components["schemas"]["__schema256"];
            if_ignored: components["schemas"]["__schema257"];
            options: components["schemas"]["__schema285"];
            text: components["schemas"]["__schema257"];
            why: components["schemas"]["__schema257"][];
        };
        __schema285: components["schemas"]["__schema286"][];
        __schema286: {
            id: components["schemas"]["__schema256"];
            label: components["schemas"]["__schema257"];
        };
        __schema287: {
            command: string;
            exit_code: number | null;
            id: components["schemas"]["__schema256"];
            output: string;
            started_at: components["schemas"]["__schema260"];
            /** @enum {string} */
            status: "running" | "done" | "failed" | "unknown";
        };
        __schema288: {
            can_preview: boolean;
            id: components["schemas"]["__schema256"];
            last_line: string | null;
            name: string;
            port: number | null;
            started_at: components["schemas"]["__schema260"];
            /** @enum {string} */
            state: "starting" | "running" | "exited" | "stopped" | "expired" | "lost";
        };
        __schema289: {
            asked_by: {
                display_name: string;
                principal_id: string;
            } | null;
            created_at: components["schemas"]["__schema189"];
            decided_at: components["schemas"]["__schema189"] | null;
            expires_at: components["schemas"]["__schema189"];
            id: string;
            job_id: string | null;
            result: string | null;
            result_hash: components["schemas"]["__schema290"] | null;
            room: {
                id: string;
                name: string;
            };
            /** @enum {string} */
            state: "pending" | "accepted" | "declined" | "running" | "settled" | "shared" | "kept" | "expired";
            task: string;
            task_hash: components["schemas"]["__schema290"];
            thread_id: string;
        };
        __schema290: string;
        __schema291: {
            bounds: {
                count_cap: number;
                expires_at: components["schemas"]["__schema260"];
                reconsent_after_days: number;
            };
            connection_id: components["schemas"]["__schema256"];
            created_at: components["schemas"]["__schema260"];
            id: components["schemas"]["__schema256"];
            /** @enum {string} */
            kind: "send_message" | "create_event" | "change_event" | "delete_event" | "save_file" | "restore_file" | "discard_draft" | "push_branch";
            recipient_class: components["schemas"]["__schema257"];
            text: components["schemas"]["__schema257"];
            used: components["schemas"]["__schema261"];
        };
        __schema292: {
            reviewer_available: boolean;
            settings: {
                classes: {
                    app_changes: boolean;
                    apps: boolean;
                    calendar: boolean;
                    own_calendar: boolean;
                    sandbox: boolean;
                };
                /** @enum {string} */
                mode: "ask" | "auto_review";
            };
        };
        __schema293: {
            /** @constant */
            status: "ok";
        };
        __schema294: {
            allowed_connection_ids: components["schemas"]["__schema302"];
            asks_before_acting: components["schemas"]["__schema303"];
            colour: components["schemas"]["__schema297"];
            eye_colour: components["schemas"]["__schema299"];
            face_image?: components["schemas"]["__schema307"];
            fixed_reach: boolean;
            id: components["schemas"]["__schema256"];
            is_default: boolean;
            name: components["schemas"]["__schema295"];
            reads_memory: components["schemas"]["__schema305"];
            role: components["schemas"]["__schema296"];
            space_id: components["schemas"]["__schema256"];
            standing_instruction: components["schemas"]["__schema301"];
            surface: components["schemas"]["__schema298"];
            tone: components["schemas"]["__schema300"];
            usage: {
                conversations: components["schemas"]["__schema261"];
                last_used: components["schemas"]["__schema260"] | null;
                routines: components["schemas"]["__schema261"];
            };
            uses_computer: components["schemas"]["__schema304"];
            writes_memory: components["schemas"]["__schema306"];
        };
        __schema295: string;
        __schema296: string;
        __schema297: string;
        /** @enum {string} */
        __schema298: "rounded" | "blob" | "diamond" | "octagon" | "gear";
        __schema299: string;
        __schema300: string;
        __schema301: string;
        __schema302: components["schemas"]["__schema256"][] | null;
        __schema303: boolean;
        /** @default true */
        __schema304: boolean;
        /** @default true */
        __schema305: boolean;
        /** @default true */
        __schema306: boolean;
        __schema307: components["schemas"]["__schema267"];
        __schema308: {
            agent: components["schemas"]["__schema294"];
        };
        __schema309: string;
        __schema310: string;
        /** @enum {string} */
        __schema311: "mail" | "calendar" | "files" | "web" | "browser" | "computer" | "devices" | "mcp";
        __schema312: {
            kind: components["schemas"]["__schema311"];
            without: string;
        };
        __schema313: number;
        __schema314: {
            id: string;
            memory_key: components["schemas"]["__schema315"];
            placeholder: string;
            question: string;
        };
        __schema315: string;
        __schema316: string;
        __schema317: {
            /** @enum {string} */
            reach: "mail" | "calendar" | "files" | "web" | "browser" | "computer" | "memory";
            title: string;
        };
        __schema318: string;
        __schema319: {
            created: components["schemas"]["__schema260"];
            editable: boolean;
            id: components["schemas"]["__schema256"];
            key: components["schemas"]["__schema257"];
            last_used: components["schemas"]["__schema260"] | null;
            saved_by?: string;
            /** @enum {string} */
            source: "onboarding" | "conversation" | "inferred";
            value: string;
            version: components["schemas"]["__schema256"];
        };
        __schema320: {
            capture: boolean;
        };
        __schema321: boolean;
        __schema322: boolean;
        __schema323: string;
        __schema324: {
            at: components["schemas"]["__schema325"];
            /** @enum {string} */
            kind: "setup" | "chat" | "correction" | "import" | "email" | "calendar" | "contacts" | "connected" | "receipt" | "message" | "document" | "assistant" | "worked_out";
            link: {
                id: components["schemas"]["__schema278"];
                /** @enum {string} */
                kind: "conversation" | "receipt";
                label: components["schemas"]["__schema279"];
            } | null;
            text: components["schemas"]["__schema279"];
        };
        /** Format: date-time */
        __schema325: string;
        __schema326: number;
        /** Format: date */
        __schema327: string;
        __schema328: {
            created_at: components["schemas"]["__schema325"];
            id: components["schemas"]["__schema278"];
            label: components["schemas"]["__schema279"];
            skipped: components["schemas"]["__schema279"][];
            steps: components["schemas"]["__schema329"][];
            undone_at: components["schemas"]["__schema325"] | null;
        };
        __schema329: {
            belief_id: components["schemas"]["__schema278"];
            from: components["schemas"]["__schema323"] | null;
            label: components["schemas"]["__schema279"];
            to: components["schemas"]["__schema323"] | null;
        };
        __schema330: {
            rewind: components["schemas"]["__schema328"];
        };
        __schema331: {
            category: components["schemas"]["__schema257"];
            conversation_ids: components["schemas"]["__schema256"][];
            file_ids: components["schemas"]["__schema256"][];
            id: components["schemas"]["__schema256"];
            milestones: {
                assignee: {
                    /** @constant */
                    kind: "person";
                } | {
                    agent_id: components["schemas"]["__schema256"];
                    /** @constant */
                    kind: "agent";
                };
                done: boolean;
                id: components["schemas"]["__schema256"];
                output?: string | null;
                schedule_at?: components["schemas"]["__schema260"];
                status: components["schemas"]["__schema258"];
                title: components["schemas"]["__schema257"];
            }[];
            next_step: components["schemas"]["__schema257"] | null;
            progress_percent: number;
            title: components["schemas"]["__schema257"];
            updated_at: components["schemas"]["__schema260"];
        };
        __schema332: {
            plan: components["schemas"]["__schema331"];
        };
        __schema333: {
            profile: {
                day_hours: {
                    end: string;
                    start: string;
                };
                name: string;
                onboarded: boolean;
                sending_address: string | null;
                time_zone: string;
                time_zone_confirmed: boolean;
            };
        };
        __schema334: {
            created_at: components["schemas"]["__schema260"];
            /** @default false */
            done: boolean;
            due_at: components["schemas"]["__schema260"] | null;
            id: components["schemas"]["__schema256"];
            title: components["schemas"]["__schema257"];
            updated_at: components["schemas"]["__schema260"];
        };
        __schema335: {
            conversation_id: components["schemas"]["__schema256"] | null;
            finished_at: components["schemas"]["__schema260"] | null;
            id: components["schemas"]["__schema256"];
            reason: string | null;
            started_at: components["schemas"]["__schema260"];
            status: components["schemas"]["__schema258"];
            summary: string | null;
            turn_id: components["schemas"]["__schema256"] | null;
        };
        __schema336: {
            task: components["schemas"]["__schema334"];
        };
        __schema337: {
            conversation_id: components["schemas"]["__schema256"];
            enabled: boolean;
            ended: boolean;
            id: components["schemas"]["__schema256"];
            runs: components["schemas"]["__schema335"][];
            schedule: components["schemas"]["__schema257"];
            title: components["schemas"]["__schema257"];
        };
        __schema338: {
            automation: components["schemas"]["__schema337"];
        };
        __schema339: {
            agent_id: string | null;
            check: {
                enabled: boolean;
                gaps: string[];
                state: ("checking" | "passed" | "gaps" | "not_confirmed") | null;
            };
            conversation_id: string | null;
            done_when: string | null;
            experiments: {
                best: components["schemas"]["__schema341"] | null;
                count: number;
                recent: components["schemas"]["__schema341"][];
            };
            findings: number;
            finished_at: components["schemas"]["__schema189"] | null;
            goal: string;
            id: string;
            latest_report: {
                body: string;
                created_at: components["schemas"]["__schema189"];
                title: string;
            } | null;
            limit: {
                max_hours?: number;
                max_output_tokens?: number;
                max_shifts?: number;
            } | null;
            metric: {
                /** @enum {string} */
                direction: "higher" | "lower";
                name: string;
            } | null;
            next: string | null;
            next_shift_at: components["schemas"]["__schema189"] | null;
            plan: string | null;
            question: string | null;
            result: string | null;
            shifts: number;
            standing: {
                description: string;
                /** @enum {string} */
                kind: "schedule" | "event" | "watch";
                next_wake_at: components["schemas"]["__schema189"] | null;
            } | null;
            started_at: components["schemas"]["__schema189"];
            status: components["schemas"]["__schema340"];
            status_line: string;
            steps: {
                id: string;
                result: string | null;
                status: components["schemas"]["__schema340"];
                title: string;
            }[];
            title: string;
        };
        /** @enum {string} */
        __schema340: "working" | "waiting" | "needs_you" | "done" | "stopped" | "failed";
        __schema341: {
            checked: boolean;
            created_at: components["schemas"]["__schema189"];
            id: string;
            outcome: ("kept" | "discarded" | "failed") | null;
            title: string;
            value: number | null;
        };
        __schema342: {
            run: components["schemas"]["__schema339"];
        };
        __schema343: {
            connections: {
                /** @enum {string} */
                access: "read_only" | "draft_only" | "asks_before_acting";
                app: components["schemas"]["__schema257"];
                builtin?: boolean;
                id: components["schemas"]["__schema256"];
                label: components["schemas"]["__schema257"];
                /** @enum {string} */
                status: "available" | "connecting" | "connected" | "error";
                watching?: boolean;
            }[];
        };
        __schema344: {
            destination: string | null;
            happened_at: components["schemas"]["__schema260"];
            id: components["schemas"]["__schema256"];
            /** @enum {string} */
            outcome: "succeeded";
            reference: string | null;
            source: string;
            undo?: {
                valid_until: components["schemas"]["__schema260"];
            };
            undone_at?: components["schemas"]["__schema260"];
            what: components["schemas"]["__schema257"];
            where: components["schemas"]["__schema257"];
        };
        __schema345: {
            session: {
                id: components["schemas"]["__schema256"];
                preview_frame: components["schemas"]["__schema267"] | null;
                /** @enum {string} */
                status: "working" | "needs_you" | "done" | "stopped";
                task_label: components["schemas"]["__schema257"];
                url: components["schemas"]["__schema267"];
            };
        };
        __schema346: {
            enabled: components["schemas"]["PrivacyCategory"][];
            known_values: components["schemas"]["__schema348"][];
            local_detection: boolean;
            local_model: {
                /** Format: uri */
                base_url: string;
                has_key: boolean;
                model: string;
            } | null;
            model_address: string | null;
            model_address_local: boolean;
            model_on_device: boolean;
            private_agent_ids: components["schemas"]["__schema347"][];
            private_space: boolean;
            screenshots_own_computer: boolean;
            screenshots_paired_devices: boolean;
            sealed_vault: boolean;
            sensitive_topics: components["schemas"]["SensitiveTopic"][];
        };
        __schema347: string;
        __schema348: {
            category: components["schemas"]["PrivacyCategory"];
            hint: string;
            id: string;
            label: string;
        };
        __schema349: string;
        __schema350: {
            sensitive: components["schemas"]["SensitiveTopic"] | null;
            turns: {
                categories: {
                    category: components["schemas"]["PrivacyCategory"];
                    count: number;
                }[];
                protected: number;
                /** @enum {string} */
                route: "cloud" | "local" | "mixed" | "on_device";
                turn_id: string;
            }[];
        };
        __schema351: string;
        __schema352: string;
        __schema353: string | null;
        /** @enum {string} */
        __schema354: "owner" | "member" | "guest";
        __schema355: number;
        __schema356: {
            members: components["schemas"]["__schema357"][];
            policy: components["schemas"]["__schema359"];
            room: {
                agent_name: string;
                created_at: components["schemas"]["__schema189"];
                id: components["schemas"]["__schema351"];
                my_role: components["schemas"]["__schema354"];
                name: components["schemas"]["__schema352"];
                purpose: components["schemas"]["__schema353"];
                unread: components["schemas"]["__schema355"];
            };
        };
        __schema357: {
            display_name: string;
            /** Format: email */
            email?: string;
            expires_at?: components["schemas"]["__schema189"] | null;
            handle?: string;
            present: boolean;
            principal_id: components["schemas"]["__schema358"];
            role: components["schemas"]["__schema354"];
        };
        __schema358: string;
        __schema359: {
            /** @enum {string} */
            agent_turns: "asked" | "every_message";
            /** @enum {string} */
            approvers: "requester" | "any_member" | "owners";
            guests_may_ask: boolean;
            requests_per_hour?: number;
            requests_per_person_hour?: number;
            /** @enum {string} */
            team_account_approvers?: "any_member" | "owners";
        };
        __schema360: {
            accepted_at: components["schemas"]["__schema189"] | null;
            created_at: components["schemas"]["__schema189"];
            created_by: components["schemas"]["__schema362"];
            /** Format: email */
            email: string;
            expires_at: components["schemas"]["__schema189"];
            id: components["schemas"]["__schema361"];
            room_id: components["schemas"]["__schema351"];
            /** @enum {string} */
            state: "open" | "accepted" | "expired" | "withdrawn";
        };
        __schema361: string;
        __schema362: {
            display_name: string;
            principal_id: components["schemas"]["__schema358"];
        };
        __schema363: {
            archived_at: components["schemas"]["__schema189"] | null;
            created_at: components["schemas"]["__schema189"];
            created_by: components["schemas"]["__schema362"];
            id: components["schemas"]["__schema361"];
            last_activity_at: components["schemas"]["__schema189"];
            room_id: components["schemas"]["__schema351"];
            title: string;
        };
        __schema364: {
            message: components["schemas"]["__schema365"];
            request_job_id: components["schemas"]["__schema361"] | null;
            thread: components["schemas"]["__schema363"];
        };
        __schema365: {
            author: components["schemas"]["__schema362"];
            created_at: components["schemas"]["__schema189"];
            id: components["schemas"]["__schema361"];
            /** @enum {string} */
            kind: "person" | "handoff_result" | "system";
            mentions: string[];
            request_job_id: components["schemas"]["__schema361"] | null;
            /** @enum {string} */
            request_state: "none" | "pending" | "started";
            text: string | null;
            thread_id: components["schemas"]["__schema361"];
            via_agent: boolean;
        };
        __schema366: {
            cards: components["schemas"]["__schema272"][];
            decisions?: {
                approval_id: components["schemas"]["__schema361"];
                decided_at: components["schemas"]["__schema189"];
                decided_by: components["schemas"]["__schema362"] | null;
                /** @enum {string} */
                decision: "approved" | "denied";
            }[];
            job_id: components["schemas"]["__schema361"];
            permissions?: components["schemas"]["__schema280"][];
            receipts: components["schemas"]["__schema275"][];
            requested_by: components["schemas"]["__schema362"];
            status: components["schemas"]["__schema258"];
            turns: components["schemas"]["__schema264"][];
        };
        __schema367: components["schemas"]["SandboxComputer"][];
        __schema368: string;
        __schema369: string | null;
        __schema370: string | null;
        /** @enum {string} */
        __schema371: "ready" | "paused";
        __schema372: boolean;
        /** @enum {string} */
        __schema373: "agent" | "human";
        __schema374: number;
        __schema375: {
            /** @constant */
            height: 768;
            /** @constant */
            width: 1024;
        };
        /** @enum {string} */
        __schema376: "deny_all" | "connected_hosts_only" | "open";
        __schema377: {
            policy: components["schemas"]["__schema359"];
        };
        __schema378: {
            builtin: boolean;
            id: components["schemas"]["__schema361"];
            label: string;
            provider: string;
            /** @enum {string} */
            shared_use: "owner" | "room";
            status: string;
        };
        __schema379: {
            handoff: components["schemas"]["__schema289"];
        };
        __schema380: string;
        __schema381: {
            can_withdraw: boolean;
            claim_id: components["schemas"]["__schema380"];
            content: string | null;
            created_at: components["schemas"]["__schema189"];
            id: components["schemas"]["__schema361"];
            label: string | null;
            members_only: boolean;
            shared_by: components["schemas"]["__schema362"];
        };
        __schema382: {
            share: components["schemas"]["__schema381"];
        };
        __schema383: {
            error?: components["schemas"]["__schema192"];
            job: components["schemas"]["__schema384"] | null;
            receipt: components["schemas"]["__schema407"];
        };
        __schema384: {
            /** @enum {string} */
            attention_status: "normal" | "frequency_reduced" | "needs_attention";
            budget: components["schemas"]["__schema395"];
            cadence_multiplier: number;
            constraints: components["schemas"]["__schema390"];
            created_at: components["schemas"]["__schema189"];
            created_by: components["schemas"]["__schema396"];
            /** @default [] */
            deferred_questions: {
                because: components["schemas"]["__schema400"];
                blocks_external_effect: components["schemas"]["__schema403"];
                created_at: components["schemas"]["__schema189"];
                deadline_at: components["schemas"]["__schema404"];
                if_ignored: components["schemas"]["__schema402"];
                options?: components["schemas"]["__schema405"];
                text: components["schemas"]["__schema399"];
                why?: components["schemas"]["__schema406"];
            }[];
            id: components["schemas"]["__schema385"];
            /** @enum {string} */
            importance: "routine" | "important";
            lease_epoch: components["schemas"]["__schema392"];
            next_wake_at: components["schemas"]["__schema393"];
            objective: components["schemas"]["__schema389"];
            principal_id?: components["schemas"]["__schema387"];
            revision: components["schemas"]["__schema391"];
            /** @enum {string} */
            scheduling_class: "interactive" | "background" | "quiet";
            space_id: components["schemas"]["__schema386"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema397"];
            substrate_disposition: components["schemas"]["__schema398"];
            title: components["schemas"]["__schema388"];
            unread_results: number;
            unread_threshold: number;
            updated_at: components["schemas"]["__schema189"];
            visible_status: components["schemas"]["JobState"] | ("frequency_reduced" | "needs_attention");
            wait: components["schemas"]["__schema394"];
        };
        __schema385: string;
        __schema386: string;
        __schema387: string | null;
        __schema388: string;
        __schema389: string;
        __schema390: {
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
        __schema391: number;
        __schema392: number;
        __schema393: components["schemas"]["__schema189"] | null;
        __schema394: {
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
            wake_at: components["schemas"]["__schema189"];
        } | {
            deadline_at: components["schemas"]["__schema189"] | null;
            /** @constant */
            kind: "event";
            trigger_id: string;
        };
        __schema395: {
            max_actions: number;
            max_attempts: number;
            max_input_tokens?: number;
            max_output_tokens: number;
            max_turns: number;
            max_usd_est: number;
            max_wall_ms: number;
        };
        /** @enum {string} */
        __schema396: "owner" | "trigger" | "system";
        __schema397: number;
        /** @enum {string} */
        __schema398: "remote_recoverable" | "timer_or_event" | "local_process_interrupted" | "external_uncertain";
        __schema399: string;
        __schema400: components["schemas"]["__schema401"][];
        __schema401: string;
        __schema402: string;
        /** @default false */
        __schema403: boolean;
        /** @default null */
        __schema404: components["schemas"]["__schema189"] | null;
        __schema405: components["schemas"]["__schema285"];
        __schema406: string;
        __schema407: {
            event_cursor: number | null;
            input_digest: components["schemas"]["__schema409"] | null;
            job_id: string | null;
            job_revision: number | null;
            /** @enum {string} */
            state: "accepted" | "rejected" | "unknown_durability";
            submission_id: components["schemas"]["__schema408"];
        };
        __schema408: string;
        __schema409: string;
        __schema410: {
            answer: string | null;
            answered_at: components["schemas"]["__schema189"] | null;
            attempt_id: string | null;
            because: components["schemas"]["__schema400"];
            blocks_external_effect: components["schemas"]["__schema403"];
            created_at: components["schemas"]["__schema189"];
            deadline_at: components["schemas"]["__schema404"];
            id: string;
            if_ignored: components["schemas"]["__schema402"];
            job_id: string | null;
            job_title: string | null;
            key: string | null;
            options?: components["schemas"]["__schema405"];
            /** @enum {string} */
            source: "job" | "memory";
            space_id: string | null;
            /** @enum {string} */
            state: "open" | "answered" | "withdrawn";
            text: components["schemas"]["__schema399"];
            why?: components["schemas"]["__schema406"];
        };
        __schema411: {
            actions: {
                dispatched_at: components["schemas"]["__schema189"] | null;
                id: string;
                job_id: string;
                receipt: components["schemas"]["__schema412"] | null;
                status: string;
            }[];
            cursor: number;
            epoch: number | null;
            jobs: components["schemas"]["__schema384"][];
        };
        __schema412: {
            [key: string]: components["schemas"]["__schema413"];
        };
        __schema413: (string | number | boolean | null) | components["schemas"]["__schema413"][] | {
            [key: string]: components["schemas"]["__schema413"];
        };
        __schema414: {
            due_at: components["schemas"]["__schema189"];
            id: string;
            job_id: string;
            /** @enum {string} */
            kind: "timer" | "remote_task" | "local_process";
            operation_key: components["schemas"]["__schema408"];
            remote_ref: string | null;
            result: components["schemas"]["__schema412"] | null;
            /** @enum {string} */
            state: "registered" | "ready" | "claimed" | "settled" | "interrupted" | "unknown";
            substrate_disposition: components["schemas"]["__schema398"];
            version: number;
        };
        __schema415: {
            acknowledged_at: components["schemas"]["__schema189"] | null;
            coalesce_key: string;
            created_at: components["schemas"]["__schema189"];
            fulfilled_at: components["schemas"]["__schema189"] | null;
            id: string;
            job_id: string | null;
            /** @enum {string} */
            kind: "direct" | "quiet";
            message: string | null;
            /** @enum {string} */
            state: "owed" | "acknowledged" | "fulfilled" | "needs_retransmission";
            submission_id: components["schemas"]["__schema408"];
        };
        __schema416: {
            attempted_at: components["schemas"]["__schema189"] | null;
            because: components["schemas"]["__schema401"][];
            coalesce_key: string;
            content: {
                attempt_id: string;
                job_id: string;
                /** @enum {string} */
                kind: "answer" | "question" | "status";
                text: string;
            } | null;
            content_hash: components["schemas"]["__schema409"];
            created_at: components["schemas"]["__schema189"];
            delivered_at: components["schemas"]["__schema189"] | null;
            delivery_attempt: number;
            delivery_key: string;
            id: string;
            if_ignored: components["schemas"]["__schema402"];
            obligation_ids: string[];
            /** @enum {string} */
            state: "pending" | "attempted" | "delivered" | "superseded";
        };
        __schema417: {
            audience: components["schemas"]["__schema421"];
            /**
             * @default owner
             * @enum {string}
             */
            author: "owner" | "external" | "member";
            content_ref: string | null;
            eligibility_generation: components["schemas"]["__schema422"];
            event_at: components["schemas"]["__schema189"];
            ingested_at: components["schemas"]["__schema189"];
            origin_trust: components["schemas"]["__schema423"];
            owner_id: string;
            publisher: components["schemas"]["__schema419"];
            source_id: components["schemas"]["__schema418"];
            source_identity: components["schemas"]["__schema419"];
            /** @enum {string} */
            source_type: "message" | "document" | "observation" | "receipt" | "assistant" | "owner_edit";
            source_version: components["schemas"]["__schema419"];
            space_id: string;
            /** @enum {string} */
            state: "active" | "suppressed" | "deleted" | "revoked";
            stream: components["schemas"]["__schema419"];
            stream_sequence: components["schemas"]["__schema420"];
        };
        __schema418: string;
        __schema419: string;
        __schema420: number;
        /** @enum {string} */
        __schema421: "private" | "space" | "public";
        __schema422: number;
        /** @enum {string} */
        __schema423: "owner" | "verified_connector" | "external_content" | "inferred" | "unknown";
        __schema424: {
            access_generation: components["schemas"]["__schema422"];
            data_revision: components["schemas"]["__schema422"];
            eligibility_generation: components["schemas"]["__schema422"];
            policy_generation: components["schemas"]["__schema422"];
            restore_ready: boolean;
            space_id: string;
        };
        __schema425: string;
        /** @enum {string} */
        __schema426: "user_statement" | "document_assertion" | "checked_fact" | "inferred" | "preference" | "exception" | "historical";
        /** @enum {string} */
        __schema427: "attributed" | "checked" | "tentative" | "disputed";
        /** @enum {string} */
        __schema428: "active" | "superseded" | "historical" | "retracted" | "disputed";
        __schema429: {
            end: components["schemas"]["__schema420"];
            source_id: components["schemas"]["__schema418"];
            source_version: components["schemas"]["__schema419"];
            start: components["schemas"]["__schema422"];
        };
        __schema430: {
            claim_id: components["schemas"]["__schema380"];
            content: string | null;
            data_revision: components["schemas"]["__schema420"];
            factual_status: components["schemas"]["__schema427"];
            kind: components["schemas"]["__schema426"];
            /** @default inferred */
            origin_trust: components["schemas"]["__schema423"];
            protected: boolean;
            recorded_at: components["schemas"]["__schema189"];
            revision: components["schemas"]["__schema420"];
            sources: components["schemas"]["__schema429"][];
            status: components["schemas"]["__schema428"];
            superseded_at: components["schemas"]["__schema189"] | null;
            valid_from: components["schemas"]["__schema189"];
            valid_until: components["schemas"]["__schema189"] | null;
        };
        __schema431: {
            /** @enum {string} */
            cleanup: "pending" | "complete";
            generation: components["schemas"]["__schema424"];
        };
        __schema432: string;
        /** @default null */
        __schema433: components["schemas"]["__schema315"] | null;
        __schema434: boolean;
        __schema435: string;
        __schema436: string;
        __schema437: {
            field: string;
            handle: components["schemas"]["__schema425"];
            key: components["schemas"]["__schema315"] | null;
            /** @enum {string} */
            kind: "recipient" | "date" | "amount" | "identifier";
            value: string;
        };
        __schema438: {
            description: string;
            field: string;
            handle: (components["schemas"]["__schema425"] | string) | null;
            origin_trust: components["schemas"]["__schema423"];
            value: string;
        };
        __schema439: string;
        __schema440: string;
        __schema441: {
            /** @enum {string} */
            kind: "artifact" | "plan_step" | "action";
            location: string | null;
            output_id: components["schemas"]["__schema435"];
            output_version: components["schemas"]["__schema435"];
        };
        __schema442: {
            diff: string;
            id: components["schemas"]["__schema419"];
            path: string;
            /** @enum {string} */
            status: "pending" | "applied" | "discarded";
        };
        __schema443: {
            checks: {
                detail: string;
                name: string;
                ok: boolean;
            }[];
            /** @enum {string} */
            status: "ok" | "unhealthy";
            time: components["schemas"]["__schema189"];
            version: string;
        };
        __schema444: {
            owner: {
                created_at: components["schemas"]["__schema189"];
                /** Format: email */
                email: string;
                id: string;
                /** @enum {string} */
                kind?: "person" | "guest";
            };
        };
        __schema445: {
            job: components["schemas"]["Job"];
        };
        /** @default [] */
        __schema446: components["schemas"]["__schema447"][];
        __schema447: {
            field: string;
            /** @enum {string} */
            op: "eq" | "contains" | "matches" | "lt" | "gt" | "changed" | "before" | "after" | "older_than" | "absent";
            /** @default null */
            value: string | number | boolean | null;
        };
        __schema448: components["schemas"]["__schema447"][];
        __schema449: {
            /** @enum {string} */
            by: "person" | "assistant";
            created_at: components["schemas"]["__schema189"];
            emoji: string;
            job_id: string | null;
            message_id: string;
            seq: number;
        };
        __schema450: {
            reactions: components["schemas"]["__schema449"][];
        };
        __schema451: string;
        __schema452: string;
        __schema453: number;
        __schema454: string;
        __schema455: string;
        __schema456: string;
        __schema457: string | null;
        __schema458: {
            /** @default 0 */
            cached_input_tokens: number;
            charged_input_tokens?: number;
            /** @default 0 */
            input_tokens: number;
            /** @default 0 */
            output_tokens: number;
            /** @default 0 */
            requests: number;
            /** @default 0 */
            usd_est: number;
        };
        __schema459: components["schemas"]["__schema189"] | null;
        __schema460: ("completed" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "failed" | "budget_exhausted" | "fenced" | "unknown_check") | null;
        __schema461: components["schemas"]["__schema412"] | null;
        __schema462: string | null;
        __schema463: {
            events: components["schemas"]["Event"][];
            has_more: boolean;
            next_cursor: number;
        };
        __schema464: number;
        __schema465: string | null;
        __schema466: string | null;
        /** @enum {string} */
        __schema467: "job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "reasoning_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error";
        __schema468: string;
        __schema469: string;
        __schema470: string;
        /** @enum {string} */
        __schema471: "completed" | "parked_until_retry" | "needs_reconciliation" | "needs_reconnect" | "needs_input" | "repair_exhausted";
        __schema472: {
            [key: string]: number;
        };
        __schema473: {
            at: components["schemas"]["__schema189"];
            attempt: number;
            /** @default null */
            candidate_id: string | null;
            /** @enum {string} */
            decision: "verified_completion" | "retry_with_backoff" | "park_until_retry_after" | "park_until_reconnect" | "refresh_credential_once" | "stop_connection_revoked" | "rediscover_schema" | "record_repair_candidate" | "apply_safe_mapping" | "change_route" | "reconcile_by_verify" | "revise_and_revalidate" | "stop_needs_input" | "escalate_diagnosis";
            /** @default null */
            delay_ms: number | null;
            detail: string;
            /** @default null */
            fault_kind: components["schemas"]["__schema474"] | null;
            payload_hash: components["schemas"]["__schema469"];
            /** @default null */
            retry_after: components["schemas"]["__schema189"] | null;
            /** @default null */
            route: string | null;
        }[];
        /** @enum {string} */
        __schema474: "transient_before_dispatch" | "rate_limited" | "expired_credential" | "revoked_credential" | "schema_drift" | "unsupported_route" | "uncertain_outcome" | "bad_output" | "destination_offline" | "unclassified";
        __schema475: string;
        __schema476: string;
        __schema477: string;
        __schema478: string;
        __schema479: string;
        /** @default null */
        __schema480: components["schemas"]["__schema470"] | null;
        __schema481: string | null;
        __schema482: string | null;
        __schema483: string;
        __schema484: components["schemas"]["__schema189"] | null;
        __schema485: components["schemas"]["__schema412"] | null;
        __schema486: components["schemas"]["__schema189"] | null;
        __schema487: components["schemas"]["__schema412"] | null;
        /** @default [] */
        __schema488: components["schemas"]["__schema473"];
        /** @default {} */
        __schema489: components["schemas"]["__schema472"];
        /** @default null */
        __schema490: components["schemas"]["__schema471"] | null;
        /** @default null */
        __schema491: components["schemas"]["__schema189"] | null;
        __schema492: string;
        __schema493: string;
        __schema494: string;
        __schema495: components["schemas"]["__schema412"] | null;
        __schema496: components["schemas"]["__schema189"] | null;
        __schema497: components["schemas"]["__schema189"] | null;
        __schema498: {
            action: components["schemas"]["Action"];
        };
        __schema499: string;
        __schema500: string;
        /** @enum {string} */
        __schema501: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp" | "sandbox" | "device" | "command_line" | "apps" | "room" | "notes";
        __schema502: string;
        __schema503: string[];
        /** @enum {string} */
        __schema504: "active" | "disabled" | "error" | "revoked";
        /** @enum {string} */
        __schema505: "unknown" | "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema506: "available" | "connecting" | "connected" | "error";
        __schema507: number;
        __schema508: boolean;
        __schema509: string[];
        /** @enum {string} */
        __schema510: "owner" | "room";
        __schema511: string;
        __schema512: components["schemas"]["__schema189"] | null;
        __schema513: {
            check?: components["schemas"]["ConnectionCheck"];
            connection: components["schemas"]["Connection"];
        };
        /** @enum {string} */
        __schema514: "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema515: "ok" | "degraded" | "unavailable" | "credential_refused" | "sign_in_required" | "needs_sign_in" | "not_running" | "revoked";
        __schema516: string;
        __schema517: string;
        __schema518: string;
        __schema519: string;
        __schema520: string;
        __schema521: {
            help?: string;
            label: string;
            list: boolean;
            name: string;
            placeholder?: string;
            required: boolean;
            secret: boolean;
        }[];
        __schema522: {
            asks_first: boolean;
            effect_class: components["schemas"]["EffectClass"];
            label: string;
        }[];
        __schema523: string | null;
        __schema524: {
            label?: string;
            scope: string;
        };
        __schema525: {
            authorization_servers: string[];
            bearer_methods_supported: string[];
            /** Format: uri */
            resource: string;
            resource_name: string;
            scopes_supported: string[];
        };
        __schema526: {
            error: string;
            error_description?: string;
        };
        __schema527: {
            error?: {
                code: number;
                message: string;
            };
            id: string | number | null;
            /** @constant */
            jsonrpc: "2.0";
            result?: unknown;
        };
        __schema528: {
            available: boolean;
            redirect_uri: string | null;
        };
        __schema529: {
            /** Format: uri */
            authorize_url: string;
            expires_at: components["schemas"]["__schema189"];
            /** Format: uri */
            issuer: string;
            /** Format: uri */
            redirect_uri: string;
            scopes: components["schemas"]["__schema524"][];
            sign_in_id: string;
        };
        __schema530: {
            expires_at: components["schemas"]["__schema189"];
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
        __schema531: string;
        /** @enum {string} */
        __schema532: "mail" | "caldav" | "ics" | "mcp" | "mcp_stdio" | "sandbox" | "command_line";
        __schema533: string;
        __schema534: string;
        __schema535: {
            path: string;
            value: components["schemas"]["__schema536"];
        }[];
        __schema536: string | number | boolean;
        __schema537: components["schemas"]["ConnectionFormField"][];
        __schema538: string;
        __schema539: string;
        __schema540: string;
        __schema541: boolean;
        __schema542: boolean;
        __schema543: string;
        __schema544: components["schemas"]["__schema536"];
        __schema545: {
            label: string;
            value: string;
        }[];
        __schema546: components["schemas"]["__schema547"] | "list";
        /** @enum {string} */
        __schema547: "text" | "email" | "url" | "number" | "password" | "checkbox" | "select" | "string_list";
        __schema548: {
            default?: components["schemas"]["__schema544"];
            help?: components["schemas"]["__schema540"];
            input: components["schemas"]["__schema547"];
            label: components["schemas"]["__schema539"];
            options?: components["schemas"]["__schema545"];
            path: components["schemas"]["__schema538"];
            placeholder?: components["schemas"]["__schema543"];
            required: components["schemas"]["__schema541"];
            secret: components["schemas"]["__schema542"];
        }[];
        __schema549: {
            asks_first: boolean;
            default: boolean;
            effect_class: components["schemas"]["EffectClass"];
            label: string;
            scope: string;
        }[];
        __schema550: string;
        __schema551: string;
        __schema552: string;
        __schema553: ("mail" | "calendar" | "tools" | "execution")[];
        __schema554: {
            /** Format: uri */
            issuer: string;
            /** @constant */
            method: "sign_in";
            /** @enum {string} */
            provider: "google" | "microsoft";
            scopes: components["schemas"]["__schema524"][];
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
        __schema555: boolean;
        __schema556: string;
        __schema557: string;
        __schema558: string;
        /** @enum {string} */
        __schema559: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema560: "active" | "superseded" | "retracted" | "disputed";
        __schema561: {
            body: string;
            frontmatter: components["schemas"]["KnowledgeFrontmatterOutput"];
            id: string;
            path: string;
        };
        __schema562: string;
        __schema563: string;
        __schema564: string;
        /** @enum {string} */
        __schema565: "private" | "space" | "public";
        /** @enum {string} */
        __schema566: "high" | "medium" | "low";
        /** @enum {string} */
        __schema567: "user" | "agent" | "document" | "tool";
        __schema568: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote: string;
            ref: string;
            /** @default null */
            sha256: string | null;
        };
        /** Format: date */
        __schema569: string;
        /** @default null */
        __schema570: components["schemas"]["__schema569"] | null;
        /** @default [] */
        __schema571: components["schemas"]["__schema562"][];
        /** @default null */
        __schema572: components["schemas"]["__schema562"] | null;
        /** @default [] */
        __schema573: string[];
        /** @default [] */
        __schema574: components["schemas"]["__schema562"][];
        /** @constant */
        __schema575: 1;
        __schema576: string;
        __schema577: {
            attachment: components["schemas"]["__schema265"];
        };
        __schema578: string;
        __schema579: number;
        /** @enum {string} */
        __schema580: "automation" | "human";
        /** @constant */
        __schema581: true;
        __schema582: components["schemas"]["BrowserSite"][];
        __schema583: string;
        __schema584: string;
        __schema585: string;
        __schema586: string;
        /** @constant */
        __schema587: true;
        __schema588: string;
        __schema589: number;
        __schema590: {
            /** @constant */
            height: 768;
            /** @constant */
            width: 1024;
        };
        __schema591: components["schemas"]["__schema592"][];
        __schema592: string;
        __schema593: string;
        __schema594: number;
        __schema595: components["schemas"]["__schema596"][];
        __schema596: string;
        /** @constant */
        __schema597: true;
        __schema598: string;
        __schema599: number;
        __schema600: string;
        __schema601: {
            /** @default null */
            currency: components["schemas"]["__schema603"] | null;
            domain: string;
            first_seen_at: components["schemas"]["__schema189"];
            id: string;
            last_seen_at: components["schemas"]["__schema189"];
            message_count: number;
            /** @default null */
            monthly_spend_minor: components["schemas"]["__schema602"] | null;
            name: string;
            space_id: string;
        };
        __schema602: number;
        __schema603: string;
        __schema604: {
            /** @default null */
            amount_minor: components["schemas"]["__schema602"] | null;
            company_id: string;
            confidence: components["schemas"]["__schema566"];
            /** @default null */
            currency: components["schemas"]["__schema603"] | null;
            /** @enum {string} */
            direction: "owed_to_you" | "you_pay" | "you_owe" | "info";
            /** @default null */
            due_at: components["schemas"]["__schema189"] | null;
            due_date_only?: boolean;
            evidence: components["schemas"]["__schema606"][];
            id: string;
            /** @default null */
            job_id: string | null;
            /** @enum {string} */
            kind: "refund_owed" | "wrong_charge" | "subscription" | "price_rise" | "renewal" | "trial_ending" | "invoice_unpaid" | "compensation" | "warranty" | "deposit" | "data_held" | "promise";
            principal_id: string;
            space_id: string;
            status: components["schemas"]["__schema605"];
            /** @default null */
            suggested_playbook: string | null;
            summary: string;
        };
        /** @enum {string} */
        __schema605: "found" | "handling" | "waiting" | "settled" | "dropped";
        __schema606: {
            end: number;
            message_id: string;
            quote: string;
            start: number;
        };
        __schema607: {
            amount_minor: components["schemas"]["__schema602"] | null;
            currency: components["schemas"]["__schema603"] | null;
            due_at: components["schemas"]["__schema189"] | null;
            id: string;
            job_id: string | null;
            /** @enum {string} */
            kind: "owed" | "reply";
            sent_at: components["schemas"]["__schema189"] | null;
            status: components["schemas"]["__schema605"];
            what: string;
            who: string;
        };
        __schema608: {
            because: {
                at: components["schemas"]["__schema189"] | null;
                handle: string;
                /** @enum {string} */
                kind: "mail" | "calendar" | "situation";
                label: string;
                subject: string | null;
            };
            chat_prompt: string | null;
            created_at: components["schemas"]["__schema189"];
            id: string;
            reason: string;
            seen: boolean;
            sentence: string;
            /** @enum {string} */
            source: "triage" | "situation";
            /** @enum {string} */
            urgency: "normal" | "soon" | "urgent";
        };
        __schema609: {
            item: components["schemas"]["__schema608"];
        };
        __schema610: {
            report: components["schemas"]["FeedbackReport"];
        };
        /**
         * @description A short report id, such as FB-7K3Q
         * @example FB-7K3Q
         */
        __schema611: string;
        __schema612: string;
        __schema613: string;
        __schema614: string | null;
        __schema615: string;
        __schema616: string;
        __schema617: string;
        __schema618: string;
        __schema619: string;
        __schema620: {
            height: number;
            pixel_ratio?: number;
            width: number;
        };
        /** @enum {string} */
        __schema621: "light" | "dark";
        __schema622: components["schemas"]["__schema623"][];
        __schema623: {
            at: components["schemas"]["__schema189"];
            message: string;
        };
        __schema624: components["schemas"]["__schema625"][];
        __schema625: {
            at: components["schemas"]["__schema189"];
            code: string | null;
            method: string;
            status: number | null;
            url: string;
        };
        __schema626: {
            email: string | null;
            principal_id: string | null;
        };
        __schema627: string | null;
        __schema628: {
            day: components["schemas"]["__schema629"];
            month: components["schemas"]["__schema629"];
        };
        __schema629: {
            /** @description Input and output tokens */
            tokens: number;
            /** @description Estimated dollars spent */
            usd: number;
        };
        __schema630: components["schemas"]["__schema628"] | null;
        __schema631: {
            day: components["schemas"]["__schema632"];
            month: components["schemas"]["__schema632"];
        };
        __schema632: {
            /** @description Token limit; null is none */
            tokens: components["schemas"]["__schema634"] | null;
            /** @description Dollar limit; null is none */
            usd: components["schemas"]["__schema633"] | null;
        };
        __schema633: number;
        __schema634: number;
        __schema635: {
            calls: components["schemas"]["__schema636"];
            /**
             * @description `interactive`: a person was waiting on the call (their message, their answer, a voice aside, a scan they asked for, and the searches and reviews of that turn). `background`: nobody was (watches, standing runs, routines, memory, learning).
             * @enum {string}
             */
            class: "interactive" | "background";
            purpose: string;
            tokens: components["schemas"]["__schema638"];
            usd: components["schemas"]["__schema637"];
        }[];
        __schema636: number;
        __schema637: number;
        __schema638: number;
        __schema639: {
            calls: components["schemas"]["__schema636"];
            /**
             * @description Which step made the call: `interactive` an agent turn a person waited on, `t2` an agent turn something else woke, `service` one of the service’s own side calls, `t1` a batched look at what came in.
             * @enum {string}
             */
            tier: "interactive" | "t1" | "t2" | "service";
            tokens: components["schemas"]["__schema638"];
            usd: components["schemas"]["__schema637"];
        }[];
        __schema640: {
            background_usd: number;
            calls: number;
            /** @description UTC day, YYYY-MM-DD */
            day: string;
            usd: number;
        }[];
        __schema641: {
            mean_usd: number;
            median_usd: number;
            p95_usd: number;
            /** @description Days a person made at least one model call, summed over people */
            person_days: number;
        } | null;
        __schema642: {
            calls: number;
            model: string;
            provider: string;
            /** @description Whether this is the account’s primary or secondary model now; null for any other */
            role: components["schemas"]["__schema643"] | null;
            tokens: number;
            usd: number;
        };
        /** @enum {string} */
        __schema643: "primary" | "secondary";
        __schema644: {
            active: {
                /** @description The active provider has a credential */
                connected: boolean;
                model: string;
                provider: string;
                /** @description What the provider’s own model list says about this model reading images, from the last time the list was fetched; null when it has said nothing. Shown beside the switch only: it never changes `vision`. */
                provider_vision: components["schemas"]["__schema645"] | null;
                /**
                 * @description `app`: chosen in Settings, and used until it is cleared. `operator`: the server’s MELETE_DEFAULT_PROVIDER and MELETE_DEFAULT_MODEL, used while nothing is chosen in the app.
                 * @enum {string}
                 */
                source: "app" | "operator";
                updated_at: components["schemas"]["__schema189"] | null;
                /** @description Whether the model is shown the screenshots the agent takes, as pictures. Otherwise it reads their text receipt: where each was saved, its size and digest. */
                vision: boolean;
                /**
                 * @description `catalog`: Melete’s list of models that read images. `app`: the owner said so for this model in Settings. `operator`: MELETE_DEFAULT_MODEL_VISION.
                 * @enum {string}
                 */
                vision_source: "catalog" | "app" | "operator";
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
                base_url: components["schemas"]["__schema647"] | null;
                base_url_source: ("app" | "operator") | null;
                /** @description A key is set or the owner is signed in, so a model call has a credential. It is not a promise that the provider accepts it; test the connection for that. */
                connected: boolean;
                key: {
                    /** @description The last four characters of a key entered in the app */
                    last_four: components["schemas"]["__schema646"] | null;
                    /**
                     * @description `set`: entered in the app and stored sealed. `operator`: the server environment names a key for this provider; it is used, cannot be changed here, and is never shown.
                     * @enum {string}
                     */
                    state: "unset" | "set" | "operator";
                    updated_at: components["schemas"]["__schema189"] | null;
                };
                label: string;
                /** @description Whether a successful test returns the provider’s model list */
                lists_models: boolean;
                /** @enum {string} */
                method: "key" | "sign_in";
                /** @enum {string} */
                provider: "anthropic" | "openai" | "google" | "fireworks" | "openai-compatible" | "chatgpt";
            }[];
            /** @description This account’s secondary model, for cheaper work beside the primary, and which work uses it */
            secondary: {
                can_edit: components["schemas"]["__schema654"];
                leaves_local_primary: components["schemas"]["__schema655"];
                model: components["schemas"]["__schema648"];
                updated_at: components["schemas"]["__schema656"];
                uses: components["schemas"]["__schema650"];
            };
        };
        __schema645: boolean;
        __schema646: string;
        __schema647: string;
        /** @description This account’s secondary model; null uses the primary for everything */
        __schema648: components["schemas"]["__schema649"] | null;
        __schema649: {
            /** @description The provider has a credential. While it has none, the work goes to the primary. */
            connected: boolean;
            model: string;
            provider: string;
        };
        /** @description Which work runs on the secondary. Applies only while a secondary model is set. A chat answering the person’s own message always runs on the primary; one a watch or a schedule wakes, with nobody writing, follows `scheduled`. */
        __schema650: {
            scheduled: components["schemas"]["__schema653"];
            side_tasks: components["schemas"]["__schema651"];
        };
        /** @description Short side calls: reading chats into memory and quick voice replies. `secondary` by default once a secondary model is set. The check before a risky action never moves. */
        __schema651: components["schemas"]["__schema652"];
        /** @enum {string} */
        __schema652: "primary" | "secondary";
        /** @description Scheduled and repeating work: routines, and work that wakes on a trigger. `primary` by default. */
        __schema653: components["schemas"]["__schema652"];
        /** @description Whether this account may set the secondary model (the owner) */
        __schema654: boolean;
        /** @description The primary runs on this machine or network and the secondary does not, so work moved to the secondary leaves it, chats a watch or schedule wakes among it. Side calls stay on a local primary either way. */
        __schema655: boolean;
        __schema656: components["schemas"]["__schema189"] | null;
        __schema657: string;
        __schema658: number;
        __schema659: {
            /** @description The signed-in account, when the provider names one */
            account: components["schemas"]["__schema660"] | null;
            /** @description When the current access token expires. The gateway refreshes before then. */
            expires_at: components["schemas"]["__schema189"] | null;
            /** @description The provider as the person knows it, for a "Sign in with" button */
            label: string;
            /** @description What happened and what to do, in plain words, whenever the person has something to do; null when signed in or signed out. */
            message: components["schemas"]["__schema662"] | null;
            methods: ("device" | "browser")[];
            /** @enum {string} */
            provider: "chatgpt" | "openai-compatible";
            /** @description Why a new sign-in is needed */
            reason: components["schemas"]["__schema661"] | null;
            /**
             * @description `sign_in_required` means the provider refused a refresh; model calls to it are refused with `provider_sign_in_required` until the owner signs in again.
             * @enum {string}
             */
            state: "signed_out" | "pending" | "signed_in" | "sign_in_required";
        };
        __schema660: string;
        /** @enum {string} */
        __schema661: "refresh_expired" | "refresh_reused" | "refresh_revoked" | "refresh_refused" | "access_expired";
        __schema662: string;
        __schema663: string;
        __schema664: string;
        __schema665: string;
        /** @enum {string} */
        __schema666: "windows" | "macos" | "linux" | "other";
        __schema667: boolean;
        __schema668: boolean;
        __schema669: boolean;
        __schema670: boolean;
        /** @default false */
        __schema671: boolean;
        __schema672: {
            name: string;
            path: string;
        }[];
        __schema673: boolean | null;
        /** @enum {string} */
        __schema674: "online" | "offline" | "revoked";
        __schema675: boolean;
        __schema676: string | null;
        __schema677: components["schemas"]["__schema189"] | null;
        __schema678: components["schemas"]["__schema189"] | null;
        __schema679: string;
        __schema680: {
            device: components["schemas"]["Device"];
        };
        __schema681: string;
        /** @enum {string} */
        __schema682: "status" | "list_files" | "read_file" | "write_file" | "run" | "open_url" | "screenshot" | "browser_open" | "browser_read" | "browser_click" | "browser_type" | "browser_screenshot";
        __schema683: {
            [key: string]: unknown;
        };
        __schema684: number;
        __schema685: {
            created_at: components["schemas"]["__schema189"];
            current_version: {
                created_at: components["schemas"]["__schema189"];
                created_by: components["schemas"]["__schema690"];
                file_count: components["schemas"]["__schema691"];
                id: components["schemas"]["__schema689"];
                total_bytes: components["schemas"]["__schema692"];
            } | null;
            description: string | null;
            id: components["schemas"]["__schema686"];
            name: string;
            publisher: components["schemas"]["__schema687"];
            role: components["schemas"]["__schema688"];
            updated_at: components["schemas"]["__schema189"];
        };
        __schema686: string;
        __schema687: {
            email: string;
            id: string;
        };
        /** @enum {string} */
        __schema688: "view" | "manage";
        __schema689: string;
        __schema690: components["schemas"]["__schema687"] | null;
        __schema691: number;
        __schema692: number;
        __schema693: {
            app: components["schemas"]["__schema685"];
            collections: {
                max_bytes: number;
                name: string;
            }[];
            data: {
                /** @constant */
                kind: "artifact";
                name: string;
                path: string;
                review: boolean;
            }[];
            data_waiting: number | null;
            files: {
                mime: string;
                path: string;
                size: number;
            }[];
            grants: ({
                granted_at: components["schemas"]["__schema189"];
                /** @constant */
                kind: "principal";
                principal: components["schemas"]["__schema687"];
                role: components["schemas"]["__schema688"];
            } | {
                granted_at: components["schemas"]["__schema189"];
                /** @constant */
                kind: "installation";
                /** @constant */
                role: "view";
            })[] | null;
            versions: {
                changes: {
                    added: string[];
                    changed: string[];
                    removed: string[];
                    truncated: boolean;
                };
                created_at: components["schemas"]["__schema189"];
                created_by: components["schemas"]["__schema690"];
                current: boolean;
                file_count: components["schemas"]["__schema691"];
                id: components["schemas"]["__schema689"];
                total_bytes: components["schemas"]["__schema692"];
            }[] | null;
        };
        __schema694: string;
        __schema695: {
            updates: {
                artifact_id: string;
                binding: components["schemas"]["__schema694"];
                changes: {
                    added: string[];
                    changed: string[];
                    removed: string[];
                    truncated: boolean;
                } | null;
                path: string;
                size: number;
                size_before: number | null;
                summary: string;
                written_at: components["schemas"]["__schema189"];
            }[];
        };
        __schema696: string;
        __schema697: string;
        __schema698: number;
        /** @enum {string} */
        __schema699: "starting" | "running" | "exited" | "stopped" | "expired" | "lost";
        __schema700: string;
        /** @enum {string} */
        __schema701: "starting" | "running" | "exited" | "stopped" | "expired" | "lost";
        __schema702: string;
        __schema703: number;
        __schema704: string;
        __schema705: string;
        /** @enum {string} */
        __schema706: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema707: string | null;
        __schema708: {
            captured_at: components["schemas"]["__schema189"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema709: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema710: string | null;
        __schema711: {
            compression_count?: number;
            in_place?: boolean;
            used_fallback?: boolean;
        };
        __schema712: string;
        Action: {
            attempt_id: components["schemas"]["__schema477"];
            authorization_ref: components["schemas"]["__schema481"];
            budget_reservation: components["schemas"]["__schema482"];
            canonical_payload: components["schemas"]["__schema412"];
            connection_id: components["schemas"]["__schema478"];
            created_at: components["schemas"]["__schema189"];
            dispatched_at: components["schemas"]["__schema484"];
            effect_class: components["schemas"]["EffectClass"];
            id: components["schemas"]["__schema475"];
            idempotency_key: components["schemas"]["__schema483"];
            intent_key: components["schemas"]["__schema480"];
            job_id: components["schemas"]["__schema476"];
            kind: components["schemas"]["__schema479"];
            payload_hash: components["schemas"]["__schema469"];
            receipt: components["schemas"]["__schema485"];
            reconciliation: components["schemas"]["__schema487"];
            repair_counters: components["schemas"]["__schema489"];
            repair_disposition: components["schemas"]["__schema490"];
            repair_trace: components["schemas"]["__schema488"];
            resolved_at: components["schemas"]["__schema486"];
            retry_after_at: components["schemas"]["__schema491"];
            status: components["schemas"]["ActionStatus"];
        };
        /** @enum {string} */
        ActionStatus: "proposed" | "needs_approval" | "approved" | "denied" | "admitted" | "dispatched" | "succeeded" | "failed" | "unknown" | "unresolved";
        ActionSummary: {
            canonical_payload: components["schemas"]["__schema412"];
            created_at: components["schemas"]["__schema189"];
            dispatched_at: components["schemas"]["__schema496"];
            effect_class: components["schemas"]["EffectClass"];
            id: components["schemas"]["__schema492"];
            job_id: components["schemas"]["__schema493"];
            kind: components["schemas"]["__schema494"];
            reconciliation: components["schemas"]["__schema495"];
            resolved_at: components["schemas"]["__schema497"];
            status: components["schemas"]["ActionStatus"];
        };
        Attempt: {
            context_snapshot_ref: components["schemas"]["__schema462"];
            ended_at: components["schemas"]["__schema459"];
            epoch: components["schemas"]["__schema453"];
            id: components["schemas"]["__schema451"];
            job_id: components["schemas"]["__schema452"];
            model: components["schemas"]["__schema456"];
            model_actual: components["schemas"]["__schema457"];
            outcome: components["schemas"]["__schema460"];
            outcome_detail: components["schemas"]["__schema461"];
            provider: components["schemas"]["__schema455"];
            runtime_version: components["schemas"]["__schema454"];
            started_at: components["schemas"]["__schema189"];
            usage: components["schemas"]["__schema458"];
        };
        BrowserControlResponse: {
            control: components["schemas"]["__schema580"];
            control_epoch: components["schemas"]["__schema579"];
            fresh_observation_required: components["schemas"]["__schema581"];
            session_id: components["schemas"]["__schema578"];
        };
        BrowserSite: {
            domain: components["schemas"]["__schema583"];
            label: components["schemas"]["__schema584"];
            last_used: components["schemas"]["__schema585"];
        };
        BrowserSiteForgotten: {
            domain: components["schemas"]["__schema586"];
            forgotten: components["schemas"]["__schema587"];
        };
        BrowserSiteList: {
            sites: components["schemas"]["__schema582"];
        };
        CommandLineConnectionConfig: {
            adapter: components["schemas"]["__schema112"];
            external_id?: components["schemas"]["__schema115"];
            region?: components["schemas"]["__schema113"];
            role_arn?: components["schemas"]["__schema114"];
        };
        Connection: {
            account?: components["schemas"]["__schema511"];
            builtin?: components["schemas"]["__schema508"];
            created_at: components["schemas"]["__schema189"];
            generation?: components["schemas"]["__schema507"];
            health: components["schemas"]["__schema505"];
            id: components["schemas"]["__schema499"];
            label: components["schemas"]["__schema502"];
            last_checked_at: components["schemas"]["__schema512"];
            needs_scope?: components["schemas"]["__schema509"];
            provider: components["schemas"]["__schema501"];
            scopes: components["schemas"]["__schema503"];
            setup_state?: components["schemas"]["__schema506"];
            shared_use?: components["schemas"]["__schema510"];
            space_id: components["schemas"]["__schema500"];
            status: components["schemas"]["__schema504"];
        };
        ConnectionCatalogEntry: {
            available: components["schemas"]["__schema555"];
            connect: components["schemas"]["__schema554"];
            covers: components["schemas"]["__schema553"];
            description: components["schemas"]["__schema552"];
            id: components["schemas"]["__schema550"];
            setup_hint?: components["schemas"]["__schema557"];
            title: components["schemas"]["__schema551"];
            unavailable_reason?: components["schemas"]["__schema556"];
            warning?: components["schemas"]["__schema558"];
        };
        ConnectionCheck: {
            checked_at: components["schemas"]["__schema189"];
            code: components["schemas"]["__schema515"];
            detail: components["schemas"]["__schema516"];
            status: components["schemas"]["__schema514"];
        };
        ConnectionFormField: {
            default?: components["schemas"]["__schema544"];
            help?: components["schemas"]["__schema540"];
            input: components["schemas"]["__schema546"];
            item_fields?: components["schemas"]["__schema548"];
            label: components["schemas"]["__schema539"];
            options?: components["schemas"]["__schema545"];
            path: components["schemas"]["__schema538"];
            placeholder?: components["schemas"]["__schema543"];
            required: components["schemas"]["__schema541"];
            secret: components["schemas"]["__schema542"];
        };
        ConnectionKind: {
            description: components["schemas"]["__schema534"];
            fields: components["schemas"]["__schema537"];
            fixed: components["schemas"]["__schema535"];
            id: components["schemas"]["__schema531"];
            kind: components["schemas"]["__schema532"];
            scopes: components["schemas"]["__schema549"];
            title: components["schemas"]["__schema533"];
        };
        Device: {
            browser_connected: components["schemas"]["__schema675"];
            capabilities: components["schemas"]["DeviceCapabilitiesOutput"];
            cloud_screenshots: components["schemas"]["__schema673"];
            companion_version: components["schemas"]["__schema676"];
            connection_id: components["schemas"]["__schema664"];
            folders: components["schemas"]["__schema672"];
            id: components["schemas"]["__schema663"];
            last_seen_at: components["schemas"]["__schema677"];
            local_capabilities: components["schemas"]["DeviceCapabilitiesOutput"];
            name: components["schemas"]["__schema665"];
            paired_at: components["schemas"]["__schema189"];
            platform: components["schemas"]["__schema666"];
            revoked_at: components["schemas"]["__schema678"];
            status: components["schemas"]["__schema674"];
        };
        DeviceCapabilities: {
            browser?: components["schemas"]["__schema169"];
            commands: components["schemas"]["__schema165"];
            files: components["schemas"]["__schema166"];
            open_url: components["schemas"]["__schema167"];
            screenshot: components["schemas"]["__schema168"];
        };
        DeviceCapabilitiesOutput: {
            browser: components["schemas"]["__schema671"];
            commands: components["schemas"]["__schema667"];
            files: components["schemas"]["__schema668"];
            open_url: components["schemas"]["__schema669"];
            screenshot: components["schemas"]["__schema670"];
        };
        DevicePairing: {
            code: components["schemas"]["__schema679"];
            expires_at: components["schemas"]["__schema189"];
        };
        DeviceRequest: {
            arguments: components["schemas"]["__schema683"];
            deadline: components["schemas"]["__schema684"];
            id: components["schemas"]["__schema681"];
            tool: components["schemas"]["__schema682"];
        };
        /** @enum {string} */
        EffectClass: "read" | "write_reversible" | "write_external" | "spend";
        Event: {
            attempt_id: components["schemas"]["__schema466"];
            created_at: components["schemas"]["__schema189"];
            dedup_key: components["schemas"]["__schema468"];
            job_id: components["schemas"]["__schema465"];
            payload: components["schemas"]["__schema412"];
            seq: components["schemas"]["__schema464"];
            type: components["schemas"]["__schema467"];
        };
        FeedbackContext: {
            color_scheme?: components["schemas"]["__schema146"];
            console_errors?: components["schemas"]["__schema147"];
            failed_requests?: components["schemas"]["__schema149"];
            language?: components["schemas"]["__schema143"];
            route?: components["schemas"]["__schema141"];
            time_zone?: components["schemas"]["__schema144"];
            user_agent?: components["schemas"]["__schema142"];
            viewport?: components["schemas"]["__schema145"];
        };
        FeedbackContextOutput: {
            color_scheme?: components["schemas"]["__schema621"];
            console_errors?: components["schemas"]["__schema622"];
            failed_requests?: components["schemas"]["__schema624"];
            language?: components["schemas"]["__schema618"];
            route?: components["schemas"]["__schema616"];
            time_zone?: components["schemas"]["__schema619"];
            user_agent?: components["schemas"]["__schema617"];
            viewport?: components["schemas"]["__schema620"];
        };
        FeedbackReport: {
            app_version: components["schemas"]["__schema615"];
            context: components["schemas"]["FeedbackContextOutput"];
            created_at: components["schemas"]["__schema189"];
            id: components["schemas"]["__schema611"];
            message: components["schemas"]["__schema612"];
            note: components["schemas"]["__schema627"];
            reporter: components["schemas"]["__schema626"];
            route: components["schemas"]["__schema614"];
            status: components["schemas"]["FeedbackStatus"];
            summary: components["schemas"]["__schema613"];
            updated_at: components["schemas"]["__schema189"];
        };
        /** @enum {string} */
        FeedbackStatus: "open" | "fixing" | "fixed" | "wontfix";
        HookObservation: {
            capture_id: components["schemas"]["__schema705"];
            detail?: components["schemas"]["__schema711"];
            name: components["schemas"]["__schema706"];
            outcome: components["schemas"]["__schema709"];
            redacted_args_digest: components["schemas"]["__schema710"];
            timing: components["schemas"]["__schema708"];
            tool_name: components["schemas"]["__schema707"];
        };
        Job: {
            budget: components["schemas"]["__schema395"];
            constraints: components["schemas"]["__schema390"];
            created_at: components["schemas"]["__schema189"];
            created_by: components["schemas"]["__schema396"];
            id: components["schemas"]["__schema385"];
            lease_epoch: components["schemas"]["__schema392"];
            next_wake_at: components["schemas"]["__schema393"];
            objective: components["schemas"]["__schema389"];
            principal_id?: components["schemas"]["__schema387"];
            revision: components["schemas"]["__schema391"];
            space_id: components["schemas"]["__schema386"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema397"];
            title: components["schemas"]["__schema388"];
            updated_at: components["schemas"]["__schema189"];
            wait: components["schemas"]["__schema394"];
        };
        /** @enum {string} */
        JobState: "queued" | "running" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "needs_reconciliation" | "completed" | "failed" | "cancelled";
        KnowledgeFrontmatter: {
            asserted_by: components["schemas"]["__schema76"];
            audience: components["schemas"]["__schema72"];
            confidence: components["schemas"]["__schema75"];
            created: components["schemas"]["__schema78"];
            id: components["schemas"]["__schema69"];
            links?: components["schemas"]["__schema83"];
            observed_at: components["schemas"]["__schema78"];
            schema_version: components["schemas"]["__schema84"];
            source: components["schemas"]["__schema77"];
            space: components["schemas"]["__schema71"];
            status: components["schemas"]["__schema74"];
            superseded_by?: components["schemas"]["__schema81"];
            supersedes?: components["schemas"]["__schema80"];
            tags?: components["schemas"]["__schema82"];
            title: components["schemas"]["__schema70"];
            type: components["schemas"]["__schema73"];
            updated: components["schemas"]["__schema78"];
            valid_from: components["schemas"]["__schema78"];
            valid_until?: components["schemas"]["__schema79"];
        };
        KnowledgeFrontmatterOutput: {
            asserted_by: components["schemas"]["__schema567"];
            audience: components["schemas"]["__schema565"];
            confidence: components["schemas"]["__schema566"];
            created: components["schemas"]["__schema569"];
            id: components["schemas"]["__schema562"];
            links: components["schemas"]["__schema574"];
            observed_at: components["schemas"]["__schema569"];
            schema_version: components["schemas"]["__schema575"];
            source: components["schemas"]["__schema568"];
            space: components["schemas"]["__schema564"];
            status: components["schemas"]["__schema560"];
            superseded_by: components["schemas"]["__schema572"];
            supersedes: components["schemas"]["__schema571"];
            tags: components["schemas"]["__schema573"];
            title: components["schemas"]["__schema563"];
            type: components["schemas"]["__schema559"];
            updated: components["schemas"]["__schema569"];
            valid_from: components["schemas"]["__schema569"];
            valid_until: components["schemas"]["__schema570"];
        };
        LiveClose: {
            live_id: components["schemas"]["__schema127"];
        };
        LiveClosed: {
            closed: components["schemas"]["__schema597"];
        };
        LiveInputResponse: {
            accepted: components["schemas"]["__schema594"];
        };
        LiveOpen: {
            control_epoch: components["schemas"]["__schema589"];
            expires_at: components["schemas"]["__schema593"];
            live_id: components["schemas"]["__schema588"];
            site_scope: components["schemas"]["__schema591"];
            viewport: components["schemas"]["__schema590"];
        };
        LiveScope: {
            host: components["schemas"]["__schema136"];
            live_id: components["schemas"]["__schema127"];
        };
        LiveScopeResponse: {
            site_scope: components["schemas"]["__schema595"];
        };
        Plugin: {
            description: components["schemas"]["__schema519"];
            fields: components["schemas"]["__schema521"];
            id: components["schemas"]["__schema517"];
            installed: components["schemas"]["__schema523"];
            title: components["schemas"]["__schema518"];
            tools: components["schemas"]["__schema522"];
            version: components["schemas"]["__schema520"];
        };
        /** @enum {string} */
        PrivacyCategory: "account" | "card" | "routing" | "ssn" | "tax_id" | "national_id" | "passport" | "license" | "health" | "address" | "phone" | "email" | "dob" | "credential" | "name" | "private";
        /** @enum {string} */
        PrivacyRoute: "cloud" | "local" | "ask" | "on_device";
        ProcessOutput: {
            process_id: components["schemas"]["__schema696"];
            state: components["schemas"]["__schema699"];
            text: components["schemas"]["__schema700"];
        };
        ProcessPreview: {
            expires_at: components["schemas"]["__schema189"];
            path: components["schemas"]["__schema697"];
            port: components["schemas"]["__schema698"];
            process_id: components["schemas"]["__schema696"];
        };
        ProcessStopped: {
            process_id: components["schemas"]["__schema696"];
            state: components["schemas"]["__schema701"];
        };
        RuntimeEvent: {
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            capture_id: components["schemas"]["__schema705"];
            dedup_key: components["schemas"]["__schema704"];
            detail?: components["schemas"]["__schema711"];
            local_seq: components["schemas"]["__schema703"];
            name: components["schemas"]["__schema706"];
            outcome: components["schemas"]["__schema709"];
            redacted_args_digest: components["schemas"]["__schema710"];
            timing: components["schemas"]["__schema708"];
            tool_name: components["schemas"]["__schema707"];
            /** @constant */
            type: "hook_event";
        } | {
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            capture_id: components["schemas"]["__schema705"];
            dedup_key: components["schemas"]["__schema704"];
            detail?: components["schemas"]["__schema711"];
            /** @enum {string} */
            error_code: "observer_failed" | "delivery_failed" | "capture_gap";
            local_seq: components["schemas"]["__schema703"];
            name: components["schemas"]["__schema706"];
            outcome: components["schemas"]["__schema709"];
            redacted_args_digest: components["schemas"]["__schema710"];
            timing: components["schemas"]["__schema708"];
            tool_name: components["schemas"]["__schema707"];
            /** @constant */
            type: "hook_error";
        } | {
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            dedup_key: components["schemas"]["__schema704"];
            local_seq: components["schemas"]["__schema703"];
            turn: number;
            /** @constant */
            type: "turn_started";
        } | {
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            dedup_key: components["schemas"]["__schema704"];
            local_seq: components["schemas"]["__schema703"];
            text: string;
            /** @constant */
            type: "text_delta";
        } | {
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            dedup_key: components["schemas"]["__schema704"];
            local_seq: components["schemas"]["__schema703"];
            text: string;
            /** @constant */
            type: "reasoning_delta";
        } | {
            arguments: components["schemas"]["__schema412"];
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            call_id: string;
            dedup_key: components["schemas"]["__schema704"];
            local_seq: components["schemas"]["__schema703"];
            tool: string;
            /** @constant */
            type: "tool_call_proposed";
        } | {
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            call_id: string;
            dedup_key: components["schemas"]["__schema704"];
            local_seq: components["schemas"]["__schema703"];
            ok: boolean;
            result: components["schemas"]["__schema412"];
            /** @constant */
            type: "tool_result";
        } | {
            action_id: string;
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            dedup_key: components["schemas"]["__schema704"];
            kind: string;
            local_seq: components["schemas"]["__schema703"];
            /** @constant */
            type: "action_requested";
        } | {
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            dedup_key: components["schemas"]["__schema704"];
            local_seq: components["schemas"]["__schema703"];
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
                action_ids: components["schemas"]["__schema712"][];
                /** @constant */
                kind: "waiting_for_approval";
            } | {
                /** @constant */
                kind: "waiting_for_event_or_time";
                wait: components["schemas"]["__schema394"];
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
            usage?: components["schemas"]["__schema458"];
        } | {
            after_seq: number;
            at: components["schemas"]["__schema189"];
            attempt_id: components["schemas"]["__schema702"];
            dedup_key: components["schemas"]["__schema704"];
            local_seq: components["schemas"]["__schema703"];
            reason: string;
            /** @constant */
            type: "gap";
        };
        SandboxComputer: {
            agent_id: components["schemas"]["__schema370"];
            control: components["schemas"]["__schema373"];
            control_epoch: components["schemas"]["__schema374"];
            egress: components["schemas"]["__schema376"];
            job_id: components["schemas"]["__schema369"];
            running: components["schemas"]["__schema372"];
            session_id: components["schemas"]["__schema368"];
            status: components["schemas"]["__schema371"];
            viewport: components["schemas"]["__schema375"];
        };
        SandboxComputerList: {
            computers: components["schemas"]["__schema367"];
        };
        SandboxControlRequest: {
            control_epoch?: components["schemas"]["__schema137"];
        };
        SandboxControlResponse: {
            control: components["schemas"]["__schema373"];
            control_epoch: components["schemas"]["__schema599"];
            session_id: components["schemas"]["__schema598"];
        };
        /** @enum {string} */
        SensitiveTopic: "health" | "therapy" | "finance";
        Space: {
            audience: components["schemas"]["__schema233"];
            created_at: components["schemas"]["__schema189"];
            git_path: components["schemas"]["__schema235"];
            id: components["schemas"]["__schema230"];
            kind: components["schemas"]["__schema232"];
            name: components["schemas"]["__schema231"];
            owner_principal_id?: components["schemas"]["__schema234"];
        };
        SpaceRemoval: {
            blocked_reason: components["schemas"]["__schema244"];
            counts: components["schemas"]["__schema243"];
            finished_at: components["schemas"]["__schema245"];
            id: components["schemas"]["__schema237"];
            kind: components["schemas"]["__schema240"];
            phase: components["schemas"]["__schema242"];
            space_id: components["schemas"]["__schema238"];
            space_name: components["schemas"]["__schema239"];
            started_at: components["schemas"]["__schema189"];
            state: components["schemas"]["__schema241"];
        };
        SpaceRemovalPreview: {
            confirmation: components["schemas"]["__schema251"];
            counts: components["schemas"]["__schema248"];
            kind: components["schemas"]["__schema240"];
            name: components["schemas"]["__schema247"];
            providers: components["schemas"]["__schema249"];
            space_id: components["schemas"]["__schema246"];
            stays: components["schemas"]["__schema250"];
        };
        SpaceRemovalReport: {
            cleared: components["schemas"]["__schema253"];
            headline: components["schemas"]["__schema252"];
            removal: components["schemas"]["SpaceRemoval"];
            still_yours: components["schemas"]["__schema254"];
        };
        WebReadStatus: {
            available: components["schemas"]["__schema322"];
            enabled: components["schemas"]["__schema321"];
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
