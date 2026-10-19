import type { CapabilityGrantStore } from "./capability-grants.js";

/** Permission to spend the operator's saved Pi login. Never a secret-file mount grant. */
export const OPENROUTER_USE_CAPABILITY = "provider-use:openrouter";

/** Called by trusted local runtime wiring immediately before each provider attempt. */
export function isOpenRouterAdmitted(
  grants: CapabilityGrantStore,
  actorId: string,
  hostRootProof: boolean
): boolean {
  return hostRootProof || grants.activeFor(actorId).includes(OPENROUTER_USE_CAPABILITY);
}
