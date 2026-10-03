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
                        "application/json": components["schemas"]["__schema487"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema487"];
                    };
                };
            };
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
                        new_password: components["schemas"]["__schema24"];
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema460"];
                    };
                };
                /** @description No such action */
                404: {
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
                        "application/json": components["schemas"]["__schema460"];
                    };
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
                        "application/json": components["schemas"]["__schema460"];
                    };
                };
                /** @description No signed-in person to record the answer for */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such action among the caller's own */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Action is not awaiting reconciliation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            activity: {
                                destination: string | null;
                                happened_at: components["schemas"]["__schema236"];
                                id: components["schemas"]["__schema232"];
                                /** @enum {string} */
                                outcome: "succeeded";
                                reference: string | null;
                                source: string;
                                what: components["schemas"]["__schema233"];
                                where: components["schemas"]["__schema233"];
                            }[];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
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
                            agents: components["schemas"]["__schema266"][];
                            removed?: components["schemas"]["__schema266"][];
                        } | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema280"] | components["schemas"]["__schema238"];
                    };
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
                            id: components["schemas"]["__schema232"];
                            moved_to: components["schemas"]["__schema232"];
                            routines: number;
                            routines_paused: number;
                        } | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema280"] | components["schemas"]["__schema238"];
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
                                    allowed_connection_ids: components["schemas"]["__schema274"];
                                    asks_before_acting: components["schemas"]["__schema275"];
                                    colour: components["schemas"]["__schema269"];
                                    eye_colour: components["schemas"]["__schema271"];
                                    face_image?: components["schemas"]["__schema279"];
                                    name: components["schemas"]["__schema267"];
                                    reads_memory: components["schemas"]["__schema277"];
                                    role: components["schemas"]["__schema268"];
                                    standing_instruction: components["schemas"]["__schema273"];
                                    surface: components["schemas"]["__schema270"];
                                    tone: components["schemas"]["__schema272"];
                                    uses_computer: components["schemas"]["__schema276"];
                                    writes_memory: components["schemas"]["__schema278"];
                                };
                                benefit: string;
                                /** @enum {string} */
                                category: "Personal" | "Home & family" | "Money" | "Work & email" | "Research" | "Writing" | "Travel" | "Health & routines" | "Learning" | "Code & projects" | "Small business" | "Shopping & subscriptions";
                                day: {
                                    answer: string;
                                    ask: string;
                                    opening: string;
                                    question: {
                                        options: components["schemas"]["__schema290"][];
                                        text: string;
                                    };
                                    work: components["schemas"]["__schema289"][];
                                };
                                does: components["schemas"]["__schema281"][];
                                featured: boolean;
                                id: components["schemas"]["__schema232"];
                                questions: components["schemas"]["__schema286"][];
                                relies_on: components["schemas"]["__schema284"][];
                                skills: components["schemas"]["__schema288"][];
                                starter_routine: {
                                    at: string;
                                    instruction: string;
                                    title: string;
                                    weekdays: components["schemas"]["__schema285"][];
                                } | null;
                                title: components["schemas"]["__schema233"];
                                wont: components["schemas"]["__schema282"][];
                                works_best_with: components["schemas"]["__schema283"][];
                            }[];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema264"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema264"] | components["schemas"]["__schema238"];
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
                                canonical_payload: components["schemas"]["__schema377"];
                                connection_id: string;
                                effect_class: components["schemas"]["EffectClass"];
                                expires_at: components["schemas"]["__schema167"] | null;
                                job_id: string;
                                job_revision: number;
                                kind: string;
                                /** @default [] */
                                origin_warnings: {
                                    description: string;
                                    field: string;
                                    handle: string | null;
                                    origin_trust: components["schemas"]["__schema388"];
                                }[];
                                payload_hash: components["schemas"]["__schema431"];
                                requested_at: components["schemas"]["__schema167"];
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
                            decided_at: components["schemas"]["__schema167"];
                            /** @enum {string} */
                            decision: "approved" | "denied";
                            payload_hash: components["schemas"]["__schema431"];
                        };
                    };
                };
                /** @description The payload changed since this approval was requested */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            apps: components["schemas"]["__schema618"][];
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
                    id: components["schemas"]["__schema149"];
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
                        "application/json": components["schemas"]["__schema626"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
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
                    id: components["schemas"]["__schema149"];
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
                            id: components["schemas"]["__schema619"];
                        };
                    };
                };
                /** @description Not the person who published it */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                    id: components["schemas"]["__schema149"];
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
                        "application/json": components["schemas"]["__schema626"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not a manager of this app */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app, or that version is not one of its own */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    id: components["schemas"]["__schema149"];
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
                        "application/json": components["schemas"]["__schema628"];
                    };
                };
                /** @description Not the publisher or the space owner */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
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
                    id: components["schemas"]["__schema149"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        artifact_id: string;
                        binding: components["schemas"]["__schema151"];
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
                        "application/json": components["schemas"]["__schema628"];
                    };
                };
                /** @description Not the publisher or the space owner */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app or data name, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description A newer version was written, or the file changed, since it was shown */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            name: components["schemas"]["__schema627"];
                            /** @enum {string} */
                            state: "ready" | "none";
                            updated_at: components["schemas"]["__schema167"] | null;
                            value: components["schemas"]["__schema378"];
                        };
                    };
                };
                /** @description No such app or data name, or this person cannot open the app */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The file is not readable as data: too large, not text, or not JSON */
                409: {
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
                    id: components["schemas"]["__schema149"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        grants: components["schemas"]["__schema150"][];
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
                        "application/json": components["schemas"]["__schema626"];
                    };
                };
                /** @description Invalid request, or an email with no account here */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not a manager of this app */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                    before?: components["schemas"]["__schema153"];
                    /** @description Only this collection */
                    collection?: components["schemas"]["__schema152"];
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
                                by: components["schemas"]["__schema620"] | null;
                                collection: components["schemas"]["__schema627"];
                                created_at: components["schemas"]["__schema167"];
                                data: components["schemas"]["__schema377"];
                                id: string;
                                version_id: components["schemas"]["__schema622"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
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
                    id: components["schemas"]["__schema149"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        collection: components["schemas"]["__schema151"];
                        record: components["schemas"]["__schema43"];
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
                            created_at: components["schemas"]["__schema167"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The record is larger than the collection allows */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Too many responses in the last minute, or the app holds its most */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not a manager of this app */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app or response, or this person cannot open the app */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                    id: components["schemas"]["__schema149"];
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
                            expires_at: components["schemas"]["__schema167"];
                            version_id: components["schemas"]["__schema622"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such app, or this person cannot open it */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description An unknown, expired or ended view, or a path the version does not hold */
                404: {
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No matching artifact in this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                            automations: components["schemas"]["__schema309"][];
                        } | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema310"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema310"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema310"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema310"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema310"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema315"] | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema315"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The live view could not open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The live view was already closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    after?: components["schemas"]["__schema109"];
                    /** @description The live id this view was opened with */
                    live_id: components["schemas"]["__schema108"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The live view is closed */
                410: {
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
                    "application/json": components["schemas"]["__schema110"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Input above the rate cap; the view closes */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The host was refused or the scope is full */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such browser session */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Browser control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not the owner of this space */
                404: {
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Owner authentication required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not the owner of this space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The browser could not be cleared */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                            calendar_url?: components["schemas"]["__schema80"];
                            server_url?: components["schemas"]["__schema82"];
                            username: components["schemas"]["__schema81"];
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
                        mcp?: components["schemas"]["__schema73"];
                        mcp_stdio?: {
                            allowed_scopes: components["schemas"]["__schema75"];
                            args?: components["schemas"]["__schema86"];
                            audience: components["schemas"]["__schema77"];
                            command?: components["schemas"]["__schema85"];
                            egress?: components["schemas"]["__schema88"];
                            id: components["schemas"]["__schema74"];
                            runner: components["schemas"]["__schema83"];
                            secret_env?: components["schemas"]["__schema90"];
                            source: components["schemas"]["__schema84"];
                            tools: components["schemas"]["__schema78"];
                        };
                        /** @enum {string} */
                        provider: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp" | "sandbox" | "device" | "command_line" | "apps";
                        sandbox?: {
                            /** @enum {string} */
                            adapter: "e2b" | "daytona" | "modal" | "docker";
                            cidrs?: components["schemas"]["__schema92"][];
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
                        "application/json": components["schemas"]["__schema475"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description MCP installation name already exists */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema475"];
                    };
                };
                /** @description No such connection */
                404: {
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            conversations: components["schemas"]["__schema231"][];
                            next_cursor: string | null;
                        } | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema238"];
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
                            forgotten: components["schemas"]["__schema237"];
                            id: components["schemas"]["__schema232"];
                            stopped: boolean;
                            withdrawn: components["schemas"]["__schema237"];
                        } | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema238"];
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
                            cards: components["schemas"]["__schema247"][];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                                    artifact_id: components["schemas"]["__schema232"];
                                } | null;
                                seen_at: components["schemas"]["__schema236"] | null;
                                session_id: components["schemas"]["__schema232"];
                                title: string | null;
                                url: string | null;
                            } | null;
                            /** @default [] */
                            processes: components["schemas"]["__schema262"][];
                            terminal: components["schemas"]["__schema261"][];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                            drafts: components["schemas"]["__schema257"][];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                            events: components["schemas"]["__schema241"][];
                            has_more: boolean;
                            next_cursor: components["schemas"]["__schema237"];
                        } | components["schemas"]["__schema238"];
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
                            turns: components["schemas"]["__schema240"][];
                        } | components["schemas"]["__schema238"];
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
                                id: components["schemas"]["__schema232"];
                                received_at: components["schemas"]["__schema236"];
                                /** @enum {string} */
                                status: "accepted" | "failed_retry";
                            };
                            turn_id: components["schemas"]["__schema232"];
                        } | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema320"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema320"] | components["schemas"]["__schema238"];
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
                        } | components["schemas"]["__schema238"];
                    };
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
                            receipts: components["schemas"]["__schema250"][];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema238"];
                    };
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
                        activity: components["schemas"]["__schema141"];
                        /** @constant */
                        kind: "heard";
                        text: string;
                    } | {
                        activity: components["schemas"]["__schema141"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Voice is off in a private space, agent or sensitive conversation */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such conversation, or voice mode is not set up */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Too many asides in a short time, or the daily allowance is used up */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such conversation, or voice mode is not set up */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The daily allowance of voice sessions is used up */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The speech provider could not open a session */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Voice is off in a private space, agent or sensitive conversation */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such conversation, or voice mode is not set up */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The daily allowance for reading aloud is used up */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The speech provider could not speak it */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        folders: components["schemas"]["__schema148"][];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        folders: components["schemas"]["__schema148"][];
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
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Using the browser is turned off for this computer */
                403: {
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No request by that id is waiting */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            browser?: components["schemas"]["__schema147"];
                            commands?: components["schemas"]["__schema143"];
                            files?: components["schemas"]["__schema144"];
                            open_url?: components["schemas"]["__schema145"];
                            screenshot?: components["schemas"]["__schema146"];
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
                        "application/json": components["schemas"]["__schema613"];
                    };
                };
                /** @description Device not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Device revoked */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema613"];
                    };
                };
                /** @description Device not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            draft: components["schemas"]["__schema257"];
                            permission: components["schemas"]["__schema255"] | null;
                            receipt: components["schemas"]["__schema250"] | null;
                        } | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema202"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema205"];
                    };
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
                        "application/json": components["schemas"]["__schema205"];
                    };
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
                        "application/json": components["schemas"]["__schema205"];
                    };
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
                        "application/json": components["schemas"]["__schema205"];
                    };
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
                        "application/json": components["schemas"]["__schema205"];
                    };
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
                        "application/json": components["schemas"]["__schema205"];
                    };
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
                        "application/json": components["schemas"]["__schema205"];
                    };
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
                        "application/json": components["schemas"]["__schema202"];
                    };
                };
            };
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
                            prohibitions: components["schemas"]["__schema204"][];
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
                            prohibition: components["schemas"]["__schema204"];
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
                            episodes: components["schemas"]["__schema173"][];
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
                        "application/json": components["schemas"]["__schema178"];
                    };
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
                    after?: components["schemas"]["__schema70"];
                    limit?: components["schemas"]["__schema71"];
                    types?: components["schemas"]["__schema72"];
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
                        "application/json": components["schemas"]["__schema425"];
                    };
                };
            };
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
                                app: components["schemas"]["__schema233"];
                                builtin?: boolean;
                                id: components["schemas"]["__schema232"];
                                label: components["schemas"]["__schema233"];
                                /** @enum {string} */
                                status: "available" | "connecting" | "connected" | "error";
                            }[];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                            source_connection: components["schemas"]["__schema232"];
                            title: components["schemas"]["__schema233"];
                            updated_at: components["schemas"]["__schema236"];
                            value: components["schemas"]["__schema233"];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                            artist: components["schemas"]["__schema233"];
                            image?: components["schemas"]["__schema242"];
                            playing: boolean;
                            source_connection: components["schemas"]["__schema232"];
                            title: components["schemas"]["__schema233"];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema569"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description A session is required */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema569"];
                    };
                };
                /** @description No such report, or not one this person sent */
                404: {
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
                        "application/json": components["schemas"]["__schema569"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Only the person who runs the installation changes a status */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such report */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema490"];
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
                    "application/json": components["schemas"]["__schema107"];
                };
            };
            responses: {
                /** @description Open `authorize_url` in the browser */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema491"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No OAuth client, no public address to return to, or no master key */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema492"];
                    };
                };
                /** @description No sign-in by that id for this person */
                404: {
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
                                failed_reason: ("provider_auth" | "provider_refused" | "provider_unavailable" | "provider_slow" | "daily_budget" | "unreadable_answer" | "too_large" | "no_memory_model" | "other") | null;
                                reason: ("provider_unavailable" | "provider_slow" | "daily_budget") | null;
                                /** @enum {string} */
                                status: "ok" | "waiting";
                                waiting: number;
                            };
                            runtime_adapter?: string;
                            runtime_supervisor?: ("process" | "docker") | null;
                            /** @enum {string} */
                            status: "ok" | "degraded";
                            time: components["schemas"]["__schema167"];
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
                            date: components["schemas"]["__schema233"];
                            greeting: components["schemas"]["__schema233"];
                            open_task_count: components["schemas"]["__schema237"];
                            routine_results: {
                                automation_id: components["schemas"]["__schema232"];
                                conversation_id: components["schemas"]["__schema232"];
                                run: components["schemas"]["__schema307"];
                                title: components["schemas"]["__schema233"];
                            }[];
                            tasks: components["schemas"]["__schema306"][];
                            time_zone: components["schemas"]["__schema233"];
                            upcoming: {
                                connection_id: components["schemas"]["__schema232"];
                                ends_at: components["schemas"]["__schema236"];
                                id: components["schemas"]["__schema232"];
                                starts_at: components["schemas"]["__schema236"];
                                title: components["schemas"]["__schema233"];
                                url?: components["schemas"]["__schema242"];
                            }[] | components["schemas"]["__schema238"];
                            within_day_hours: boolean;
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        payload: components["schemas"]["__schema43"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The connection is not active */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    "Idempotency-Key"?: components["schemas"]["__schema30"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema34"];
                };
            };
            responses: {
                /** @description A retried submission whose first status was not recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description Accepted, or the same key and input submitted again */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"] | components["schemas"]["__schema169"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"] | components["schemas"]["__schema169"];
                    };
                };
                /** @description No such space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
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
                    "Idempotency-Key"?: components["schemas"]["__schema30"];
                };
                path: {
                    /** @description Job ID */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema45"];
                };
            };
            responses: {
                /** @description Accepted, or the same key and input submitted again */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"] | components["schemas"]["__schema169"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"] | components["schemas"]["__schema169"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
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
                            episode: components["schemas"]["__schema173"];
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
                            createdAt: components["schemas"]["__schema167"];
                            inputRefs: string[];
                            jobId: string;
                            scope: components["schemas"]["__schema175"];
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
                        due_at?: components["schemas"]["__schema41"];
                        /** @enum {string} */
                        kind: "timer" | "remote_task" | "local_process";
                        operation_key: components["schemas"]["__schema30"];
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
                        "application/json": components["schemas"]["__schema379"];
                    };
                };
                /** @description Operation key conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema349"];
                    };
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
                                    created_at: components["schemas"]["__schema167"];
                                    /** @default null */
                                    evaluation: {
                                        detail: string;
                                        evaluated_at: components["schemas"]["__schema167"];
                                        passed: boolean;
                                    } | null;
                                    fault_kind: components["schemas"]["__schema436"];
                                    id: string;
                                    job_id: string;
                                    kind: string;
                                    /** @default null */
                                    observed_schema: components["schemas"]["__schema377"] | null;
                                    proposed_mapping: {
                                        [key: string]: string;
                                    };
                                    safe: boolean;
                                    /** @enum {string} */
                                    state: "candidate" | "evaluated" | "applied" | "rejected";
                                    test: {
                                        expected: components["schemas"]["__schema377"];
                                        input: components["schemas"]["__schema377"];
                                        name: string;
                                        operation: string;
                                        /** @default [] */
                                        preserves: {
                                            path: string;
                                            value: string;
                                        }[];
                                    };
                                    updated_at: components["schemas"]["__schema167"];
                                }[];
                                /** @default {} */
                                counters: components["schemas"]["__schema434"];
                                /** @default null */
                                disposition: components["schemas"]["__schema433"] | null;
                                effect_class: components["schemas"]["EffectClass"];
                                /** @default null */
                                intent_key: components["schemas"]["__schema432"] | null;
                                job_id: string;
                                kind: string;
                                payload_hash: components["schemas"]["__schema431"];
                                /** @default null */
                                retry_after_at: components["schemas"]["__schema167"] | null;
                                safe_stop: boolean;
                                status: components["schemas"]["ActionStatus"];
                                /** @default [] */
                                trace: components["schemas"]["__schema435"];
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
                        "application/json": components["schemas"]["__schema349"];
                    };
                };
            };
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
                        importance?: components["schemas"]["__schema39"];
                        scheduling_class?: components["schemas"]["__schema38"];
                        unread_threshold?: components["schemas"]["__schema40"];
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
                        "application/json": components["schemas"]["__schema349"];
                    };
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
                        "application/json": components["schemas"]["__schema376"];
                    };
                };
            };
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
                            all: components["schemas"]["__schema69"][];
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
                                created_at: components["schemas"]["__schema167"];
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
                                        all: components["schemas"]["__schema410"][];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The job has finished */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema409"];
                    };
                };
                /** @description No such job */
                404: {
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
                        "application/json": components["schemas"]["__schema409"];
                    };
                };
                /** @description Job is already finished */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    after?: components["schemas"]["__schema70"];
                    limit?: components["schemas"]["__schema71"];
                    types?: components["schemas"]["__schema72"];
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
                        "application/json": components["schemas"]["__schema425"];
                    };
                };
            };
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
                    "Idempotency-Key"?: components["schemas"]["__schema30"];
                };
                path: {
                    /** @description Job id */
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema45"];
                };
            };
            responses: {
                /** @description Accepted, or the same key and input submitted again */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"] | components["schemas"]["__schema169"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"] | components["schemas"]["__schema169"];
                    };
                };
                /** @description No such job */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
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
                        "application/json": components["schemas"]["__schema412"];
                    };
                };
            };
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
                                status: components["schemas"]["__schema522"];
                                tags: string[];
                                title: string;
                                type: components["schemas"]["__schema521"];
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
                        "application/json": components["schemas"]["__schema523"];
                    };
                };
                /** @description No such record */
                404: {
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
                        "application/json": components["schemas"]["__schema523"];
                    };
                };
                /** @description No such record */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        expected_revision: components["schemas"]["__schema47"];
                        frontmatter: components["schemas"]["KnowledgeFrontmatter"];
                        idempotency_key: components["schemas"]["__schema46"];
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
                        "application/json": components["schemas"]["__schema395"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            proposals: components["schemas"]["__schema407"][];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema407"];
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
                        "application/json": components["schemas"]["__schema407"];
                    };
                };
                /** @description Proposal is stale */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                                status: components["schemas"]["__schema522"];
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
                            items: components["schemas"]["__schema196"][];
                            last_change: components["schemas"]["__schema198"] | null;
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
                        "application/json": components["schemas"]["__schema199"];
                    };
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
                        "application/json": components["schemas"]["__schema199"];
                    };
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
                        "application/json": components["schemas"]["__schema199"];
                    };
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
                        "application/json": components["schemas"]["__schema199"];
                    };
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
                        "application/json": components["schemas"]["__schema199"];
                    };
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
                        "application/json": components["schemas"]["__schema199"];
                    };
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
                            notices: components["schemas"]["__schema200"][];
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
                            episode_id: components["schemas"]["__schema174"] | null;
                            item: components["schemas"]["__schema196"] | null;
                            notice: components["schemas"]["__schema200"];
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
                            notice: components["schemas"]["__schema200"];
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
                    space_id?: components["schemas"]["__schema119"];
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
                            company: components["schemas"]["__schema562"];
                            item: components["schemas"]["__schema565"];
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
                        "application/json": components["schemas"]["__schema565"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Already finished, or no longer quotable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Handling is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema565"];
                    };
                };
                /** @description No such item for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The item is already settled or dropped */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Stopping is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    "application/json": components["schemas"]["__schema68"];
                };
            };
            responses: {
                /** @description Signed in */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema408"];
                    };
                };
                /** @description An email and a password of 8 to 1024 characters are required */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The email or the password is wrong */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The request came from another origin */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No database is configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema489"];
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
                        "application/json": components["schemas"]["__schema489"];
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
                        "application/json": components["schemas"]["__schema489"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Too many tool calls from this connection */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema489"];
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
                        "application/json": components["schemas"]["__schema489"];
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
                        client?: components["schemas"]["__schema97"];
                        label: string;
                        mcp: components["schemas"]["__schema73"];
                        space_id?: string;
                    } | {
                        client?: components["schemas"]["__schema97"];
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
                            expires_at: components["schemas"]["__schema167"];
                            /** Format: uri */
                            issuer: string;
                            /** Format: uri */
                            redirect_uri: string;
                            scopes: components["schemas"]["__schema486"][];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No public address to return to, no master key, a server that needs no sign-in, or one that needs a client registered by hand */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The server or its authorization server did not answer as required */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            expires_at: components["schemas"]["__schema167"];
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
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema408"];
                    };
                };
                /** @description No session, or the session has expired */
                401: {
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
                        display_name: string | null;
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
                                created_at: components["schemas"]["__schema167"];
                                display_name: string | null;
                                /** Format: email */
                                email: string;
                                id: string;
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
            };
        };
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
                        delivered: components["schemas"]["__schema50"][];
                        payload: components["schemas"]["__schema43"];
                        uses: components["schemas"]["__schema49"];
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
                            findings: components["schemas"]["__schema402"][];
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
                                changed_at: components["schemas"]["__schema297"];
                                corrected: boolean;
                                disputed: boolean;
                                earlier: components["schemas"]["__schema298"];
                                id: components["schemas"]["__schema253"];
                                label: components["schemas"]["__schema254"];
                                last_used: components["schemas"]["__schema297"] | null;
                                learned_at: components["schemas"]["__schema297"];
                                source: components["schemas"]["__schema296"];
                                /** @enum {string} */
                                trust: "yours" | "connected" | "outside" | "worked_out";
                                trust_label: components["schemas"]["__schema254"];
                                value: components["schemas"]["__schema295"];
                                version: components["schemas"]["__schema253"];
                            }[];
                            time_zone: components["schemas"]["__schema254"];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                            label: components["schemas"]["__schema254"];
                            versions: {
                                at: components["schemas"]["__schema297"];
                                current: boolean;
                                source: components["schemas"]["__schema296"];
                                value: components["schemas"]["__schema295"];
                            }[];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                                created_at: components["schemas"]["__schema297"];
                                id: components["schemas"]["__schema253"];
                                label: components["schemas"]["__schema254"];
                            }[];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
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
                                audience: components["schemas"]["__schema386"];
                                current: components["schemas"]["__schema395"];
                                domain_key: components["schemas"]["__schema384"];
                                head_revision: components["schemas"]["__schema385"];
                                hidden: components["schemas"]["__schema399"];
                                id: components["schemas"]["__schema345"];
                                key: components["schemas"]["__schema398"];
                                space_id: components["schemas"]["__schema397"];
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
                                audience: components["schemas"]["__schema386"];
                                domain_key: components["schemas"]["__schema384"];
                                head_revision: components["schemas"]["__schema385"];
                                hidden: components["schemas"]["__schema399"];
                                id: components["schemas"]["__schema345"];
                                key: components["schemas"]["__schema398"];
                                space_id: components["schemas"]["__schema397"];
                            };
                            revisions: components["schemas"]["__schema395"][];
                        };
                    };
                };
                /** @description No such claim */
                404: {
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
                                alternative: components["schemas"]["__schema390"];
                                /** @enum {string} */
                                audience: "private" | "space" | "public";
                                claim_id: string;
                                head: components["schemas"]["__schema390"];
                                id: components["schemas"]["__schema400"];
                                key: components["schemas"]["__schema287"];
                                question_id: components["schemas"]["__schema400"] | null;
                                recorded_at: components["schemas"]["__schema167"];
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
                        claim_id: components["schemas"]["__schema33"];
                        content: string;
                        expected_revision: components["schemas"]["__schema47"];
                        idempotency_key: components["schemas"]["__schema46"];
                        text: string;
                        valid_from: components["schemas"]["__schema41"];
                        /** @default null */
                        valid_until?: components["schemas"]["__schema41"] | null;
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
                        "application/json": components["schemas"]["__schema395"];
                    };
                };
                /** @description Stale revision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                                created_at: components["schemas"]["__schema297"];
                                id: components["schemas"]["__schema253"];
                                items: {
                                    at: components["schemas"]["__schema297"];
                                    belief_id: components["schemas"]["__schema253"];
                                    /** @enum {string} */
                                    change: "learned" | "changed" | "corrected";
                                    current: boolean;
                                    label: components["schemas"]["__schema254"];
                                    previous: components["schemas"]["__schema295"] | null;
                                    value: components["schemas"]["__schema295"];
                                    version: components["schemas"]["__schema253"] | null;
                                }[];
                                seen_at: components["schemas"]["__schema297"] | null;
                                title: components["schemas"]["__schema254"];
                                week_of: components["schemas"]["__schema299"];
                                window_end: components["schemas"]["__schema297"];
                                window_start: components["schemas"]["__schema297"];
                            } | null;
                            next_at: components["schemas"]["__schema297"];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                            filename: components["schemas"]["__schema254"];
                            /** @enum {string} */
                            format: "json" | "markdown";
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        claim_id?: components["schemas"]["__schema33"];
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
                        "application/json": components["schemas"]["__schema396"];
                    };
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
                            imported: components["schemas"]["__schema298"];
                            notes: components["schemas"]["__schema254"][];
                            skipped: components["schemas"]["__schema298"];
                        } | components["schemas"]["__schema238"];
                    };
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
                            items: components["schemas"]["__schema291"][];
                            next?: components["schemas"]["__schema232"] | null;
                        } | components["schemas"]["__schema238"];
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
                            item: components["schemas"]["__schema291"];
                        } | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
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
                            reasons: components["schemas"]["__schema233"][];
                            used_at: components["schemas"]["__schema236"] | null;
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                                affected: components["schemas"]["__schema406"][];
                                changed_handle: components["schemas"]["__schema390"];
                                created_at: components["schemas"]["__schema167"];
                                id: components["schemas"]["__schema400"];
                                job_id: string;
                                key: components["schemas"]["__schema287"] | null;
                                new_value: components["schemas"]["__schema405"];
                                old_value: components["schemas"]["__schema405"];
                                replacement_handle: components["schemas"]["__schema390"] | null;
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
                        output_id: components["schemas"]["__schema48"];
                        output_version: components["schemas"]["__schema48"];
                        uses: components["schemas"]["__schema49"];
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
                            output_id: components["schemas"]["__schema400"];
                            output_version: components["schemas"]["__schema400"];
                            unknown_handles: components["schemas"]["__schema401"][];
                        };
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                                because: components["schemas"]["__schema390"][];
                                created_at: components["schemas"]["__schema167"];
                                id: components["schemas"]["__schema400"];
                                if_ignored: string;
                                key: components["schemas"]["__schema287"];
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
                        at?: components["schemas"]["__schema41"];
                        job_id?: string;
                        /** @default 10 */
                        limit?: components["schemas"]["__schema47"];
                        /** @default 2000 */
                        max_tokens?: components["schemas"]["__schema47"];
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
                                authoritative_revision: components["schemas"]["__schema387"];
                                indexed_revision: components["schemas"]["__schema387"];
                                /** @enum {string} */
                                reason: "ready" | "index_lag" | "budget" | "timeout" | "index_failure" | "restore_pending" | "public_compartment" | "withheld";
                                supplemented: components["schemas"]["__schema387"];
                                truncated: boolean;
                            };
                            /** @default [] */
                            disputed_keys: components["schemas"]["__schema287"][];
                            index_generation: components["schemas"]["__schema387"] | null;
                            items: {
                                claim_id: components["schemas"]["__schema345"];
                                content: string;
                                /** @default false */
                                disputed: boolean;
                                domain_key: components["schemas"]["__schema384"];
                                excerpts: string[];
                                factual_status: components["schemas"]["__schema392"];
                                handle: components["schemas"]["__schema390"];
                                /** @default null */
                                key: components["schemas"]["__schema287"] | null;
                                kind: components["schemas"]["__schema391"];
                                /** @default inferred */
                                origin_trust: components["schemas"]["__schema388"];
                                recorded_at: components["schemas"]["__schema167"];
                                revision: components["schemas"]["__schema385"];
                                sources: components["schemas"]["__schema394"][];
                                status: components["schemas"]["__schema393"];
                                superseded_at: components["schemas"]["__schema167"] | null;
                                valid_from: components["schemas"]["__schema167"];
                                valid_until: components["schemas"]["__schema167"] | null;
                            }[];
                            recipe: components["schemas"]["__schema384"];
                            snapshot: components["schemas"]["__schema389"] | null;
                            /** @enum {string} */
                            status: "complete" | "degraded" | "unavailable";
                            token_budget: {
                                /** @enum {string} */
                                counter: "utf8-bytes-upper-bound-v1" | "utf8-bytes-quarter-v1";
                                limit: components["schemas"]["__schema385"];
                                used: components["schemas"]["__schema387"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                                recorded_at: components["schemas"]["__schema167"];
                                work_id: components["schemas"]["__schema400"];
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
                        "application/json": components["schemas"]["__schema302"] | components["schemas"]["__schema238"];
                    };
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
                            label: components["schemas"]["__schema254"];
                            skipped: components["schemas"]["__schema254"][];
                            steps: components["schemas"]["__schema301"][];
                        } | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema302"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema292"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema292"] | components["schemas"]["__schema238"];
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
                        event_at: components["schemas"]["__schema41"];
                        source_identity: components["schemas"]["__schema46"];
                        /** @enum {string} */
                        source_type: "message" | "document" | "observation" | "receipt" | "assistant";
                        source_version: components["schemas"]["__schema46"];
                        stream: components["schemas"]["__schema46"];
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
                            committed_sequence: components["schemas"]["__schema385"];
                            duplicate: boolean;
                            source: components["schemas"]["__schema382"];
                        };
                    };
                };
                /** @description Invalid evidence */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Scope denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            source: components["schemas"]["__schema382"];
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
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema396"];
                    };
                };
                /** @description No such source */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                                    at: components["schemas"]["__schema297"];
                                    belief_id: components["schemas"]["__schema253"];
                                    /** @enum {string} */
                                    change: "learned" | "changed" | "corrected" | "restored" | "removed";
                                    label: components["schemas"]["__schema254"];
                                    previous: components["schemas"]["__schema295"] | null;
                                    value: components["schemas"]["__schema295"] | null;
                                }[];
                                day: components["schemas"]["__schema299"];
                                label: components["schemas"]["__schema254"];
                                rewinds: components["schemas"]["__schema300"][];
                            }[];
                            time_zone: components["schemas"]["__schema254"];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        handles: components["schemas"]["__schema49"];
                        payload: components["schemas"]["__schema43"];
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
                            fields: components["schemas"]["__schema403"][];
                            minimum_trust: components["schemas"]["__schema388"];
                            unresolved: components["schemas"]["__schema404"][];
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
                        "application/json": components["schemas"]["__schema412"];
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
                            reaction: components["schemas"]["__schema411"];
                        };
                    };
                };
                /** @description No such message */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description That event is not a message */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema490"];
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
                    "application/json": components["schemas"]["__schema107"];
                };
            };
            responses: {
                /** @description Open `authorize_url` in the browser */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema491"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No OAuth client, no public address to return to, or no master key */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema492"];
                    };
                };
                /** @description No sign-in by that id for this person */
                404: {
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
                    provider: components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema592"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
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
        /**
         * Start signing the installation in to a model provider
         * @description A device sign-in answers with a code to enter at the provider’s verification page. A browser sign-in answers with an address to open; the provider then sends the browser to `redirect_uri`, and that whole address is passed to complete. A newer start for the same provider replaces an unfinished one; either expires after fifteen minutes.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: components["schemas"]["__schema136"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description `device` shows a code to enter at the provider; `browser` returns an address to open, after which the address the browser was sent back to is pasted into complete. Left out, the provider’s first method. */
                        method?: components["schemas"]["__schema137"];
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
                            expires_at: components["schemas"]["__schema167"];
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
                            expires_at: components["schemas"]["__schema167"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The provider could not be reached or refused the request */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                    provider: components["schemas"]["__schema136"];
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
                        "application/json": components["schemas"]["__schema592"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description This installation offers no sign-in for that provider */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                    provider: components["schemas"]["__schema136"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description For a browser sign-in: the whole address the provider sent the browser back to. Its state must match the sign-in it completes. */
                        callback_url?: components["schemas"]["__schema138"];
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
                        "application/json": components["schemas"]["__schema592"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No unfinished sign-in by that id */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The provider could not be reached or refused the code */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            providers: components["schemas"]["__schema592"][];
                        };
                    };
                };
                /** @description Only the setup owner manages model sign-in */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set, so nothing can be sealed */
                503: {
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
                        "application/json": components["schemas"]["__schema587"];
                    };
                };
                /** @description Not signed in */
                401: {
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
                        /** @description Whether this model reads images. Left out or null, Melete’s model catalog decides; set it for a model the catalog does not know. */
                        supports_vision?: components["schemas"]["__schema134"];
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
                        "application/json": components["schemas"]["__schema587"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The provider has no key or sign-in yet */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema587"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                    provider: components["schemas"]["__schema131"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        api_key: string;
                        /** @description Required for, and only for, the OpenAI-compatible endpoint */
                        base_url?: components["schemas"]["__schema133"];
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
                        "application/json": components["schemas"]["__schema587"];
                    };
                };
                /** @description Invalid key or endpoint address */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The server environment already sets this provider’s key */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description MELETE_MASTER_KEY is not set, so the key cannot be sealed */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                    provider: components["schemas"]["__schema131"];
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
                        "application/json": components["schemas"]["__schema587"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        api_key?: components["schemas"]["__schema132"];
                        base_url?: components["schemas"]["__schema133"];
                        provider: components["schemas"]["__schema131"];
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
                            models: components["schemas"]["__schema590"][];
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
                            status: components["schemas"]["__schema591"] | null;
                        };
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        supports_vision: components["schemas"]["__schema135"] | null;
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
                        "application/json": components["schemas"]["__schema587"];
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Only the setup owner changes the model */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The model in use has changed since the page loaded */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                            notifications: components["schemas"]["__schema381"][];
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
                        "application/json": components["schemas"]["__schema381"];
                    };
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
                        "application/json": components["schemas"]["__schema381"];
                    };
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
                    client_id: components["schemas"]["__schema100"];
                    code_challenge: components["schemas"]["__schema102"];
                    code_challenge_method: components["schemas"]["__schema103"];
                    redirect_uri: components["schemas"]["__schema101"];
                    resource?: components["schemas"]["__schema106"];
                    response_type: components["schemas"]["__schema99"];
                    scope?: components["schemas"]["__schema105"];
                    state?: components["schemas"]["__schema104"];
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
                        client_id: components["schemas"]["__schema100"];
                        code_challenge: components["schemas"]["__schema102"];
                        code_challenge_method: components["schemas"]["__schema103"];
                        consent: string;
                        /** @enum {string} */
                        decision: "allow" | "deny";
                        redirect_uri: components["schemas"]["__schema101"];
                        resource?: components["schemas"]["__schema106"];
                        response_type: components["schemas"]["__schema99"];
                        scope?: components["schemas"]["__schema105"];
                        state?: components["schemas"]["__schema104"];
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
                        redirect_uris: components["schemas"]["__schema98"][];
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
                        "application/json": components["schemas"]["__schema488"];
                    };
                };
                /** @description Too many registrations from this address, or too many waiting for a person to allow them */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema488"];
                    };
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
                        "application/json": components["schemas"]["__schema488"];
                    };
                };
                /** @description The client is not registered */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema488"];
                    };
                };
                /** @description Too many requests from this address */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema488"];
                    };
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
                            operations: components["schemas"]["__schema379"][];
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
                        version: components["schemas"]["__schema42"];
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
                        "application/json": components["schemas"]["__schema379"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        due_at: components["schemas"]["__schema41"];
                        version: components["schemas"]["__schema42"];
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
                        "application/json": components["schemas"]["__schema379"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        result: components["schemas"]["__schema43"];
                        version: components["schemas"]["__schema42"];
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
                        "application/json": components["schemas"]["__schema379"];
                    };
                };
                /** @description Stale operation */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                        new_password: components["schemas"]["__schema24"];
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                                id: components["schemas"]["__schema328"];
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
                            permissions: components["schemas"]["__schema255"][];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                            rule: components["schemas"]["__schema263"] | null;
                            /** @constant */
                            status: "ok";
                        } | components["schemas"]["__schema238"];
                    };
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
                            plans: components["schemas"]["__schema303"][];
                        } | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema304"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema304"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema239"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema304"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema238"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Space owner and matching audience required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such plugin */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The plugin is already added to this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Opened as a page of its own rather than framed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description An unknown, expired or ended preview */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The server did not answer, answered too much, or sent the page elsewhere */
                502: {
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Opened as a page of its own rather than framed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description An unknown, expired or ended preview */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The server did not answer, answered too much, or sent the page elsewhere */
                502: {
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
                                created_at: components["schemas"]["__schema167"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Email already registered */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            models: components["schemas"]["__schema319"][];
                            ok: boolean;
                        } | components["schemas"]["__schema238"];
                    };
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
                        } | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema316"] | components["schemas"]["__schema238"];
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
                        add_known_values?: components["schemas"]["__schema26"][];
                        enabled?: components["schemas"]["PrivacyCategory"][];
                        local_detection?: boolean;
                        local_model?: {
                            api_key?: string | null;
                            /** Format: uri */
                            base_url: string;
                            model: string;
                        } | null;
                        model_on_device?: boolean;
                        private_agent_ids?: components["schemas"]["__schema25"][];
                        private_space?: boolean;
                        remove_known_values?: components["schemas"]["__schema27"][];
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
                        "application/json": components["schemas"]["__schema316"] | components["schemas"]["__schema238"];
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
                            procedures: components["schemas"]["__schema179"][];
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
                        "application/json": components["schemas"]["__schema195"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema178"];
                    };
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
                        "application/json": components["schemas"]["__schema178"];
                    };
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
                        "application/json": components["schemas"]["__schema195"];
                    };
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
                        "application/json": components["schemas"]["__schema178"];
                    };
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
                        "application/json": components["schemas"]["__schema178"];
                    };
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
                        "application/json": components["schemas"]["__schema178"];
                    };
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
                        "application/json": components["schemas"]["__schema305"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema305"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema171"];
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
                        "application/json": components["schemas"]["__schema171"];
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
                            subscriptions: components["schemas"]["__schema166"][];
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
                        "application/json": components["schemas"]["__schema168"];
                    };
                };
                /** @description Not a push service this installation sends to, or keys a browser does not subscribe with */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Push is not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema168"];
                    };
                };
                /** @description No such subscription for this person */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                            questions: components["schemas"]["__schema375"][];
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
                            error?: components["schemas"]["__schema170"];
                            job: components["schemas"]["__schema349"] | null;
                            question: components["schemas"]["__schema375"];
                            receipt: components["schemas"]["__schema372"] | null;
                        };
                    };
                };
                /** @description The question is no longer open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            questions: components["schemas"]["__schema258"][];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                            receipt: components["schemas"]["__schema250"];
                        } | components["schemas"]["__schema238"];
                    };
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
                            obligations: components["schemas"]["__schema380"][];
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
                        "application/json": components["schemas"]["__schema380"];
                    };
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
                    "Idempotency-Key"?: components["schemas"]["__schema30"];
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["__schema34"];
                };
            };
            responses: {
                /** @description A retried submission whose first status was not recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description Accepted, or the same key and input submitted again */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The input or the Idempotency-Key is invalid; a rejected input still has a receipt */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"] | components["schemas"]["__schema169"];
                    };
                };
                /** @description The space or job is not accessible, recorded as a rejected submission; a retried key whose history belongs to another account answers with an error body alone */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"] | components["schemas"]["__schema169"];
                    };
                };
                /** @description No such space */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The key was used for different input, or the job cannot take this now */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
                };
                /** @description The acceptance history of this key cannot be verified; reusing it admits nothing new */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema348"];
                    };
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
                                created_at: components["schemas"]["__schema167"];
                                id: components["schemas"]["__schema321"];
                                my_role: components["schemas"]["__schema324"];
                                name: components["schemas"]["__schema322"];
                                purpose: components["schemas"]["__schema323"];
                                unread: components["schemas"]["__schema325"];
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
                        "application/json": components["schemas"]["__schema326"];
                    };
                };
                /** @description Only a person can make a room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    id: components["schemas"]["__schema28"];
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
                        "application/json": components["schemas"]["__schema326"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
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
                    id: components["schemas"]["__schema28"];
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
                            member: components["schemas"]["__schema327"];
                        };
                    };
                };
                /** @description Only an owner of the room adds people */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            removed: components["schemas"]["__schema328"];
                        };
                    };
                };
                /** @description Only an owner removes someone else; the owner cannot be removed */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                    id: components["schemas"]["__schema28"];
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
                                claim_id: components["schemas"]["__schema345"];
                                content: string;
                                key: string | null;
                                label: string;
                                recorded_at: components["schemas"]["__schema167"];
                                said_by: components["schemas"]["__schema331"][];
                            }[];
                            shares: components["schemas"]["__schema346"][];
                        };
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
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
                            forgotten: components["schemas"]["__schema345"];
                        };
                    };
                };
                /** @description Only an owner of the room, or the person whose words it rests on */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            message: components["schemas"]["__schema333"];
                        };
                    };
                };
                /** @description Only the person who wrote it */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
            };
        };
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
                    id: components["schemas"]["__schema28"];
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
                            present: components["schemas"]["__schema328"][];
                        };
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            request: components["schemas"]["__schema334"];
                        };
                    };
                };
                /** @description Only the person who asked, or an owner of the room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    id: components["schemas"]["__schema28"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        claim_id: components["schemas"]["__schema33"];
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
                        "application/json": components["schemas"]["__schema347"];
                    };
                };
                /** @description Shared */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema347"];
                    };
                };
                /** @description Guests share nothing into a room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not in this room, or no such detail in your own memory */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The detail came from a private conversation and stays yours */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            withdrawn: components["schemas"]["__schema330"];
                        };
                    };
                };
                /** @description Only the person who shared it, or an owner of the room */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Memory is not running on this installation */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                    id: components["schemas"]["__schema28"];
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
                            threads: components["schemas"]["__schema329"][];
                        };
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
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
                    id: components["schemas"]["__schema28"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        ask_agent?: boolean;
                        submission_id: components["schemas"]["__schema30"];
                        text: components["schemas"]["__schema29"];
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
                        "application/json": components["schemas"]["__schema332"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The submission ID belongs to a different message */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    id: components["schemas"]["__schema31"];
                    threadId: components["schemas"]["__schema32"];
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
                            messages: components["schemas"]["__schema333"][];
                            requests: components["schemas"]["__schema334"][];
                            thread: components["schemas"]["__schema329"];
                        };
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
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
                                message: components["schemas"]["__schema333"];
                                seq: number;
                            } | {
                                event: components["schemas"]["__schema241"];
                                /** @constant */
                                kind: "request";
                                request_job_id: components["schemas"]["__schema330"];
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
                    id: components["schemas"]["__schema31"];
                    threadId: components["schemas"]["__schema32"];
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        submission_id: components["schemas"]["__schema30"];
                        text: components["schemas"]["__schema29"];
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
                        "application/json": components["schemas"]["__schema332"];
                    };
                };
                /** @description Not in this room, or no such room */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The thread is closed, or the submission ID belongs to a different message */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            rules: components["schemas"]["__schema263"][];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
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
                            runs: components["schemas"]["__schema311"][];
                        } | components["schemas"]["__schema238"];
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
                        limit?: components["schemas"]["__schema23"];
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
                        "application/json": components["schemas"]["__schema314"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema314"] | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        limit?: components["schemas"]["__schema23"] | null;
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
                        "application/json": components["schemas"]["__schema314"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema314"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema314"] | components["schemas"]["__schema238"];
                    };
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
                                created_at: components["schemas"]["__schema167"];
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
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema314"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema314"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such job */
                404: {
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
                    id: components["schemas"]["__schema154"];
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
                    id: components["schemas"]["__schema154"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such process, or this person cannot watch its computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The process is not running, serves no port, or cannot be reached */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    id: components["schemas"]["__schema154"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such process, or this person cannot watch its computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
         * @description Increments the control epoch again. The job stays parked until the person answers it.
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The live view could not open */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The live view was already closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    after?: components["schemas"]["__schema118"];
                    /** @description The live id this view was opened with */
                    live_id: components["schemas"]["__schema108"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The live view is closed */
                410: {
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
                    "application/json": components["schemas"]["__schema110"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused, or another person or address */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The person does not hold control */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The live view is closed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
         * @description Requires the owner session and same-origin protection. The control epoch is incremented and the job is parked waiting for input before this answers; every computer action the agent planned before is refused from then on.
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Request origin refused */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such computer */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Control could not change */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such screenshot for this person */
                404: {
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
                                conversation_id: components["schemas"]["__schema232"] | null;
                                id: components["schemas"]["__schema232"];
                                /** @enum {string} */
                                kind: "conversation" | "plan" | "task" | "event" | "connection" | "action";
                                meta: string;
                                title: components["schemas"]["__schema233"];
                            }[];
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema169"];
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
                    "application/json": components["schemas"]["__schema68"];
                };
            };
            responses: {
                /** @description The owner, signed in */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema408"];
                    };
                };
                /** @description An email and a password of 8 to 1024 characters are required */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The request came from another origin */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The owner is already set up */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No database is configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["__schema238"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema238"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema238"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
                    };
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
                                    triggers: components["schemas"]["__schema538"][];
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
                        "application/json": components["schemas"]["__schema376"];
                    };
                };
            };
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
                                principal_id: components["schemas"]["__schema232"];
                                /** @enum {string} */
                                role: "owner" | "member";
                                you: boolean;
                            }[];
                            space: {
                                id: components["schemas"]["__schema232"];
                                /** @enum {string} */
                                kind: "personal" | "shared";
                                name: components["schemas"]["__schema233"];
                                /** @enum {string} */
                                role: "owner" | "member";
                            };
                        } | components["schemas"]["__schema238"];
                    };
                };
            };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Space owner required, or no such space */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The browser worker uses this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
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
                            membership: components["schemas"]["__schema212"];
                        };
                    };
                };
                /** @description Space owner required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            membership: components["schemas"]["__schema212"];
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
                        "application/json": components["schemas"]["__schema169"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            companies: components["schemas"]["__schema562"][];
                            currency: components["schemas"]["__schema564"];
                            items: components["schemas"]["__schema565"][];
                            totals: {
                                data_holders: number;
                                monthly_spend_minor: components["schemas"]["__schema563"];
                                owed_to_you_minor: components["schemas"]["__schema563"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No mailbox is connected to this space */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            note?: components["schemas"]["__schema561"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description No such scan in this space */
                404: {
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
                            receipt: components["schemas"]["__schema372"];
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
                            tasks: components["schemas"]["__schema306"][];
                        } | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema308"] | components["schemas"]["__schema238"];
                    };
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
                        "application/json": components["schemas"]["__schema265"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["__schema308"] | components["schemas"]["__schema238"];
                    };
                };
            };
        };
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
                    agent_id?: components["schemas"]["__schema140"];
                    conversation_id?: components["schemas"]["__schema139"];
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
                    agent_id?: components["schemas"]["__schema140"];
                    conversation_id?: components["schemas"]["__schema139"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Voice is off in a private space, agent or sensitive conversation */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Voice is not set up on this installation, or no such conversation */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The recording is longer or larger than the limit */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The daily allowance for transcription is used up */
                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description The speech provider could not transcribe it */
                502: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                    space_id?: components["schemas"]["__schema120"];
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
                            currency: components["schemas"]["__schema564"];
                            owed: components["schemas"]["__schema568"][];
                            owed_minor: components["schemas"]["__schema563"];
                            replies: components["schemas"]["__schema568"][];
                            scan: {
                                connected: boolean;
                                finished_at: components["schemas"]["__schema167"] | null;
                                space_id: string | null;
                                stale: boolean;
                                /** @enum {string} */
                                status: "none" | "running" | "done" | "failed";
                            };
                            top: components["schemas"]["__schema568"][];
                        };
                    };
                };
                /** @description This space is not accessible to the signed-in account */
                403: {
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Already finished, or no longer quotable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Chasing is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                            evidence: components["schemas"]["__schema567"];
                            id: string;
                            job_id: string | null;
                            message_id: string;
                            principal_id: string;
                            sent_at: components["schemas"]["__schema167"];
                            space_id: string;
                            status: components["schemas"]["__schema566"];
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
                        "application/json": components["schemas"]["__schema169"];
                    };
                };
                /** @description Stopping its chase is not connected yet */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["__schema169"];
                    };
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
                        "application/json": components["schemas"]["WebReadStatus"] | components["schemas"]["__schema238"];
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
                        "application/json": components["schemas"]["WebReadStatus"] | components["schemas"]["__schema238"];
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
        __schema23: {
            max_hours?: number;
            max_output_tokens?: number;
            max_shifts?: number;
        };
        __schema24: string;
        __schema25: string;
        __schema26: {
            category: components["schemas"]["PrivacyCategory"];
            label: string;
            value: string;
        };
        __schema27: string;
        /** @description Room id */
        __schema28: string;
        __schema29: string;
        __schema30: string;
        __schema31: string;
        __schema32: string;
        __schema33: string;
        __schema34: {
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
            importance?: components["schemas"]["__schema36"];
            learning?: components["schemas"]["__schema1"];
            objective: string;
            /** @default interactive */
            scheduling_class?: components["schemas"]["__schema35"];
            space_id: string;
            title: string;
            /** @default 3 */
            unread_threshold?: components["schemas"]["__schema37"];
        };
        /** @enum {string} */
        __schema35: "interactive" | "background" | "quiet";
        /** @enum {string} */
        __schema36: "routine" | "important";
        __schema37: number;
        __schema38: components["schemas"]["__schema35"];
        __schema39: components["schemas"]["__schema36"];
        __schema40: components["schemas"]["__schema37"];
        /** Format: date-time */
        __schema41: string;
        __schema42: number;
        __schema43: {
            [key: string]: components["schemas"]["__schema44"];
        };
        __schema44: (string | number | boolean | null) | components["schemas"]["__schema44"][] | {
            [key: string]: components["schemas"]["__schema44"];
        };
        __schema45: {
            corrects?: components["schemas"]["__schema15"];
            text: string;
        };
        __schema46: string;
        __schema47: number;
        __schema48: string;
        __schema49: components["schemas"]["__schema5"][];
        __schema50: {
            content: string;
            /** @default [] */
            excerpts?: components["schemas"]["__schema51"][];
            handle: components["schemas"]["__schema6"];
            /** @default null */
            key?: components["schemas"]["__schema18"] | null;
        };
        __schema51: string;
        __schema52: string;
        __schema53: string;
        __schema54: string;
        /** @enum {string} */
        __schema55: "private" | "space" | "public";
        /** @enum {string} */
        __schema56: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema57: "active" | "superseded" | "retracted" | "disputed";
        /** @enum {string} */
        __schema58: "high" | "medium" | "low";
        /** @enum {string} */
        __schema59: "user" | "agent" | "document" | "tool";
        __schema60: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote?: string;
            ref: string;
            /** @default null */
            sha256?: string | null;
        };
        /** Format: date */
        __schema61: string;
        /** @default null */
        __schema62: components["schemas"]["__schema61"] | null;
        /** @default [] */
        __schema63: components["schemas"]["__schema52"][];
        /** @default null */
        __schema64: components["schemas"]["__schema52"] | null;
        /** @default [] */
        __schema65: string[];
        /** @default [] */
        __schema66: components["schemas"]["__schema52"][];
        /** @constant */
        __schema67: 1;
        __schema68: {
            /** Format: email */
            email: string;
            password: string;
        };
        __schema69: {
            field: string;
            /** @enum {string} */
            op: "eq" | "contains" | "matches" | "lt" | "gt" | "changed";
            /** @default null */
            value?: string | number | boolean | null;
        };
        /** @default 0 */
        __schema70: number;
        /** @default 200 */
        __schema71: number;
        __schema72: ("job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "reasoning_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error")[];
        __schema73: {
            allowed_scopes: components["schemas"]["__schema75"];
            audience: components["schemas"]["__schema77"];
            id: components["schemas"]["__schema74"];
            tools: components["schemas"]["__schema78"];
            /** Format: uri */
            url: string;
        };
        __schema74: string;
        __schema75: components["schemas"]["__schema76"][];
        __schema76: string;
        /** @constant */
        __schema77: "owner";
        __schema78: components["schemas"]["__schema79"][];
        __schema79: {
            alias: string;
            /** @default write_external */
            effect_class?: components["schemas"]["EffectClass"];
            name: string;
            required_scopes: components["schemas"]["__schema76"][];
        };
        /** Format: uri */
        __schema80: string;
        __schema81: string;
        /** Format: uri */
        __schema82: string;
        /** @enum {string} */
        __schema83: "npx" | "uvx" | "image";
        __schema84: string;
        __schema85: string;
        /** @default [] */
        __schema86: components["schemas"]["__schema87"][];
        __schema87: string;
        /** @default [] */
        __schema88: components["schemas"]["__schema89"][];
        __schema89: "*" | string;
        /** @default [] */
        __schema90: components["schemas"]["__schema91"][];
        __schema91: {
            name: string;
            value: string;
        };
        __schema92: string;
        /** @enum {string} */
        __schema93: "github" | "aws" | "gitlab" | "npm";
        __schema94: string;
        __schema95: string;
        __schema96: string;
        __schema97: {
            client_id: string;
            client_secret?: string;
        };
        __schema98: string;
        /** @constant */
        __schema99: "code";
        __schema100: string;
        __schema101: string;
        __schema102: string;
        /** @constant */
        __schema103: "S256";
        __schema104: string;
        __schema105: string;
        __schema106: string;
        __schema107: {
            calendar_label?: string;
            mail_label?: string;
            space_id?: string;
        };
        __schema108: string;
        __schema109: string;
        __schema110: {
            ack_through: number;
            events: components["schemas"]["__schema111"][];
            live_id: components["schemas"]["__schema108"];
        };
        __schema111: {
            button: 0 | 1 | 2;
            clicks: 1 | 2 | 3;
            /** @enum {string} */
            k: "move" | "down" | "up";
            mods: components["schemas"]["__schema114"];
            x: components["schemas"]["__schema112"];
            y: components["schemas"]["__schema113"];
        } | {
            dx: components["schemas"]["__schema115"];
            dy: components["schemas"]["__schema115"];
            /** @constant */
            k: "wheel";
            mods: components["schemas"]["__schema114"];
            x: components["schemas"]["__schema112"];
            y: components["schemas"]["__schema113"];
        } | {
            code: string;
            down: boolean;
            /** @constant */
            k: "key";
            key: string;
            mods: components["schemas"]["__schema114"];
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
            points: components["schemas"]["__schema116"][];
        };
        __schema112: number;
        __schema113: number;
        __schema114: number;
        __schema115: number;
        __schema116: {
            id: number;
            x: components["schemas"]["__schema112"];
            y: components["schemas"]["__schema113"];
        };
        __schema117: string;
        __schema118: string;
        __schema119: string;
        __schema120: string;
        __schema121: string;
        __schema122: string;
        __schema123: string;
        __schema124: string;
        __schema125: {
            height: number;
            pixel_ratio?: number;
            width: number;
        };
        /** @enum {string} */
        __schema126: "light" | "dark";
        __schema127: components["schemas"]["__schema128"][];
        __schema128: {
            at: components["schemas"]["__schema41"];
            message: string;
        };
        __schema129: components["schemas"]["__schema130"][];
        __schema130: {
            at: components["schemas"]["__schema41"];
            code: string | null;
            method: string;
            status: number | null;
            url: string;
        };
        /** @enum {string} */
        __schema131: "anthropic" | "openai" | "google" | "fireworks" | "openai-compatible";
        __schema132: string;
        /** @description The endpoint’s version prefix, for example https://models.example.net/v1 */
        __schema133: string;
        __schema134: boolean | null;
        __schema135: boolean;
        /** @enum {string} */
        __schema136: "chatgpt" | "openai-compatible";
        /** @enum {string} */
        __schema137: "device" | "browser";
        __schema138: string;
        __schema139: string;
        __schema140: string;
        __schema141: {
            now: string | null;
            steps: components["schemas"]["__schema142"][];
        };
        __schema142: string;
        __schema143: boolean;
        __schema144: boolean;
        __schema145: boolean;
        __schema146: boolean;
        /** @default false */
        __schema147: boolean;
        __schema148: {
            name: string;
            path: string;
        };
        /** @description App id */
        __schema149: string;
        __schema150: {
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
        __schema151: string;
        __schema152: string;
        __schema153: string;
        /** @description Process id from the conversation's computer view */
        __schema154: string;
        __schema155: string;
        __schema156: number;
        __schema157: string;
        __schema158: string;
        /** @enum {string} */
        __schema159: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema160: string | null;
        __schema161: {
            captured_at: components["schemas"]["__schema41"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema162: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema163: string | null;
        __schema164: {
            compression_count?: number;
            in_place?: boolean;
            used_fallback?: boolean;
        };
        __schema165: string;
        __schema166: {
            created_at: components["schemas"]["__schema167"];
            device_label: string;
            endpoint_hash: string;
            id: string;
            last_used_at: components["schemas"]["__schema167"] | null;
        };
        /** Format: date-time */
        __schema167: string;
        __schema168: {
            subscription: components["schemas"]["__schema166"];
        };
        __schema169: {
            error: components["schemas"]["__schema170"];
        };
        __schema170: {
            code: string;
            detail?: {
                [key: string]: unknown;
            };
            message: string;
        };
        __schema171: {
            settings: {
                batch_minutes: number;
                daily_cap: number;
                decisions: boolean;
                quiet_hours: {
                    from: components["schemas"]["__schema172"];
                    time_zone: string;
                    until: components["schemas"]["__schema172"];
                };
                settled: boolean;
                weekly_summary: boolean;
            };
        };
        __schema172: string;
        __schema173: {
            actor: string;
            artifacts: components["schemas"]["__schema177"][];
            correctiveJobId?: string | null;
            createdAt: components["schemas"]["__schema167"];
            expiresAt: components["schemas"]["__schema167"];
            failureClass: string | null;
            generationStartedAt: components["schemas"]["__schema167"] | null;
            generationState: string;
            id: components["schemas"]["__schema174"];
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
            receipts: components["schemas"]["__schema177"][];
            restricted: boolean;
            scope: components["schemas"]["__schema175"];
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
        __schema174: string;
        __schema175: {
            app: components["schemas"]["__schema176"];
            app_version: components["schemas"]["__schema176"];
            /** @constant */
            audience: "private";
            /** @constant */
            role: "owner";
            task_family: components["schemas"]["__schema176"];
        };
        __schema176: string;
        __schema177: {
            [key: string]: unknown;
        };
        __schema178: {
            candidate: components["schemas"]["__schema179"];
        };
        __schema179: {
            body: string;
            bodyHash: string;
            canarySpaceId: string | null;
            /** @default {} */
            caseTemplates: {
                final_pool?: components["schemas"]["__schema194"][];
                validation?: components["schemas"]["__schema193"][];
            };
            change: components["schemas"]["__schema177"];
            /** @default [] */
            checks: ({
                kind: components["schemas"]["__schema183"];
                max?: components["schemas"]["__schema185"];
                min?: components["schemas"]["__schema184"];
            } | {
                kind: components["schemas"]["__schema186"];
                max?: components["schemas"]["__schema188"];
                min?: components["schemas"]["__schema187"];
            } | {
                kind: components["schemas"]["__schema189"];
                max?: components["schemas"]["__schema191"];
                min?: components["schemas"]["__schema190"];
            } | {
                /** @constant */
                kind: "required_phrase";
                phrase: components["schemas"]["__schema192"];
            } | {
                /** @constant */
                kind: "forbidden_phrase";
                phrase: components["schemas"]["__schema192"];
            } | {
                /** @enum {string} */
                form: "bullets" | "numbered" | "paragraphs" | "table" | "json";
                /** @constant */
                kind: "output_format";
            } | {
                headings: components["schemas"]["__schema192"][];
                /** @constant */
                kind: "required_sections";
                /** @default true */
                ordered: boolean;
            } | {
                /** @enum {string} */
                direction: "ascending" | "descending";
                key: components["schemas"]["__schema192"];
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
                action_kind: components["schemas"]["__schema192"];
                /** @constant */
                kind: "action_kind_absent";
            } | {
                action_kind: components["schemas"]["__schema192"];
                /** @constant */
                kind: "action_kind_max";
                max: number;
            } | {
                action_kind: components["schemas"]["__schema192"];
                /** @constant */
                kind: "action_kind_present";
                /** @default 1 */
                min: number;
            })[];
            compatibleModels: string[];
            createdAt: components["schemas"]["__schema167"];
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
            episodeId: components["schemas"]["__schema174"] | null;
            /** @default [] */
            evidence: components["schemas"]["__schema182"][];
            /** @default null */
            holdReason: string | null;
            id: components["schemas"]["__schema180"];
            knownRisk: string;
            /**
             * @default owner_correction
             * @enum {string}
             */
            origin: "owner_correction" | "engine_staged";
            /** @default null */
            pausedAt: components["schemas"]["__schema167"] | null;
            predictedBenefit: string;
            /**
             * @default {
             *       "scope": "private",
             *       "principal_id": null
             *     }
             */
            promotion: {
                approved_at?: components["schemas"]["__schema167"];
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
            removedAt: components["schemas"]["__schema167"] | null;
            scope: components["schemas"]["__schema175"];
            selectedEvaluationId: string | null;
            /** @default null */
            skillName: string | null;
            spaceId: string;
            state: components["schemas"]["__schema181"];
            tests: string[];
            /** @default [] */
            triggers: {
                evidence: components["schemas"]["__schema182"];
                phrase: string;
            }[];
            version: number;
        };
        __schema180: string;
        /** @enum {string} */
        __schema181: "candidate" | "evaluated" | "enabled_canary" | "active" | "superseded" | "reverted";
        __schema182: {
            end: number;
            /** @constant */
            fallback?: "verbatim";
            quote: string;
            /** @enum {string} */
            source: "intervention" | "objective";
            start: number;
        };
        /** @constant */
        __schema183: "word_count";
        __schema184: number;
        __schema185: number;
        /** @constant */
        __schema186: "char_count";
        __schema187: number;
        __schema188: number;
        /** @constant */
        __schema189: "line_count";
        __schema190: number;
        __schema191: number;
        __schema192: string;
        __schema193: string;
        __schema194: string;
        __schema195: {
            candidate: components["schemas"]["__schema179"];
            evaluations: {
                budget: components["schemas"]["__schema177"];
                createdAt: components["schemas"]["__schema167"];
                id: string;
                passed: boolean;
                phase: string;
                selectedAt: components["schemas"]["__schema167"] | null;
            }[];
            history: {
                actor: string;
                candidateId: components["schemas"]["__schema180"];
                createdAt: components["schemas"]["__schema167"];
                fromState: string | null;
                id: string;
                reason: string;
                toState: components["schemas"]["__schema181"];
            }[];
        };
        __schema196: {
            actions: ("try" | "pause" | "resume" | "remove" | "share" | "approve" | "edit" | "stop")[];
            applies_when: string[];
            definition_hash: string;
            does: string[];
            expires_at: components["schemas"]["__schema167"] | null;
            expiring_soon: boolean;
            id: string;
            learned_at: components["schemas"]["__schema167"];
            name: string;
            reason: string | null;
            reason_code: string | null;
            shared: boolean;
            source: components["schemas"]["__schema197"];
            space_id: string;
            /** @enum {string} */
            state: "proposed" | "trial" | "active" | "paused" | "reverted";
        };
        /** @enum {string} */
        __schema197: "correction" | "engine";
        __schema198: {
            /** @enum {string} */
            action: "pause" | "resume" | "remove" | "keep" | "decline";
            created_at: components["schemas"]["__schema167"];
            id: string;
            item_id: string;
            name: string;
            source: components["schemas"]["__schema197"];
        };
        __schema199: {
            change: components["schemas"]["__schema198"] | null;
            item: components["schemas"]["__schema196"] | null;
        };
        __schema200: {
            answer: ("yes" | "no" | "change") | null;
            created_at: components["schemas"]["__schema167"];
            id: components["schemas"]["__schema201"];
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
            created_at: components["schemas"]["__schema167"];
            id: components["schemas"]["__schema201"];
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
        __schema201: string;
        __schema202: {
            skills: components["schemas"]["__schema203"][];
        };
        __schema203: {
            body: string;
            created_at: components["schemas"]["__schema167"];
            definition_hash: string;
            description: string;
            id: components["schemas"]["__schema180"];
            name: string;
            reason: string | null;
            source_job_id: string | null;
            /** @enum {string} */
            state: "live" | "held" | "paused" | "rejected" | "reverted";
        };
        __schema204: {
            body_sha256: string | null;
            created_at: components["schemas"]["__schema167"];
            id: string;
            name: string;
            reason: string;
            source_skill_id: components["schemas"]["__schema180"] | null;
            space_id: string | null;
        };
        __schema205: {
            skill: components["schemas"]["__schema203"];
        };
        __schema206: string;
        __schema207: string;
        /** @enum {string} */
        __schema208: "personal" | "shared";
        /** @enum {string} */
        __schema209: "owner" | "space";
        __schema210: string | null;
        __schema211: string;
        __schema212: {
            generation: number;
            principal_id: string;
            revoked_at: components["schemas"]["__schema167"] | null;
            /** @enum {string} */
            role: "owner" | "member";
            space_id: string;
        };
        __schema213: string;
        __schema214: string;
        __schema215: string;
        /** @enum {string} */
        __schema216: "removed" | "emptied";
        /** @enum {string} */
        __schema217: "pending" | "running" | "blocked" | "cleaning" | "complete";
        /** @enum {string} */
        __schema218: "fence" | "sessions" | "journal" | "sandboxes" | "browser" | "runtime" | "files" | "operational" | "principals" | "memory" | "verify" | "space";
        __schema219: {
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
        __schema220: string | null;
        __schema221: components["schemas"]["__schema167"] | null;
        __schema222: string;
        __schema223: string;
        __schema224: {
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
        __schema225: {
            label: string;
            provider: string;
        }[];
        __schema226: string[];
        __schema227: string;
        __schema228: string;
        __schema229: string[];
        __schema230: string[];
        __schema231: {
            agent_id: components["schemas"]["__schema232"];
            automation_id?: components["schemas"]["__schema232"];
            composer: components["schemas"]["__schema235"];
            created_at: components["schemas"]["__schema236"];
            id: components["schemas"]["__schema232"];
            plan_id: components["schemas"]["__schema232"] | null;
            progress?: {
                current: string | null;
                steps_done: components["schemas"]["__schema237"];
            };
            status: components["schemas"]["__schema234"];
            title: components["schemas"]["__schema233"];
            updated_at: components["schemas"]["__schema236"];
        };
        __schema232: string;
        __schema233: string;
        /** @enum {string} */
        __schema234: "idle" | "queued" | "working" | "streaming" | "needs_you" | "paused" | "done" | "failed" | "stopped";
        /** @enum {string} */
        __schema235: "send" | "pause" | "resume" | "stop";
        /** Format: date-time */
        __schema236: string;
        __schema237: number;
        __schema238: {
            reason: components["schemas"]["__schema233"];
            /** @constant */
            status: "not_available";
        };
        __schema239: {
            conversation: components["schemas"]["__schema231"];
        };
        __schema240: {
            agent_id: components["schemas"]["__schema232"];
            answer: string;
            conversation_id: components["schemas"]["__schema232"];
            created_at: components["schemas"]["__schema236"];
            delivery: ("sending" | "queued_offline" | "failed_retry") | null;
            id: components["schemas"]["__schema232"];
            status: components["schemas"]["__schema234"];
            text: string;
        };
        __schema241: {
            conversation_id: components["schemas"]["__schema232"];
            created_at: components["schemas"]["__schema236"];
            item: ({
                text: string;
                /** @constant */
                type: "say";
            } | {
                label: components["schemas"]["__schema233"];
                meta: string;
                sources: {
                    app: components["schemas"]["__schema233"];
                    connection_id: components["schemas"]["__schema232"];
                    /** @enum {string} */
                    kind: "event" | "message" | "draft" | "file" | "page" | "task";
                    title: components["schemas"]["__schema233"];
                    url?: components["schemas"]["__schema242"];
                }[];
                tool?: components["schemas"]["__schema243"];
                /** @constant */
                type: "action";
            } | {
                text: components["schemas"]["__schema233"];
                /** @constant */
                type: "note";
            } | {
                apps: components["schemas"]["__schema233"][];
                elapsed_ms: components["schemas"]["__schema237"];
                source_count: components["schemas"]["__schema237"];
                summary: components["schemas"]["__schema233"];
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
                card: components["schemas"]["__schema247"];
                /** @constant */
                type: "card";
            } | {
                receipt: components["schemas"]["__schema250"];
                /** @constant */
                type: "receipt";
            } | {
                permission: components["schemas"]["__schema255"];
                /** @constant */
                type: "permission";
            } | {
                question: components["schemas"]["__schema258"];
                /** @constant */
                type: "question";
            } | {
                decision: {
                    answer: string | null;
                    decided_at: components["schemas"]["__schema236"];
                    id: components["schemas"]["__schema232"];
                    /** @enum {string} */
                    kind: "permission" | "question";
                    /** @enum {string} */
                    outcome: "allow_once" | "always" | "deny" | "replaced" | "answered" | "withdrawn" | "outdated";
                };
                /** @constant */
                type: "decision";
            } | {
                composer: components["schemas"]["__schema235"];
                status: components["schemas"]["__schema234"];
                /** @constant */
                type: "status";
            } | {
                tool: components["schemas"]["__schema243"];
                /** @constant */
                type: "tool";
            };
            seq: components["schemas"]["__schema237"];
            turn_id: components["schemas"]["__schema232"] | null;
        };
        /** Format: uri */
        __schema242: string;
        __schema243: {
            detail: {
                id: components["schemas"]["__schema232"];
                /** @enum {string} */
                type: "artifact" | "permission" | "receipt" | "memory" | "page" | "screenshot";
                url?: components["schemas"]["__schema242"];
            } | null;
            ended_at: components["schemas"]["__schema236"] | null;
            /** @enum {string} */
            failure?: "error" | "refused" | "declined";
            id: components["schemas"]["__schema232"];
            input_excerpt?: components["schemas"]["__schema246"];
            input_summary: components["schemas"]["__schema244"] | null;
            /** @enum {string} */
            kind: "connector" | "web" | "file" | "artifact" | "browser" | "sandbox" | "skill" | "memory_recall" | "memory_write" | "memory_correct" | "memory_forget" | "model" | "retry" | "tool";
            output_excerpt?: components["schemas"]["__schema246"];
            output_summary: components["schemas"]["__schema244"] | null;
            parent: components["schemas"]["__schema232"] | null;
            started_at: components["schemas"]["__schema236"];
            /** @enum {string} */
            status: "running" | "done" | "failed" | "needs_approval" | "unknown";
            title: string;
        };
        __schema244: {
            quote?: {
                from: components["schemas"]["__schema245"];
                text: string;
            };
            text: string;
        };
        /** @enum {string} */
        __schema245: "page" | "message" | "file" | "event" | "app" | "request";
        __schema246: {
            from: components["schemas"]["__schema245"];
            more: boolean;
            text: string;
        };
        __schema247: {
            facts: components["schemas"]["__schema248"][];
            id: components["schemas"]["__schema232"];
            image?: components["schemas"]["__schema242"];
            meta: string;
            primary_action: components["schemas"]["__schema249"] | null;
            secondary_actions: components["schemas"]["__schema249"][];
            source_connection: components["schemas"]["__schema232"] | null;
            title: components["schemas"]["__schema233"];
        };
        __schema248: {
            label: components["schemas"]["__schema233"];
            value: components["schemas"]["__schema233"];
        };
        __schema249: {
            handle: components["schemas"]["__schema232"];
            /** @enum {string} */
            kind: "open" | "download" | "send" | "undo";
            label: components["schemas"]["__schema233"];
            url?: components["schemas"]["__schema242"];
        };
        __schema250: {
            because?: components["schemas"]["__schema252"][];
            id: components["schemas"]["__schema232"];
            review?: components["schemas"]["__schema251"];
            undo?: {
                handle: components["schemas"]["__schema232"];
                valid_until: components["schemas"]["__schema236"];
            };
            what: components["schemas"]["__schema233"];
            when: components["schemas"]["__schema236"];
            where: components["schemas"]["__schema233"];
        };
        __schema251: {
            /** @enum {string} */
            by: "policy" | "reviewer";
            /** @enum {string} */
            outcome: "auto_approved" | "escalated";
            reason: components["schemas"]["__schema233"];
            reviewed_at: components["schemas"]["__schema236"];
            risk: ("low" | "medium" | "high") | null;
        };
        __schema252: {
            /** @enum {string} */
            basis: "declared" | "recalled" | "rule";
            id: components["schemas"]["__schema253"];
            /** @enum {string} */
            kind: "belief" | "rule";
            label: components["schemas"]["__schema254"];
        };
        __schema253: string;
        __schema254: string;
        __schema255: {
            because?: components["schemas"]["__schema252"][];
            conversation_id: components["schemas"]["__schema232"];
            created_at: components["schemas"]["__schema236"];
            draft?: components["schemas"]["__schema257"];
            file?: {
                bytes: components["schemas"]["__schema237"];
                content: string;
                path: components["schemas"]["__schema233"];
                truncated: boolean;
            };
            id: components["schemas"]["__schema232"];
            options: components["schemas"]["__schema256"][];
            preview: components["schemas"]["__schema247"] | null;
            review?: components["schemas"]["__schema251"];
            version: components["schemas"]["__schema232"];
            what: components["schemas"]["__schema233"];
            why: components["schemas"]["__schema233"][];
        };
        /** @enum {string} */
        __schema256: "allow_once" | "always" | "deny";
        __schema257: {
            bcc?: components["schemas"]["__schema233"][];
            body: string;
            cc?: components["schemas"]["__schema233"][];
            /** @enum {string} */
            channel: "email" | "message";
            connection_id: components["schemas"]["__schema232"];
            id: components["schemas"]["__schema232"];
            recipient: components["schemas"]["__schema233"];
            /** @enum {string} */
            status: "draft" | "awaiting_permission" | "denied" | "sent" | "discarded";
            subject?: string;
        };
        __schema258: {
            conversation_id: components["schemas"]["__schema232"] | null;
            created_at: components["schemas"]["__schema236"];
            free_text: boolean;
            id: components["schemas"]["__schema232"];
            if_ignored: components["schemas"]["__schema233"];
            options: components["schemas"]["__schema259"];
            text: components["schemas"]["__schema233"];
            why: components["schemas"]["__schema233"][];
        };
        __schema259: components["schemas"]["__schema260"][];
        __schema260: {
            id: components["schemas"]["__schema232"];
            label: components["schemas"]["__schema233"];
        };
        __schema261: {
            command: string;
            exit_code: number | null;
            id: components["schemas"]["__schema232"];
            output: string;
            started_at: components["schemas"]["__schema236"];
            /** @enum {string} */
            status: "running" | "done" | "failed" | "unknown";
        };
        __schema262: {
            can_preview: boolean;
            id: components["schemas"]["__schema232"];
            last_line: string | null;
            name: string;
            port: number | null;
            started_at: components["schemas"]["__schema236"];
            /** @enum {string} */
            state: "starting" | "running" | "exited" | "stopped" | "expired" | "lost";
        };
        __schema263: {
            bounds: {
                count_cap: number;
                expires_at: components["schemas"]["__schema236"];
                reconsent_after_days: number;
            };
            connection_id: components["schemas"]["__schema232"];
            created_at: components["schemas"]["__schema236"];
            id: components["schemas"]["__schema232"];
            /** @enum {string} */
            kind: "send_message" | "create_event" | "change_event" | "delete_event" | "save_file" | "restore_file" | "discard_draft" | "push_branch";
            recipient_class: components["schemas"]["__schema233"];
            text: components["schemas"]["__schema233"];
            used: components["schemas"]["__schema237"];
        };
        __schema264: {
            reviewer_available: boolean;
            settings: {
                classes: {
                    app_changes: boolean;
                    apps: boolean;
                    calendar: boolean;
                    sandbox: boolean;
                };
                /** @enum {string} */
                mode: "ask" | "auto_review";
            };
        };
        __schema265: {
            /** @constant */
            status: "ok";
        };
        __schema266: {
            allowed_connection_ids: components["schemas"]["__schema274"];
            asks_before_acting: components["schemas"]["__schema275"];
            colour: components["schemas"]["__schema269"];
            eye_colour: components["schemas"]["__schema271"];
            face_image?: components["schemas"]["__schema279"];
            fixed_reach: boolean;
            id: components["schemas"]["__schema232"];
            is_default: boolean;
            name: components["schemas"]["__schema267"];
            reads_memory: components["schemas"]["__schema277"];
            role: components["schemas"]["__schema268"];
            space_id: components["schemas"]["__schema232"];
            standing_instruction: components["schemas"]["__schema273"];
            surface: components["schemas"]["__schema270"];
            tone: components["schemas"]["__schema272"];
            usage: {
                conversations: components["schemas"]["__schema237"];
                last_used: components["schemas"]["__schema236"] | null;
                routines: components["schemas"]["__schema237"];
            };
            uses_computer: components["schemas"]["__schema276"];
            writes_memory: components["schemas"]["__schema278"];
        };
        __schema267: string;
        __schema268: string;
        __schema269: string;
        /** @enum {string} */
        __schema270: "rounded" | "blob" | "diamond" | "octagon" | "gear";
        __schema271: string;
        __schema272: string;
        __schema273: string;
        __schema274: components["schemas"]["__schema232"][] | null;
        __schema275: boolean;
        /** @default true */
        __schema276: boolean;
        /** @default true */
        __schema277: boolean;
        /** @default true */
        __schema278: boolean;
        __schema279: components["schemas"]["__schema242"];
        __schema280: {
            agent: components["schemas"]["__schema266"];
        };
        __schema281: string;
        __schema282: string;
        /** @enum {string} */
        __schema283: "mail" | "calendar" | "files" | "web" | "browser" | "computer" | "devices" | "mcp";
        __schema284: {
            kind: components["schemas"]["__schema283"];
            without: string;
        };
        __schema285: number;
        __schema286: {
            id: string;
            memory_key: components["schemas"]["__schema287"];
            placeholder: string;
            question: string;
        };
        __schema287: string;
        __schema288: string;
        __schema289: {
            /** @enum {string} */
            reach: "mail" | "calendar" | "files" | "web" | "browser" | "computer" | "memory";
            title: string;
        };
        __schema290: string;
        __schema291: {
            created: components["schemas"]["__schema236"];
            editable: boolean;
            id: components["schemas"]["__schema232"];
            key: components["schemas"]["__schema233"];
            last_used: components["schemas"]["__schema236"] | null;
            saved_by?: string;
            /** @enum {string} */
            source: "onboarding" | "conversation" | "inferred";
            value: string;
            version: components["schemas"]["__schema232"];
        };
        __schema292: {
            capture: boolean;
        };
        __schema293: boolean;
        __schema294: boolean;
        __schema295: string;
        __schema296: {
            at: components["schemas"]["__schema297"];
            /** @enum {string} */
            kind: "setup" | "chat" | "correction" | "import" | "email" | "calendar" | "contacts" | "connected" | "receipt" | "message" | "document" | "assistant" | "worked_out";
            link: {
                id: components["schemas"]["__schema253"];
                /** @enum {string} */
                kind: "conversation" | "receipt";
                label: components["schemas"]["__schema254"];
            } | null;
            text: components["schemas"]["__schema254"];
        };
        /** Format: date-time */
        __schema297: string;
        __schema298: number;
        /** Format: date */
        __schema299: string;
        __schema300: {
            created_at: components["schemas"]["__schema297"];
            id: components["schemas"]["__schema253"];
            label: components["schemas"]["__schema254"];
            skipped: components["schemas"]["__schema254"][];
            steps: components["schemas"]["__schema301"][];
            undone_at: components["schemas"]["__schema297"] | null;
        };
        __schema301: {
            belief_id: components["schemas"]["__schema253"];
            from: components["schemas"]["__schema295"] | null;
            label: components["schemas"]["__schema254"];
            to: components["schemas"]["__schema295"] | null;
        };
        __schema302: {
            rewind: components["schemas"]["__schema300"];
        };
        __schema303: {
            category: components["schemas"]["__schema233"];
            conversation_ids: components["schemas"]["__schema232"][];
            file_ids: components["schemas"]["__schema232"][];
            id: components["schemas"]["__schema232"];
            milestones: {
                assignee: {
                    /** @constant */
                    kind: "person";
                } | {
                    agent_id: components["schemas"]["__schema232"];
                    /** @constant */
                    kind: "agent";
                };
                done: boolean;
                id: components["schemas"]["__schema232"];
                output?: string | null;
                schedule_at?: components["schemas"]["__schema236"];
                status: components["schemas"]["__schema234"];
                title: components["schemas"]["__schema233"];
            }[];
            next_step: components["schemas"]["__schema233"] | null;
            progress_percent: number;
            title: components["schemas"]["__schema233"];
            updated_at: components["schemas"]["__schema236"];
        };
        __schema304: {
            plan: components["schemas"]["__schema303"];
        };
        __schema305: {
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
        __schema306: {
            created_at: components["schemas"]["__schema236"];
            /** @default false */
            done: boolean;
            due_at: components["schemas"]["__schema236"] | null;
            id: components["schemas"]["__schema232"];
            title: components["schemas"]["__schema233"];
            updated_at: components["schemas"]["__schema236"];
        };
        __schema307: {
            conversation_id: components["schemas"]["__schema232"] | null;
            finished_at: components["schemas"]["__schema236"] | null;
            id: components["schemas"]["__schema232"];
            reason: string | null;
            started_at: components["schemas"]["__schema236"];
            status: components["schemas"]["__schema234"];
            summary: string | null;
            turn_id: components["schemas"]["__schema232"] | null;
        };
        __schema308: {
            task: components["schemas"]["__schema306"];
        };
        __schema309: {
            conversation_id: components["schemas"]["__schema232"];
            enabled: boolean;
            ended: boolean;
            id: components["schemas"]["__schema232"];
            runs: components["schemas"]["__schema307"][];
            schedule: components["schemas"]["__schema233"];
            title: components["schemas"]["__schema233"];
        };
        __schema310: {
            automation: components["schemas"]["__schema309"];
        };
        __schema311: {
            agent_id: string | null;
            check: {
                enabled: boolean;
                gaps: string[];
                state: ("checking" | "passed" | "gaps" | "not_confirmed") | null;
            };
            conversation_id: string | null;
            done_when: string | null;
            experiments: {
                best: components["schemas"]["__schema313"] | null;
                count: number;
                recent: components["schemas"]["__schema313"][];
            };
            findings: number;
            finished_at: components["schemas"]["__schema167"] | null;
            goal: string;
            id: string;
            latest_report: {
                body: string;
                created_at: components["schemas"]["__schema167"];
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
            next_shift_at: components["schemas"]["__schema167"] | null;
            plan: string | null;
            question: string | null;
            result: string | null;
            shifts: number;
            standing: {
                description: string;
                /** @enum {string} */
                kind: "schedule" | "event" | "watch";
                next_wake_at: components["schemas"]["__schema167"] | null;
            } | null;
            started_at: components["schemas"]["__schema167"];
            status: components["schemas"]["__schema312"];
            status_line: string;
            steps: {
                id: string;
                result: string | null;
                status: components["schemas"]["__schema312"];
                title: string;
            }[];
            title: string;
        };
        /** @enum {string} */
        __schema312: "working" | "waiting" | "needs_you" | "done" | "stopped" | "failed";
        __schema313: {
            checked: boolean;
            created_at: components["schemas"]["__schema167"];
            id: string;
            outcome: ("kept" | "discarded" | "failed") | null;
            title: string;
            value: number | null;
        };
        __schema314: {
            run: components["schemas"]["__schema311"];
        };
        __schema315: {
            session: {
                id: components["schemas"]["__schema232"];
                preview_frame: components["schemas"]["__schema242"] | null;
                /** @enum {string} */
                status: "working" | "needs_you" | "done" | "stopped";
                task_label: components["schemas"]["__schema233"];
                url: components["schemas"]["__schema242"];
            };
        };
        __schema316: {
            enabled: components["schemas"]["PrivacyCategory"][];
            known_values: components["schemas"]["__schema318"][];
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
            private_agent_ids: components["schemas"]["__schema317"][];
            private_space: boolean;
            screenshots_own_computer: boolean;
            screenshots_paired_devices: boolean;
            sealed_vault: boolean;
            sensitive_topics: components["schemas"]["SensitiveTopic"][];
        };
        __schema317: string;
        __schema318: {
            category: components["schemas"]["PrivacyCategory"];
            hint: string;
            id: string;
            label: string;
        };
        __schema319: string;
        __schema320: {
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
        __schema321: string;
        __schema322: string;
        __schema323: string | null;
        /** @enum {string} */
        __schema324: "owner" | "member" | "guest";
        __schema325: number;
        __schema326: {
            members: components["schemas"]["__schema327"][];
            policy: {
                /** @enum {string} */
                agent_turns: "asked" | "every_message";
                /** @enum {string} */
                approvers: "requester" | "any_member" | "owners";
                guests_may_ask: boolean;
            };
            room: {
                agent_name: string;
                created_at: components["schemas"]["__schema167"];
                id: components["schemas"]["__schema321"];
                my_role: components["schemas"]["__schema324"];
                name: components["schemas"]["__schema322"];
                purpose: components["schemas"]["__schema323"];
                unread: components["schemas"]["__schema325"];
            };
        };
        __schema327: {
            display_name: string;
            /** Format: email */
            email?: string;
            present: boolean;
            principal_id: components["schemas"]["__schema328"];
            role: components["schemas"]["__schema324"];
        };
        __schema328: string;
        __schema329: {
            archived_at: components["schemas"]["__schema167"] | null;
            created_at: components["schemas"]["__schema167"];
            created_by: components["schemas"]["__schema331"];
            id: components["schemas"]["__schema330"];
            last_activity_at: components["schemas"]["__schema167"];
            room_id: components["schemas"]["__schema321"];
            title: string;
        };
        __schema330: string;
        __schema331: {
            display_name: string;
            principal_id: components["schemas"]["__schema328"];
        };
        __schema332: {
            message: components["schemas"]["__schema333"];
            request_job_id: components["schemas"]["__schema330"] | null;
            thread: components["schemas"]["__schema329"];
        };
        __schema333: {
            author: components["schemas"]["__schema331"];
            created_at: components["schemas"]["__schema167"];
            id: components["schemas"]["__schema330"];
            /** @enum {string} */
            kind: "person" | "handoff_result" | "system";
            mentions: string[];
            request_job_id: components["schemas"]["__schema330"] | null;
            /** @enum {string} */
            request_state: "none" | "pending" | "started";
            text: string | null;
            thread_id: components["schemas"]["__schema330"];
            via_agent: boolean;
        };
        __schema334: {
            cards: components["schemas"]["__schema247"][];
            job_id: components["schemas"]["__schema330"];
            receipts: components["schemas"]["__schema250"][];
            requested_by: components["schemas"]["__schema331"];
            status: components["schemas"]["__schema234"];
            turns: components["schemas"]["__schema240"][];
        };
        __schema335: components["schemas"]["SandboxComputer"][];
        __schema336: string;
        __schema337: string | null;
        __schema338: string | null;
        /** @enum {string} */
        __schema339: "ready" | "paused";
        __schema340: boolean;
        /** @enum {string} */
        __schema341: "agent" | "human";
        __schema342: number;
        __schema343: {
            /** @constant */
            height: 768;
            /** @constant */
            width: 1024;
        };
        /** @enum {string} */
        __schema344: "deny_all" | "connected_hosts_only" | "open";
        __schema345: string;
        __schema346: {
            can_withdraw: boolean;
            claim_id: components["schemas"]["__schema345"];
            content: string | null;
            created_at: components["schemas"]["__schema167"];
            id: components["schemas"]["__schema330"];
            label: string | null;
            members_only: boolean;
            shared_by: components["schemas"]["__schema331"];
        };
        __schema347: {
            share: components["schemas"]["__schema346"];
        };
        __schema348: {
            error?: components["schemas"]["__schema170"];
            job: components["schemas"]["__schema349"] | null;
            receipt: components["schemas"]["__schema372"];
        };
        __schema349: {
            /** @enum {string} */
            attention_status: "normal" | "frequency_reduced" | "needs_attention";
            budget: components["schemas"]["__schema360"];
            cadence_multiplier: number;
            constraints: components["schemas"]["__schema355"];
            created_at: components["schemas"]["__schema167"];
            created_by: components["schemas"]["__schema361"];
            /** @default [] */
            deferred_questions: {
                because: components["schemas"]["__schema365"];
                blocks_external_effect: components["schemas"]["__schema368"];
                created_at: components["schemas"]["__schema167"];
                deadline_at: components["schemas"]["__schema369"];
                if_ignored: components["schemas"]["__schema367"];
                options?: components["schemas"]["__schema370"];
                text: components["schemas"]["__schema364"];
                why?: components["schemas"]["__schema371"];
            }[];
            id: components["schemas"]["__schema350"];
            /** @enum {string} */
            importance: "routine" | "important";
            lease_epoch: components["schemas"]["__schema357"];
            next_wake_at: components["schemas"]["__schema358"];
            objective: components["schemas"]["__schema354"];
            principal_id?: components["schemas"]["__schema352"];
            revision: components["schemas"]["__schema356"];
            /** @enum {string} */
            scheduling_class: "interactive" | "background" | "quiet";
            space_id: components["schemas"]["__schema351"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema362"];
            substrate_disposition: components["schemas"]["__schema363"];
            title: components["schemas"]["__schema353"];
            unread_results: number;
            unread_threshold: number;
            updated_at: components["schemas"]["__schema167"];
            visible_status: components["schemas"]["JobState"] | ("frequency_reduced" | "needs_attention");
            wait: components["schemas"]["__schema359"];
        };
        __schema350: string;
        __schema351: string;
        __schema352: string | null;
        __schema353: string;
        __schema354: string;
        __schema355: {
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
        __schema356: number;
        __schema357: number;
        __schema358: components["schemas"]["__schema167"] | null;
        __schema359: {
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
            wake_at: components["schemas"]["__schema167"];
        } | {
            deadline_at: components["schemas"]["__schema167"] | null;
            /** @constant */
            kind: "event";
            trigger_id: string;
        };
        __schema360: {
            max_actions: number;
            max_attempts: number;
            max_input_tokens?: number;
            max_output_tokens: number;
            max_turns: number;
            max_usd_est: number;
            max_wall_ms: number;
        };
        /** @enum {string} */
        __schema361: "owner" | "trigger" | "system";
        __schema362: number;
        /** @enum {string} */
        __schema363: "remote_recoverable" | "timer_or_event" | "local_process_interrupted" | "external_uncertain";
        __schema364: string;
        __schema365: components["schemas"]["__schema366"][];
        __schema366: string;
        __schema367: string;
        /** @default false */
        __schema368: boolean;
        /** @default null */
        __schema369: components["schemas"]["__schema167"] | null;
        __schema370: components["schemas"]["__schema259"];
        __schema371: string;
        __schema372: {
            event_cursor: number | null;
            input_digest: components["schemas"]["__schema374"] | null;
            job_id: string | null;
            job_revision: number | null;
            /** @enum {string} */
            state: "accepted" | "rejected" | "unknown_durability";
            submission_id: components["schemas"]["__schema373"];
        };
        __schema373: string;
        __schema374: string;
        __schema375: {
            answer: string | null;
            answered_at: components["schemas"]["__schema167"] | null;
            attempt_id: string | null;
            because: components["schemas"]["__schema365"];
            blocks_external_effect: components["schemas"]["__schema368"];
            created_at: components["schemas"]["__schema167"];
            deadline_at: components["schemas"]["__schema369"];
            id: string;
            if_ignored: components["schemas"]["__schema367"];
            job_id: string | null;
            job_title: string | null;
            key: string | null;
            options?: components["schemas"]["__schema370"];
            /** @enum {string} */
            source: "job" | "memory";
            space_id: string | null;
            /** @enum {string} */
            state: "open" | "answered" | "withdrawn";
            text: components["schemas"]["__schema364"];
            why?: components["schemas"]["__schema371"];
        };
        __schema376: {
            actions: {
                dispatched_at: components["schemas"]["__schema167"] | null;
                id: string;
                job_id: string;
                receipt: components["schemas"]["__schema377"] | null;
                status: string;
            }[];
            cursor: number;
            epoch: number | null;
            jobs: components["schemas"]["__schema349"][];
        };
        __schema377: {
            [key: string]: components["schemas"]["__schema378"];
        };
        __schema378: (string | number | boolean | null) | components["schemas"]["__schema378"][] | {
            [key: string]: components["schemas"]["__schema378"];
        };
        __schema379: {
            due_at: components["schemas"]["__schema167"];
            id: string;
            job_id: string;
            /** @enum {string} */
            kind: "timer" | "remote_task" | "local_process";
            operation_key: components["schemas"]["__schema373"];
            remote_ref: string | null;
            result: components["schemas"]["__schema377"] | null;
            /** @enum {string} */
            state: "registered" | "ready" | "claimed" | "settled" | "interrupted" | "unknown";
            substrate_disposition: components["schemas"]["__schema363"];
            version: number;
        };
        __schema380: {
            acknowledged_at: components["schemas"]["__schema167"] | null;
            coalesce_key: string;
            created_at: components["schemas"]["__schema167"];
            fulfilled_at: components["schemas"]["__schema167"] | null;
            id: string;
            job_id: string | null;
            /** @enum {string} */
            kind: "direct" | "quiet";
            message: string | null;
            /** @enum {string} */
            state: "owed" | "acknowledged" | "fulfilled" | "needs_retransmission";
            submission_id: components["schemas"]["__schema373"];
        };
        __schema381: {
            attempted_at: components["schemas"]["__schema167"] | null;
            because: components["schemas"]["__schema366"][];
            coalesce_key: string;
            content: {
                attempt_id: string;
                job_id: string;
                /** @enum {string} */
                kind: "answer" | "question" | "status";
                text: string;
            } | null;
            content_hash: components["schemas"]["__schema374"];
            created_at: components["schemas"]["__schema167"];
            delivered_at: components["schemas"]["__schema167"] | null;
            delivery_attempt: number;
            delivery_key: string;
            id: string;
            if_ignored: components["schemas"]["__schema367"];
            obligation_ids: string[];
            /** @enum {string} */
            state: "pending" | "attempted" | "delivered" | "superseded";
        };
        __schema382: {
            audience: components["schemas"]["__schema386"];
            /**
             * @default owner
             * @enum {string}
             */
            author: "owner" | "external" | "member";
            content_ref: string | null;
            eligibility_generation: components["schemas"]["__schema387"];
            event_at: components["schemas"]["__schema167"];
            ingested_at: components["schemas"]["__schema167"];
            origin_trust: components["schemas"]["__schema388"];
            owner_id: string;
            publisher: components["schemas"]["__schema384"];
            source_id: components["schemas"]["__schema383"];
            source_identity: components["schemas"]["__schema384"];
            /** @enum {string} */
            source_type: "message" | "document" | "observation" | "receipt" | "assistant" | "owner_edit";
            source_version: components["schemas"]["__schema384"];
            space_id: string;
            /** @enum {string} */
            state: "active" | "suppressed" | "deleted" | "revoked";
            stream: components["schemas"]["__schema384"];
            stream_sequence: components["schemas"]["__schema385"];
        };
        __schema383: string;
        __schema384: string;
        __schema385: number;
        /** @enum {string} */
        __schema386: "private" | "space" | "public";
        __schema387: number;
        /** @enum {string} */
        __schema388: "owner" | "verified_connector" | "external_content" | "inferred" | "unknown";
        __schema389: {
            access_generation: components["schemas"]["__schema387"];
            data_revision: components["schemas"]["__schema387"];
            eligibility_generation: components["schemas"]["__schema387"];
            policy_generation: components["schemas"]["__schema387"];
            restore_ready: boolean;
            space_id: string;
        };
        __schema390: string;
        /** @enum {string} */
        __schema391: "user_statement" | "document_assertion" | "checked_fact" | "inferred" | "preference" | "exception" | "historical";
        /** @enum {string} */
        __schema392: "attributed" | "checked" | "tentative" | "disputed";
        /** @enum {string} */
        __schema393: "active" | "superseded" | "historical" | "retracted" | "disputed";
        __schema394: {
            end: components["schemas"]["__schema385"];
            source_id: components["schemas"]["__schema383"];
            source_version: components["schemas"]["__schema384"];
            start: components["schemas"]["__schema387"];
        };
        __schema395: {
            claim_id: components["schemas"]["__schema345"];
            content: string | null;
            data_revision: components["schemas"]["__schema385"];
            factual_status: components["schemas"]["__schema392"];
            kind: components["schemas"]["__schema391"];
            /** @default inferred */
            origin_trust: components["schemas"]["__schema388"];
            protected: boolean;
            recorded_at: components["schemas"]["__schema167"];
            revision: components["schemas"]["__schema385"];
            sources: components["schemas"]["__schema394"][];
            status: components["schemas"]["__schema393"];
            superseded_at: components["schemas"]["__schema167"] | null;
            valid_from: components["schemas"]["__schema167"];
            valid_until: components["schemas"]["__schema167"] | null;
        };
        __schema396: {
            /** @enum {string} */
            cleanup: "pending" | "complete";
            generation: components["schemas"]["__schema389"];
        };
        __schema397: string;
        /** @default null */
        __schema398: components["schemas"]["__schema287"] | null;
        __schema399: boolean;
        __schema400: string;
        __schema401: string;
        __schema402: {
            field: string;
            handle: components["schemas"]["__schema390"];
            key: components["schemas"]["__schema287"] | null;
            /** @enum {string} */
            kind: "recipient" | "date" | "amount" | "identifier";
            value: string;
        };
        __schema403: {
            description: string;
            field: string;
            handle: (components["schemas"]["__schema390"] | string) | null;
            origin_trust: components["schemas"]["__schema388"];
            value: string;
        };
        __schema404: string;
        __schema405: string;
        __schema406: {
            /** @enum {string} */
            kind: "artifact" | "plan_step" | "action";
            location: string | null;
            output_id: components["schemas"]["__schema400"];
            output_version: components["schemas"]["__schema400"];
        };
        __schema407: {
            diff: string;
            id: components["schemas"]["__schema384"];
            path: string;
            /** @enum {string} */
            status: "pending" | "applied" | "discarded";
        };
        __schema408: {
            owner: {
                created_at: components["schemas"]["__schema167"];
                /** Format: email */
                email: string;
                id: string;
            };
        };
        __schema409: {
            job: components["schemas"]["Job"];
        };
        __schema410: {
            field: string;
            /** @enum {string} */
            op: "eq" | "contains" | "matches" | "lt" | "gt" | "changed";
            /** @default null */
            value: string | number | boolean | null;
        };
        __schema411: {
            /** @enum {string} */
            by: "person" | "assistant";
            created_at: components["schemas"]["__schema167"];
            emoji: string;
            job_id: string | null;
            message_id: string;
            seq: number;
        };
        __schema412: {
            reactions: components["schemas"]["__schema411"][];
        };
        __schema413: string;
        __schema414: string;
        __schema415: number;
        __schema416: string;
        __schema417: string;
        __schema418: string;
        __schema419: string | null;
        __schema420: {
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
        __schema421: components["schemas"]["__schema167"] | null;
        __schema422: ("completed" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "failed" | "budget_exhausted" | "fenced" | "unknown_check") | null;
        __schema423: components["schemas"]["__schema377"] | null;
        __schema424: string | null;
        __schema425: {
            events: components["schemas"]["Event"][];
            has_more: boolean;
            next_cursor: number;
        };
        __schema426: number;
        __schema427: string | null;
        __schema428: string | null;
        /** @enum {string} */
        __schema429: "job_created" | "job_state_changed" | "attempt_started" | "attempt_ended" | "turn_started" | "text_delta" | "reasoning_delta" | "tool_call_proposed" | "tool_result" | "action_requested" | "action_status_changed" | "approval_requested" | "approval_decided" | "knowledge_changed" | "notice" | "reaction" | "gap" | "hook_event" | "hook_error";
        __schema430: string;
        __schema431: string;
        __schema432: string;
        /** @enum {string} */
        __schema433: "completed" | "parked_until_retry" | "needs_reconciliation" | "needs_reconnect" | "needs_input" | "repair_exhausted";
        __schema434: {
            [key: string]: number;
        };
        __schema435: {
            at: components["schemas"]["__schema167"];
            attempt: number;
            /** @default null */
            candidate_id: string | null;
            /** @enum {string} */
            decision: "verified_completion" | "retry_with_backoff" | "park_until_retry_after" | "park_until_reconnect" | "refresh_credential_once" | "stop_connection_revoked" | "rediscover_schema" | "record_repair_candidate" | "apply_safe_mapping" | "change_route" | "reconcile_by_verify" | "revise_and_revalidate" | "stop_needs_input" | "escalate_diagnosis";
            /** @default null */
            delay_ms: number | null;
            detail: string;
            /** @default null */
            fault_kind: components["schemas"]["__schema436"] | null;
            payload_hash: components["schemas"]["__schema431"];
            /** @default null */
            retry_after: components["schemas"]["__schema167"] | null;
            /** @default null */
            route: string | null;
        }[];
        /** @enum {string} */
        __schema436: "transient_before_dispatch" | "rate_limited" | "expired_credential" | "revoked_credential" | "schema_drift" | "unsupported_route" | "uncertain_outcome" | "bad_output" | "destination_offline" | "unclassified";
        __schema437: string;
        __schema438: string;
        __schema439: string;
        __schema440: string;
        __schema441: string;
        /** @default null */
        __schema442: components["schemas"]["__schema432"] | null;
        __schema443: string | null;
        __schema444: string | null;
        __schema445: string;
        __schema446: components["schemas"]["__schema167"] | null;
        __schema447: components["schemas"]["__schema377"] | null;
        __schema448: components["schemas"]["__schema167"] | null;
        __schema449: components["schemas"]["__schema377"] | null;
        /** @default [] */
        __schema450: components["schemas"]["__schema435"];
        /** @default {} */
        __schema451: components["schemas"]["__schema434"];
        /** @default null */
        __schema452: components["schemas"]["__schema433"] | null;
        /** @default null */
        __schema453: components["schemas"]["__schema167"] | null;
        __schema454: string;
        __schema455: string;
        __schema456: string;
        __schema457: components["schemas"]["__schema377"] | null;
        __schema458: components["schemas"]["__schema167"] | null;
        __schema459: components["schemas"]["__schema167"] | null;
        __schema460: {
            action: components["schemas"]["Action"];
        };
        __schema461: string;
        __schema462: string;
        /** @enum {string} */
        __schema463: "imap" | "smtp" | "caldav" | "web" | "files" | "test" | "exec" | "artifacts" | "generation" | "mcp" | "sandbox" | "device" | "command_line" | "apps";
        __schema464: string;
        __schema465: string[];
        /** @enum {string} */
        __schema466: "active" | "disabled" | "error" | "revoked";
        /** @enum {string} */
        __schema467: "unknown" | "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema468: "available" | "connecting" | "connected" | "error";
        __schema469: number;
        __schema470: boolean;
        __schema471: string[];
        /** @enum {string} */
        __schema472: "owner" | "room";
        __schema473: string;
        __schema474: components["schemas"]["__schema167"] | null;
        __schema475: {
            check?: components["schemas"]["ConnectionCheck"];
            connection: components["schemas"]["Connection"];
        };
        /** @enum {string} */
        __schema476: "ok" | "degraded" | "failing";
        /** @enum {string} */
        __schema477: "ok" | "degraded" | "unavailable" | "credential_refused" | "sign_in_required" | "needs_sign_in" | "not_running" | "revoked";
        __schema478: string;
        __schema479: string;
        __schema480: string;
        __schema481: string;
        __schema482: string;
        __schema483: {
            help?: string;
            label: string;
            list: boolean;
            name: string;
            placeholder?: string;
            required: boolean;
            secret: boolean;
        }[];
        __schema484: {
            asks_first: boolean;
            effect_class: components["schemas"]["EffectClass"];
            label: string;
        }[];
        __schema485: string | null;
        __schema486: {
            label?: string;
            scope: string;
        };
        __schema487: {
            authorization_servers: string[];
            bearer_methods_supported: string[];
            /** Format: uri */
            resource: string;
            resource_name: string;
            scopes_supported: string[];
        };
        __schema488: {
            error: string;
            error_description?: string;
        };
        __schema489: {
            error?: {
                code: number;
                message: string;
            };
            id: string | number | null;
            /** @constant */
            jsonrpc: "2.0";
            result?: unknown;
        };
        __schema490: {
            available: boolean;
            redirect_uri: string | null;
        };
        __schema491: {
            /** Format: uri */
            authorize_url: string;
            expires_at: components["schemas"]["__schema167"];
            /** Format: uri */
            issuer: string;
            /** Format: uri */
            redirect_uri: string;
            scopes: components["schemas"]["__schema486"][];
            sign_in_id: string;
        };
        __schema492: {
            expires_at: components["schemas"]["__schema167"];
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
        __schema493: string;
        /** @enum {string} */
        __schema494: "mail" | "caldav" | "ics" | "mcp" | "mcp_stdio" | "sandbox" | "command_line";
        __schema495: string;
        __schema496: string;
        __schema497: {
            path: string;
            value: components["schemas"]["__schema498"];
        }[];
        __schema498: string | number | boolean;
        __schema499: components["schemas"]["ConnectionFormField"][];
        __schema500: string;
        __schema501: string;
        __schema502: string;
        __schema503: boolean;
        __schema504: boolean;
        __schema505: string;
        __schema506: components["schemas"]["__schema498"];
        __schema507: {
            label: string;
            value: string;
        }[];
        __schema508: components["schemas"]["__schema509"] | "list";
        /** @enum {string} */
        __schema509: "text" | "email" | "url" | "number" | "password" | "checkbox" | "select" | "string_list";
        __schema510: {
            default?: components["schemas"]["__schema506"];
            help?: components["schemas"]["__schema502"];
            input: components["schemas"]["__schema509"];
            label: components["schemas"]["__schema501"];
            options?: components["schemas"]["__schema507"];
            path: components["schemas"]["__schema500"];
            placeholder?: components["schemas"]["__schema505"];
            required: components["schemas"]["__schema503"];
            secret: components["schemas"]["__schema504"];
        }[];
        __schema511: {
            asks_first: boolean;
            default: boolean;
            effect_class: components["schemas"]["EffectClass"];
            label: string;
            scope: string;
        }[];
        __schema512: string;
        __schema513: string;
        __schema514: string;
        __schema515: ("mail" | "calendar" | "tools" | "execution")[];
        __schema516: {
            /** Format: uri */
            issuer: string;
            /** @constant */
            method: "sign_in";
            /** @enum {string} */
            provider: "google" | "microsoft";
            scopes: components["schemas"]["__schema486"][];
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
        __schema517: boolean;
        __schema518: string;
        __schema519: string;
        __schema520: string;
        /** @enum {string} */
        __schema521: "fact" | "preference" | "decision" | "procedure" | "reference" | "event";
        /** @enum {string} */
        __schema522: "active" | "superseded" | "retracted" | "disputed";
        __schema523: {
            body: string;
            frontmatter: components["schemas"]["KnowledgeFrontmatterOutput"];
            id: string;
            path: string;
        };
        __schema524: string;
        __schema525: string;
        __schema526: string;
        /** @enum {string} */
        __schema527: "private" | "space" | "public";
        /** @enum {string} */
        __schema528: "high" | "medium" | "low";
        /** @enum {string} */
        __schema529: "user" | "agent" | "document" | "tool";
        __schema530: {
            /** @enum {string} */
            kind: "statement" | "file" | "url" | "tool_output";
            /** @default  */
            quote: string;
            ref: string;
            /** @default null */
            sha256: string | null;
        };
        /** Format: date */
        __schema531: string;
        /** @default null */
        __schema532: components["schemas"]["__schema531"] | null;
        /** @default [] */
        __schema533: components["schemas"]["__schema524"][];
        /** @default null */
        __schema534: components["schemas"]["__schema524"] | null;
        /** @default [] */
        __schema535: string[];
        /** @default [] */
        __schema536: components["schemas"]["__schema524"][];
        /** @constant */
        __schema537: 1;
        __schema538: string;
        __schema539: string;
        __schema540: number;
        /** @enum {string} */
        __schema541: "automation" | "human";
        /** @constant */
        __schema542: true;
        __schema543: components["schemas"]["BrowserSite"][];
        __schema544: string;
        __schema545: string;
        __schema546: string;
        __schema547: string;
        /** @constant */
        __schema548: true;
        __schema549: string;
        __schema550: number;
        __schema551: {
            /** @constant */
            height: 768;
            /** @constant */
            width: 1024;
        };
        __schema552: components["schemas"]["__schema553"][];
        __schema553: string;
        __schema554: string;
        __schema555: number;
        __schema556: components["schemas"]["__schema557"][];
        __schema557: string;
        /** @constant */
        __schema558: true;
        __schema559: string;
        __schema560: number;
        __schema561: string;
        __schema562: {
            /** @default null */
            currency: components["schemas"]["__schema564"] | null;
            domain: string;
            first_seen_at: components["schemas"]["__schema167"];
            id: string;
            last_seen_at: components["schemas"]["__schema167"];
            message_count: number;
            /** @default null */
            monthly_spend_minor: components["schemas"]["__schema563"] | null;
            name: string;
            space_id: string;
        };
        __schema563: number;
        __schema564: string;
        __schema565: {
            /** @default null */
            amount_minor: components["schemas"]["__schema563"] | null;
            company_id: string;
            confidence: components["schemas"]["__schema528"];
            /** @default null */
            currency: components["schemas"]["__schema564"] | null;
            /** @enum {string} */
            direction: "owed_to_you" | "you_pay" | "you_owe" | "info";
            /** @default null */
            due_at: components["schemas"]["__schema167"] | null;
            due_date_only?: boolean;
            evidence: components["schemas"]["__schema567"][];
            id: string;
            /** @default null */
            job_id: string | null;
            /** @enum {string} */
            kind: "refund_owed" | "wrong_charge" | "subscription" | "price_rise" | "renewal" | "trial_ending" | "invoice_unpaid" | "compensation" | "warranty" | "deposit" | "data_held" | "promise";
            principal_id: string;
            space_id: string;
            status: components["schemas"]["__schema566"];
            /** @default null */
            suggested_playbook: string | null;
            summary: string;
        };
        /** @enum {string} */
        __schema566: "found" | "handling" | "waiting" | "settled" | "dropped";
        __schema567: {
            end: number;
            message_id: string;
            quote: string;
            start: number;
        };
        __schema568: {
            amount_minor: components["schemas"]["__schema563"] | null;
            currency: components["schemas"]["__schema564"] | null;
            due_at: components["schemas"]["__schema167"] | null;
            id: string;
            job_id: string | null;
            /** @enum {string} */
            kind: "owed" | "reply";
            sent_at: components["schemas"]["__schema167"] | null;
            status: components["schemas"]["__schema566"];
            what: string;
            who: string;
        };
        __schema569: {
            report: components["schemas"]["FeedbackReport"];
        };
        /**
         * @description A short report id, such as FB-7K3Q
         * @example FB-7K3Q
         */
        __schema570: string;
        __schema571: string;
        __schema572: string;
        __schema573: string | null;
        __schema574: string;
        __schema575: string;
        __schema576: string;
        __schema577: string;
        __schema578: string;
        __schema579: {
            height: number;
            pixel_ratio?: number;
            width: number;
        };
        /** @enum {string} */
        __schema580: "light" | "dark";
        __schema581: components["schemas"]["__schema582"][];
        __schema582: {
            at: components["schemas"]["__schema167"];
            message: string;
        };
        __schema583: components["schemas"]["__schema584"][];
        __schema584: {
            at: components["schemas"]["__schema167"];
            code: string | null;
            method: string;
            status: number | null;
            url: string;
        };
        __schema585: {
            email: string | null;
            principal_id: string | null;
        };
        __schema586: string | null;
        __schema587: {
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
                updated_at: components["schemas"]["__schema167"] | null;
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
                base_url: components["schemas"]["__schema589"] | null;
                base_url_source: ("app" | "operator") | null;
                /** @description A key is set or the owner is signed in, so a model call has a credential. It is not a promise that the provider accepts it; test the connection for that. */
                connected: boolean;
                key: {
                    /** @description The last four characters of a key entered in the app */
                    last_four: components["schemas"]["__schema588"] | null;
                    /**
                     * @description `set`: entered in the app and stored sealed. `operator`: the server environment names a key for this provider; it is used, cannot be changed here, and is never shown.
                     * @enum {string}
                     */
                    state: "unset" | "set" | "operator";
                    updated_at: components["schemas"]["__schema167"] | null;
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
        __schema588: string;
        __schema589: string;
        __schema590: string;
        __schema591: number;
        __schema592: {
            /** @description The signed-in account, when the provider names one */
            account: components["schemas"]["__schema593"] | null;
            /** @description When the current access token expires. The gateway refreshes before then. */
            expires_at: components["schemas"]["__schema167"] | null;
            /** @description The provider as the person knows it, for a "Sign in with" button */
            label: string;
            /** @description What happened and what to do, in plain words, whenever the person has something to do; null when signed in or signed out. */
            message: components["schemas"]["__schema595"] | null;
            methods: ("device" | "browser")[];
            /** @enum {string} */
            provider: "chatgpt" | "openai-compatible";
            /** @description Why a new sign-in is needed */
            reason: components["schemas"]["__schema594"] | null;
            /**
             * @description `sign_in_required` means the provider refused a refresh; model calls to it are refused with `provider_sign_in_required` until the owner signs in again.
             * @enum {string}
             */
            state: "signed_out" | "pending" | "signed_in" | "sign_in_required";
        };
        __schema593: string;
        /** @enum {string} */
        __schema594: "refresh_expired" | "refresh_reused" | "refresh_revoked" | "refresh_refused" | "access_expired";
        __schema595: string;
        __schema596: string;
        __schema597: string;
        __schema598: string;
        /** @enum {string} */
        __schema599: "windows" | "macos" | "linux" | "other";
        __schema600: boolean;
        __schema601: boolean;
        __schema602: boolean;
        __schema603: boolean;
        /** @default false */
        __schema604: boolean;
        __schema605: {
            name: string;
            path: string;
        }[];
        __schema606: boolean | null;
        /** @enum {string} */
        __schema607: "online" | "offline" | "revoked";
        __schema608: boolean;
        __schema609: string | null;
        __schema610: components["schemas"]["__schema167"] | null;
        __schema611: components["schemas"]["__schema167"] | null;
        __schema612: string;
        __schema613: {
            device: components["schemas"]["Device"];
        };
        __schema614: string;
        /** @enum {string} */
        __schema615: "status" | "list_files" | "read_file" | "write_file" | "run" | "open_url" | "screenshot" | "browser_open" | "browser_read" | "browser_click" | "browser_type" | "browser_screenshot";
        __schema616: {
            [key: string]: unknown;
        };
        __schema617: number;
        __schema618: {
            created_at: components["schemas"]["__schema167"];
            current_version: {
                created_at: components["schemas"]["__schema167"];
                created_by: components["schemas"]["__schema623"];
                file_count: components["schemas"]["__schema624"];
                id: components["schemas"]["__schema622"];
                total_bytes: components["schemas"]["__schema625"];
            } | null;
            description: string | null;
            id: components["schemas"]["__schema619"];
            name: string;
            publisher: components["schemas"]["__schema620"];
            role: components["schemas"]["__schema621"];
            updated_at: components["schemas"]["__schema167"];
        };
        __schema619: string;
        __schema620: {
            email: string;
            id: string;
        };
        /** @enum {string} */
        __schema621: "view" | "manage";
        __schema622: string;
        __schema623: components["schemas"]["__schema620"] | null;
        __schema624: number;
        __schema625: number;
        __schema626: {
            app: components["schemas"]["__schema618"];
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
                granted_at: components["schemas"]["__schema167"];
                /** @constant */
                kind: "principal";
                principal: components["schemas"]["__schema620"];
                role: components["schemas"]["__schema621"];
            } | {
                granted_at: components["schemas"]["__schema167"];
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
                created_at: components["schemas"]["__schema167"];
                created_by: components["schemas"]["__schema623"];
                current: boolean;
                file_count: components["schemas"]["__schema624"];
                id: components["schemas"]["__schema622"];
                total_bytes: components["schemas"]["__schema625"];
            }[] | null;
        };
        __schema627: string;
        __schema628: {
            updates: {
                artifact_id: string;
                binding: components["schemas"]["__schema627"];
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
                written_at: components["schemas"]["__schema167"];
            }[];
        };
        __schema629: string;
        __schema630: string;
        __schema631: number;
        /** @enum {string} */
        __schema632: "starting" | "running" | "exited" | "stopped" | "expired" | "lost";
        __schema633: string;
        /** @enum {string} */
        __schema634: "starting" | "running" | "exited" | "stopped" | "expired" | "lost";
        __schema635: string;
        __schema636: number;
        __schema637: string;
        __schema638: string;
        /** @enum {string} */
        __schema639: "on_session_start" | "on_session_end" | "on_session_finalize" | "on_session_reset" | "pre_llm_call" | "post_llm_call" | "pre_tool_call" | "post_tool_call" | "pre_api_request" | "post_api_request" | "api_request_error" | "pre_approval_request" | "post_approval_response" | "subagent_start" | "subagent_stop" | "on_skill_lifecycle" | "on_stream_start" | "on_stream_end" | "pre_verify" | "on_compaction" | "runtime_error";
        __schema640: string | null;
        __schema641: {
            captured_at: components["schemas"]["__schema167"];
            duration_ms: number | null;
        };
        /** @enum {string} */
        __schema642: "started" | "succeeded" | "failed" | "interrupted" | "observed" | "unknown";
        __schema643: string | null;
        __schema644: {
            compression_count?: number;
            in_place?: boolean;
            used_fallback?: boolean;
        };
        __schema645: string;
        Action: {
            attempt_id: components["schemas"]["__schema439"];
            authorization_ref: components["schemas"]["__schema443"];
            budget_reservation: components["schemas"]["__schema444"];
            canonical_payload: components["schemas"]["__schema377"];
            connection_id: components["schemas"]["__schema440"];
            created_at: components["schemas"]["__schema167"];
            dispatched_at: components["schemas"]["__schema446"];
            effect_class: components["schemas"]["EffectClass"];
            id: components["schemas"]["__schema437"];
            idempotency_key: components["schemas"]["__schema445"];
            intent_key: components["schemas"]["__schema442"];
            job_id: components["schemas"]["__schema438"];
            kind: components["schemas"]["__schema441"];
            payload_hash: components["schemas"]["__schema431"];
            receipt: components["schemas"]["__schema447"];
            reconciliation: components["schemas"]["__schema449"];
            repair_counters: components["schemas"]["__schema451"];
            repair_disposition: components["schemas"]["__schema452"];
            repair_trace: components["schemas"]["__schema450"];
            resolved_at: components["schemas"]["__schema448"];
            retry_after_at: components["schemas"]["__schema453"];
            status: components["schemas"]["ActionStatus"];
        };
        /** @enum {string} */
        ActionStatus: "proposed" | "needs_approval" | "approved" | "denied" | "admitted" | "dispatched" | "succeeded" | "failed" | "unknown" | "unresolved";
        ActionSummary: {
            canonical_payload: components["schemas"]["__schema377"];
            created_at: components["schemas"]["__schema167"];
            dispatched_at: components["schemas"]["__schema458"];
            effect_class: components["schemas"]["EffectClass"];
            id: components["schemas"]["__schema454"];
            job_id: components["schemas"]["__schema455"];
            kind: components["schemas"]["__schema456"];
            reconciliation: components["schemas"]["__schema457"];
            resolved_at: components["schemas"]["__schema459"];
            status: components["schemas"]["ActionStatus"];
        };
        Attempt: {
            context_snapshot_ref: components["schemas"]["__schema424"];
            ended_at: components["schemas"]["__schema421"];
            epoch: components["schemas"]["__schema415"];
            id: components["schemas"]["__schema413"];
            job_id: components["schemas"]["__schema414"];
            model: components["schemas"]["__schema418"];
            model_actual: components["schemas"]["__schema419"];
            outcome: components["schemas"]["__schema422"];
            outcome_detail: components["schemas"]["__schema423"];
            provider: components["schemas"]["__schema417"];
            runtime_version: components["schemas"]["__schema416"];
            started_at: components["schemas"]["__schema167"];
            usage: components["schemas"]["__schema420"];
        };
        BrowserControlResponse: {
            control: components["schemas"]["__schema541"];
            control_epoch: components["schemas"]["__schema540"];
            fresh_observation_required: components["schemas"]["__schema542"];
            session_id: components["schemas"]["__schema539"];
        };
        BrowserSite: {
            domain: components["schemas"]["__schema544"];
            label: components["schemas"]["__schema545"];
            last_used: components["schemas"]["__schema546"];
        };
        BrowserSiteForgotten: {
            domain: components["schemas"]["__schema547"];
            forgotten: components["schemas"]["__schema548"];
        };
        BrowserSiteList: {
            sites: components["schemas"]["__schema543"];
        };
        CommandLineConnectionConfig: {
            adapter: components["schemas"]["__schema93"];
            external_id?: components["schemas"]["__schema96"];
            region?: components["schemas"]["__schema94"];
            role_arn?: components["schemas"]["__schema95"];
        };
        Connection: {
            account?: components["schemas"]["__schema473"];
            builtin?: components["schemas"]["__schema470"];
            created_at: components["schemas"]["__schema167"];
            generation?: components["schemas"]["__schema469"];
            health: components["schemas"]["__schema467"];
            id: components["schemas"]["__schema461"];
            label: components["schemas"]["__schema464"];
            last_checked_at: components["schemas"]["__schema474"];
            needs_scope?: components["schemas"]["__schema471"];
            provider: components["schemas"]["__schema463"];
            scopes: components["schemas"]["__schema465"];
            setup_state?: components["schemas"]["__schema468"];
            shared_use?: components["schemas"]["__schema472"];
            space_id: components["schemas"]["__schema462"];
            status: components["schemas"]["__schema466"];
        };
        ConnectionCatalogEntry: {
            available: components["schemas"]["__schema517"];
            connect: components["schemas"]["__schema516"];
            covers: components["schemas"]["__schema515"];
            description: components["schemas"]["__schema514"];
            id: components["schemas"]["__schema512"];
            setup_hint?: components["schemas"]["__schema519"];
            title: components["schemas"]["__schema513"];
            unavailable_reason?: components["schemas"]["__schema518"];
            warning?: components["schemas"]["__schema520"];
        };
        ConnectionCheck: {
            checked_at: components["schemas"]["__schema167"];
            code: components["schemas"]["__schema477"];
            detail: components["schemas"]["__schema478"];
            status: components["schemas"]["__schema476"];
        };
        ConnectionFormField: {
            default?: components["schemas"]["__schema506"];
            help?: components["schemas"]["__schema502"];
            input: components["schemas"]["__schema508"];
            item_fields?: components["schemas"]["__schema510"];
            label: components["schemas"]["__schema501"];
            options?: components["schemas"]["__schema507"];
            path: components["schemas"]["__schema500"];
            placeholder?: components["schemas"]["__schema505"];
            required: components["schemas"]["__schema503"];
            secret: components["schemas"]["__schema504"];
        };
        ConnectionKind: {
            description: components["schemas"]["__schema496"];
            fields: components["schemas"]["__schema499"];
            fixed: components["schemas"]["__schema497"];
            id: components["schemas"]["__schema493"];
            kind: components["schemas"]["__schema494"];
            scopes: components["schemas"]["__schema511"];
            title: components["schemas"]["__schema495"];
        };
        Device: {
            browser_connected: components["schemas"]["__schema608"];
            capabilities: components["schemas"]["DeviceCapabilitiesOutput"];
            cloud_screenshots: components["schemas"]["__schema606"];
            companion_version: components["schemas"]["__schema609"];
            connection_id: components["schemas"]["__schema597"];
            folders: components["schemas"]["__schema605"];
            id: components["schemas"]["__schema596"];
            last_seen_at: components["schemas"]["__schema610"];
            local_capabilities: components["schemas"]["DeviceCapabilitiesOutput"];
            name: components["schemas"]["__schema598"];
            paired_at: components["schemas"]["__schema167"];
            platform: components["schemas"]["__schema599"];
            revoked_at: components["schemas"]["__schema611"];
            status: components["schemas"]["__schema607"];
        };
        DeviceCapabilities: {
            browser?: components["schemas"]["__schema147"];
            commands: components["schemas"]["__schema143"];
            files: components["schemas"]["__schema144"];
            open_url: components["schemas"]["__schema145"];
            screenshot: components["schemas"]["__schema146"];
        };
        DeviceCapabilitiesOutput: {
            browser: components["schemas"]["__schema604"];
            commands: components["schemas"]["__schema600"];
            files: components["schemas"]["__schema601"];
            open_url: components["schemas"]["__schema602"];
            screenshot: components["schemas"]["__schema603"];
        };
        DevicePairing: {
            code: components["schemas"]["__schema612"];
            expires_at: components["schemas"]["__schema167"];
        };
        DeviceRequest: {
            arguments: components["schemas"]["__schema616"];
            deadline: components["schemas"]["__schema617"];
            id: components["schemas"]["__schema614"];
            tool: components["schemas"]["__schema615"];
        };
        /** @enum {string} */
        EffectClass: "read" | "write_reversible" | "write_external" | "spend";
        Event: {
            attempt_id: components["schemas"]["__schema428"];
            created_at: components["schemas"]["__schema167"];
            dedup_key: components["schemas"]["__schema430"];
            job_id: components["schemas"]["__schema427"];
            payload: components["schemas"]["__schema377"];
            seq: components["schemas"]["__schema426"];
            type: components["schemas"]["__schema429"];
        };
        FeedbackContext: {
            color_scheme?: components["schemas"]["__schema126"];
            console_errors?: components["schemas"]["__schema127"];
            failed_requests?: components["schemas"]["__schema129"];
            language?: components["schemas"]["__schema123"];
            route?: components["schemas"]["__schema121"];
            time_zone?: components["schemas"]["__schema124"];
            user_agent?: components["schemas"]["__schema122"];
            viewport?: components["schemas"]["__schema125"];
        };
        FeedbackContextOutput: {
            color_scheme?: components["schemas"]["__schema580"];
            console_errors?: components["schemas"]["__schema581"];
            failed_requests?: components["schemas"]["__schema583"];
            language?: components["schemas"]["__schema577"];
            route?: components["schemas"]["__schema575"];
            time_zone?: components["schemas"]["__schema578"];
            user_agent?: components["schemas"]["__schema576"];
            viewport?: components["schemas"]["__schema579"];
        };
        FeedbackReport: {
            app_version: components["schemas"]["__schema574"];
            context: components["schemas"]["FeedbackContextOutput"];
            created_at: components["schemas"]["__schema167"];
            id: components["schemas"]["__schema570"];
            message: components["schemas"]["__schema571"];
            note: components["schemas"]["__schema586"];
            reporter: components["schemas"]["__schema585"];
            route: components["schemas"]["__schema573"];
            status: components["schemas"]["FeedbackStatus"];
            summary: components["schemas"]["__schema572"];
            updated_at: components["schemas"]["__schema167"];
        };
        /** @enum {string} */
        FeedbackStatus: "open" | "fixing" | "fixed" | "wontfix";
        HookObservation: {
            capture_id: components["schemas"]["__schema638"];
            detail?: components["schemas"]["__schema644"];
            name: components["schemas"]["__schema639"];
            outcome: components["schemas"]["__schema642"];
            redacted_args_digest: components["schemas"]["__schema643"];
            timing: components["schemas"]["__schema641"];
            tool_name: components["schemas"]["__schema640"];
        };
        Job: {
            budget: components["schemas"]["__schema360"];
            constraints: components["schemas"]["__schema355"];
            created_at: components["schemas"]["__schema167"];
            created_by: components["schemas"]["__schema361"];
            id: components["schemas"]["__schema350"];
            lease_epoch: components["schemas"]["__schema357"];
            next_wake_at: components["schemas"]["__schema358"];
            objective: components["schemas"]["__schema354"];
            principal_id?: components["schemas"]["__schema352"];
            revision: components["schemas"]["__schema356"];
            space_id: components["schemas"]["__schema351"];
            state: components["schemas"]["JobState"];
            state_version: components["schemas"]["__schema362"];
            title: components["schemas"]["__schema353"];
            updated_at: components["schemas"]["__schema167"];
            wait: components["schemas"]["__schema359"];
        };
        /** @enum {string} */
        JobState: "queued" | "running" | "waiting_for_input" | "waiting_for_approval" | "waiting_for_event_or_time" | "needs_reconciliation" | "completed" | "failed" | "cancelled";
        KnowledgeFrontmatter: {
            asserted_by: components["schemas"]["__schema59"];
            audience: components["schemas"]["__schema55"];
            confidence: components["schemas"]["__schema58"];
            created: components["schemas"]["__schema61"];
            id: components["schemas"]["__schema52"];
            links?: components["schemas"]["__schema66"];
            observed_at: components["schemas"]["__schema61"];
            schema_version: components["schemas"]["__schema67"];
            source: components["schemas"]["__schema60"];
            space: components["schemas"]["__schema54"];
            status: components["schemas"]["__schema57"];
            superseded_by?: components["schemas"]["__schema64"];
            supersedes?: components["schemas"]["__schema63"];
            tags?: components["schemas"]["__schema65"];
            title: components["schemas"]["__schema53"];
            type: components["schemas"]["__schema56"];
            updated: components["schemas"]["__schema61"];
            valid_from: components["schemas"]["__schema61"];
            valid_until?: components["schemas"]["__schema62"];
        };
        KnowledgeFrontmatterOutput: {
            asserted_by: components["schemas"]["__schema529"];
            audience: components["schemas"]["__schema527"];
            confidence: components["schemas"]["__schema528"];
            created: components["schemas"]["__schema531"];
            id: components["schemas"]["__schema524"];
            links: components["schemas"]["__schema536"];
            observed_at: components["schemas"]["__schema531"];
            schema_version: components["schemas"]["__schema537"];
            source: components["schemas"]["__schema530"];
            space: components["schemas"]["__schema526"];
            status: components["schemas"]["__schema522"];
            superseded_by: components["schemas"]["__schema534"];
            supersedes: components["schemas"]["__schema533"];
            tags: components["schemas"]["__schema535"];
            title: components["schemas"]["__schema525"];
            type: components["schemas"]["__schema521"];
            updated: components["schemas"]["__schema531"];
            valid_from: components["schemas"]["__schema531"];
            valid_until: components["schemas"]["__schema532"];
        };
        LiveClose: {
            live_id: components["schemas"]["__schema108"];
        };
        LiveClosed: {
            closed: components["schemas"]["__schema558"];
        };
        LiveInputResponse: {
            accepted: components["schemas"]["__schema555"];
        };
        LiveOpen: {
            control_epoch: components["schemas"]["__schema550"];
            expires_at: components["schemas"]["__schema554"];
            live_id: components["schemas"]["__schema549"];
            site_scope: components["schemas"]["__schema552"];
            viewport: components["schemas"]["__schema551"];
        };
        LiveScope: {
            host: components["schemas"]["__schema117"];
            live_id: components["schemas"]["__schema108"];
        };
        LiveScopeResponse: {
            site_scope: components["schemas"]["__schema556"];
        };
        Plugin: {
            description: components["schemas"]["__schema481"];
            fields: components["schemas"]["__schema483"];
            id: components["schemas"]["__schema479"];
            installed: components["schemas"]["__schema485"];
            title: components["schemas"]["__schema480"];
            tools: components["schemas"]["__schema484"];
            version: components["schemas"]["__schema482"];
        };
        /** @enum {string} */
        PrivacyCategory: "account" | "card" | "routing" | "ssn" | "tax_id" | "national_id" | "passport" | "license" | "health" | "address" | "phone" | "email" | "dob" | "credential" | "name" | "private";
        /** @enum {string} */
        PrivacyRoute: "cloud" | "local" | "ask" | "on_device";
        ProcessOutput: {
            process_id: components["schemas"]["__schema629"];
            state: components["schemas"]["__schema632"];
            text: components["schemas"]["__schema633"];
        };
        ProcessPreview: {
            expires_at: components["schemas"]["__schema167"];
            path: components["schemas"]["__schema630"];
            port: components["schemas"]["__schema631"];
            process_id: components["schemas"]["__schema629"];
        };
        ProcessStopped: {
            process_id: components["schemas"]["__schema629"];
            state: components["schemas"]["__schema634"];
        };
        RuntimeEvent: {
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            capture_id: components["schemas"]["__schema638"];
            dedup_key: components["schemas"]["__schema637"];
            detail?: components["schemas"]["__schema644"];
            local_seq: components["schemas"]["__schema636"];
            name: components["schemas"]["__schema639"];
            outcome: components["schemas"]["__schema642"];
            redacted_args_digest: components["schemas"]["__schema643"];
            timing: components["schemas"]["__schema641"];
            tool_name: components["schemas"]["__schema640"];
            /** @constant */
            type: "hook_event";
        } | {
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            capture_id: components["schemas"]["__schema638"];
            dedup_key: components["schemas"]["__schema637"];
            detail?: components["schemas"]["__schema644"];
            /** @enum {string} */
            error_code: "observer_failed" | "delivery_failed" | "capture_gap";
            local_seq: components["schemas"]["__schema636"];
            name: components["schemas"]["__schema639"];
            outcome: components["schemas"]["__schema642"];
            redacted_args_digest: components["schemas"]["__schema643"];
            timing: components["schemas"]["__schema641"];
            tool_name: components["schemas"]["__schema640"];
            /** @constant */
            type: "hook_error";
        } | {
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            dedup_key: components["schemas"]["__schema637"];
            local_seq: components["schemas"]["__schema636"];
            turn: number;
            /** @constant */
            type: "turn_started";
        } | {
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            dedup_key: components["schemas"]["__schema637"];
            local_seq: components["schemas"]["__schema636"];
            text: string;
            /** @constant */
            type: "text_delta";
        } | {
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            dedup_key: components["schemas"]["__schema637"];
            local_seq: components["schemas"]["__schema636"];
            text: string;
            /** @constant */
            type: "reasoning_delta";
        } | {
            arguments: components["schemas"]["__schema377"];
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            call_id: string;
            dedup_key: components["schemas"]["__schema637"];
            local_seq: components["schemas"]["__schema636"];
            tool: string;
            /** @constant */
            type: "tool_call_proposed";
        } | {
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            call_id: string;
            dedup_key: components["schemas"]["__schema637"];
            local_seq: components["schemas"]["__schema636"];
            ok: boolean;
            result: components["schemas"]["__schema377"];
            /** @constant */
            type: "tool_result";
        } | {
            action_id: string;
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            dedup_key: components["schemas"]["__schema637"];
            kind: string;
            local_seq: components["schemas"]["__schema636"];
            /** @constant */
            type: "action_requested";
        } | {
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            dedup_key: components["schemas"]["__schema637"];
            local_seq: components["schemas"]["__schema636"];
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
                action_ids: components["schemas"]["__schema645"][];
                /** @constant */
                kind: "waiting_for_approval";
            } | {
                /** @constant */
                kind: "waiting_for_event_or_time";
                wait: components["schemas"]["__schema359"];
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
            usage?: components["schemas"]["__schema420"];
        } | {
            after_seq: number;
            at: components["schemas"]["__schema167"];
            attempt_id: components["schemas"]["__schema635"];
            dedup_key: components["schemas"]["__schema637"];
            local_seq: components["schemas"]["__schema636"];
            reason: string;
            /** @constant */
            type: "gap";
        };
        SandboxComputer: {
            agent_id: components["schemas"]["__schema338"];
            control: components["schemas"]["__schema341"];
            control_epoch: components["schemas"]["__schema342"];
            egress: components["schemas"]["__schema344"];
            job_id: components["schemas"]["__schema337"];
            running: components["schemas"]["__schema340"];
            session_id: components["schemas"]["__schema336"];
            status: components["schemas"]["__schema339"];
            viewport: components["schemas"]["__schema343"];
        };
        SandboxComputerList: {
            computers: components["schemas"]["__schema335"];
        };
        SandboxControlResponse: {
            control: components["schemas"]["__schema341"];
            control_epoch: components["schemas"]["__schema560"];
            session_id: components["schemas"]["__schema559"];
        };
        /** @enum {string} */
        SensitiveTopic: "health" | "therapy" | "finance";
        Space: {
            audience: components["schemas"]["__schema209"];
            created_at: components["schemas"]["__schema167"];
            git_path: components["schemas"]["__schema211"];
            id: components["schemas"]["__schema206"];
            kind: components["schemas"]["__schema208"];
            name: components["schemas"]["__schema207"];
            owner_principal_id?: components["schemas"]["__schema210"];
        };
        SpaceRemoval: {
            blocked_reason: components["schemas"]["__schema220"];
            counts: components["schemas"]["__schema219"];
            finished_at: components["schemas"]["__schema221"];
            id: components["schemas"]["__schema213"];
            kind: components["schemas"]["__schema216"];
            phase: components["schemas"]["__schema218"];
            space_id: components["schemas"]["__schema214"];
            space_name: components["schemas"]["__schema215"];
            started_at: components["schemas"]["__schema167"];
            state: components["schemas"]["__schema217"];
        };
        SpaceRemovalPreview: {
            confirmation: components["schemas"]["__schema227"];
            counts: components["schemas"]["__schema224"];
            kind: components["schemas"]["__schema216"];
            name: components["schemas"]["__schema223"];
            providers: components["schemas"]["__schema225"];
            space_id: components["schemas"]["__schema222"];
            stays: components["schemas"]["__schema226"];
        };
        SpaceRemovalReport: {
            cleared: components["schemas"]["__schema229"];
            headline: components["schemas"]["__schema228"];
            removal: components["schemas"]["SpaceRemoval"];
            still_yours: components["schemas"]["__schema230"];
        };
        WebReadStatus: {
            available: components["schemas"]["__schema294"];
            enabled: components["schemas"]["__schema293"];
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
