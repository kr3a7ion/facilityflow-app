/** A refusal the API should surface to the person, with a message they can act on. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}
