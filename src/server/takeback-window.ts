export const TAKEBACK_WINDOW_MS = 30_000;

export class TakebackWindow {
  readonly deadline: number;
  private declined = false;
  private accepted = false;

  constructor(startedAt = Date.now()) {
    this.deadline = startedAt + TAKEBACK_WINDOW_MS;
  }

  result(now = Date.now()): "pending" | "declined" | "elapsed" {
    if (this.declined) return "declined";
    if (this.accepted) return "elapsed";
    return now < this.deadline ? "pending" : "elapsed";
  }

  accept(now = Date.now()): boolean {
    if (this.result(now) !== "pending") return false;
    this.accepted = true;
    return true;
  }

  decline(now = Date.now()): boolean {
    if (this.result(now) !== "pending") return false;
    this.declined = true;
    return true;
  }
}
