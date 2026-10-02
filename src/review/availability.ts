// Provider availability breaker: after consecutive provider-side failures,
// stop paying the timeout price for every ask. During the cooldown the
// reviewer fails closed IMMEDIATELY (defer interactive / deny headless)
// without a network call. When the cooldown expires, the next ask probes the
// provider; success re-closes the circuit, failure re-arms the cooldown.
//
// Deliberately separate from DenialCircuitBreaker: that one guards against
// denial storms (model says no repeatedly); this one guards against provider
// outages (transport/parse failures). Different failure, different response.

const FAILURE_THRESHOLD = 2
const COOLDOWN_MS = 60_000

export class AvailabilityBreaker {
  private consecutiveFailures = 0
  private cooldownUntil = 0

  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** True while the provider is in cooldown: skip the call, fail closed. */
  isCoolingDown(): boolean {
    return this.consecutiveFailures >= FAILURE_THRESHOLD && this.now() < this.cooldownUntil
  }

  /** Record a provider-side failure (transport http/timeout, parse). */
  recordFailure(): void {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.cooldownUntil = this.now() + COOLDOWN_MS
    }
  }

  /** Any successful exchange re-closes the circuit. */
  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.cooldownUntil = 0
  }

  /** Session boundary: availability is per-session, like the denial breaker. */
  reset(): void {
    this.recordSuccess()
  }
}
