import { AIDecisionError } from "../../platform/ai-decision-error.js";

/** Model answers that were delivered but unusable: re-ask with the error fed back. */
export const RETRYABLE_CODES = Object.freeze(
  new Set(["illegal_action", "invalid_sizing", "invalid_output", "invalid_json", "empty_output", "output_truncated", "rule_rejected"]),
);

export const MAX_DECISION_RETRIES = 2;

export function isRetryableDecisionError(error) {
  return error instanceof AIDecisionError && RETRYABLE_CODES.has(error.code);
}

function feedbackFor(error, attempt) {
  return {
    attempt,
    error: String(error?.message || error).slice(0, 300),
    instruction:
      "Your previous answer was rejected by the table. Choose again: use only an action listed in legal.actions; for bet or raise, target_total must be an integer between legal.minimumTotal and legal.maximumTotal; otherwise target_total must be null.",
  };
}

/**
 * Asks the model for a decision and applies it. A malformed or illegal answer is retried up to
 * `maxRetries` times with the rejection fed back in `snapshot.previousAttemptRejected`; network,
 * key and other provider errors are thrown at once so the room can pause for an explicit retry.
 *
 * request(snapshot) -> decision; apply(decision) must throw when the engine rejects it.
 */
export async function decideWithRetries({ snapshot, request, apply, maxRetries = MAX_DECISION_RETRIES, onRetry = () => {} }) {
  let feedback = null;
  for (let attempt = 1; ; attempt += 1) {
    const input = feedback ? { ...snapshot, previousAttemptRejected: feedback } : snapshot;
    let failure;
    try {
      const decision = await request(input);
      try {
        apply(decision);
        return { decision, attempts: attempt };
      } catch (error) {
        failure = error instanceof AIDecisionError ? error : new AIDecisionError(String(error?.message || error), "rule_rejected");
      }
    } catch (error) {
      if (!isRetryableDecisionError(error)) throw error;
      failure = error;
    }
    if (attempt > maxRetries) {
      throw new AIDecisionError(`${failure.message} (rejected ${attempt} times in a row)`, failure.code);
    }
    feedback = feedbackFor(failure, attempt);
    onRetry({ attempt, error: failure });
  }
}
