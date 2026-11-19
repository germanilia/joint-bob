export const TAKEBACK_WINDOW_MS = 30_000;

export class TakebackWindow {
  readonly deadline: number;
  private declined = false;

  constructor(startedAt = Date.now()) {
    this.deadline = startedAt + TAKEBACK_WINDOW_MS;
  }

  result(now = Date.now()): "pending" | "declined" | "elapsed" {
    if (this.declined) return "declined";
    return now < this.deadline ? "pending" : "elapsed";
  }

  decline(now = Date.now()): boolean {
    if (this.result(now) === "elapsed") return false;
    this.declined = true;
    return true;
  }
}
