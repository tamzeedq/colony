// Colony domain model — the data every screen in the design is drawn from.
//
// The source of truth is now `@colony/shared` (packages/shared/src/domain.ts + events.ts),
// which was ported from this file. Screens keep importing from '@/types/colony'.
export * from '@colony/shared'

import type { ProviderConfig } from '@colony/shared'

/**
 * A provider as the API returns it. The control plane never sends a key; it may add a masked
 * hint (`sk-…last4`) and the last test result. Field names for those extras are read defensively.
 */
export type ProviderView = ProviderConfig & {
  keyHint?: string
  maskedKey?: string
  hint?: string
  statusDetail?: string       // short reason when status is 'error'
  testedAt?: string
  lastTestedAt?: string
  lastError?: string
  message?: string
}

export const providerHint = (p: ProviderView) => p.keyHint ?? p.maskedKey ?? p.hint
