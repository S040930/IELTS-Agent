export class StoreError extends Error {
  constructor(message: string, readonly status: 404 | 409 = 409) {
    super(message);
    this.name = "StoreError";
  }
}
