import type { CapabilityClaims } from '@melete/contracts';

/** A signed opt-in follows live grants only after the caller's attempt and principal fence passes. */
export function grantsConnectionScopes(
  claims: CapabilityClaims,
  granted: readonly string[],
  required: readonly string[],
): boolean {
  return required.every(
    (scope) =>
      granted.includes(scope) &&
      (claims.scopes.includes(scope) ||
        (claims.live_connection_scopes === true && !!claims.principal_id)),
  );
}
