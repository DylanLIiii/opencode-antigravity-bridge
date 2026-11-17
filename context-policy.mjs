// Physical model limits and ACP usage_update.size do not unlock CLI checkpoints.
// Use the same client declaration policy in the provider and its settings page.
export const CONTEXT_LIMITS = Object.freeze({ default: 512_000, managed: 1_048_576, gptOss: 131_072 })

export function declaredContextWindow({ model = "", unlocked = false, requested, physical } = {}) {
  const ceiling = unlocked ? CONTEXT_LIMITS.managed : CONTEXT_LIMITS.default
  const override = Number(requested)
  const configured = Number.isSafeInteger(override) && override > 0 && override <= CONTEXT_LIMITS.managed
    ? override : ceiling
  const modelLimit = Number.isSafeInteger(physical) && physical > 0 ? physical : ceiling
  const window = Math.min(configured, modelLimit, ceiling)
  return /^gpt-oss-120b(?:-|$)/i.test(model) ? Math.min(window, CONTEXT_LIMITS.gptOss) : window
}
