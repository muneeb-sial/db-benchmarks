/** Errors the router turns into HTTP status codes. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class BadParams extends HttpError {
  constructor(message: string) {
    super(400, message, 'bad_params');
  }
}

export class UnknownDatabase extends HttpError {
  constructor(db: string, known: readonly string[]) {
    super(404, `unknown database "${db}"; known: ${known.join(', ')}`, 'unknown_db');
  }
}

/** A unique-key collision. Expected in W2, so k6 counts it rather than failing. */
export class UniqueViolation extends HttpError {
  constructor(message = 'unique key violation') {
    super(409, message, 'unique_violation');
  }
}

export class NotInitialized extends HttpError {
  constructor(db: string) {
    super(412, `${db} is not initialized; POST /${db}/initialize first`, 'not_initialized');
  }
}

export class SeedMissing extends HttpError {
  /** `profile` is the server's own profile, so the hint is the exact command to run. */
  constructor(detail: string, profile: string) {
    const flag = profile === 'standard' ? '' : ` --profile ${profile}`;
    super(
      424,
      `${detail}. This server runs profile "${profile}"; generate its seed with: bun src/seed/generate.ts${flag}`,
      'seed_missing',
    );
  }
}

export class NotSupported extends HttpError {
  constructor(engine: string, what: string, reason: string) {
    super(501, `${engine}: ${what} is N/A -- ${reason}`, 'not_supported');
  }
}
