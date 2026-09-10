/** An expected storage failure that the syscall boundary returns as an errno. */
export class FSError extends Error {
  constructor(
    public readonly errno: number,
    public readonly cause?: unknown,
  ) {
    super(`Filesystem error: ${errno}`);
    this.name = "FSError";
  }
}
