export class AIDecisionError extends Error {
  constructor(message, code = "ai_decision_error") {
    super(message);
    this.name = "AIDecisionError";
    this.code = code;
  }
}
