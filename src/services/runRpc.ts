import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { logger } from "~/infrastructure/logging/logger";

const MAX_AGENCY_ID_LENGTH = 64;
const MAX_FAILURE_INPUT_LENGTH = 1_000;
const MAX_LOGGED_FAILURE_LENGTH = 300;
const MAX_LOGGED_CAUSES = 3;
const UNPRINTABLE_FAILURE = "Unprintable failure";
const REDACTED = "[redacted]";
const FAILURE_NAME = /^[A-Za-z][\w.-]{0,63}$/;
// Environment-style names identify a missing secret without revealing its value.
const CREDENTIAL_PAIR =
  /(?<![\w.-])[\w-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|signature|secret|key)["']?\s*[:=]\s*(?![A-Z][A-Z0-9]*_[A-Z0-9_]+\b)["']?[^\s"',}]+["']?/gi;
const OPAQUE_TOKEN = /(?<![\w-])(?=[\w+/-]*\d)[\w+/-]{24,}={0,2}/g;

/**
 * Shared runtime for the RPC delegate ceremony: fetch the singleton
 * Effect context, provide it to the caller's program, and time the invocation
 * under the given label. Failures are logged and never caught on behalf of the
 * client, a downstream failure rejects so TanStack Query surfaces real
 * errors. `getContext` stays injectable so the existing test seam survives.
 */
export async function runRpc<S, E, T>(
  options: {
    readonly label: string;
    readonly agencyId?: string;
    readonly getContext: () => Promise<Context.Context<S>>;
  },
  program: (ctx: Context.Context<S>) => Effect.Effect<T, E, S>,
): Promise<T> {
  const start = Date.now();
  logger.debug(`${options.label}: RPC invocation received`);

  try {
    const ctx = await options.getContext();
    const result = await Effect.runPromise(program(ctx).pipe(Effect.provideContext(ctx)));
    logger.debug(`${options.label}: RPC completed`, {
      durationMs: Date.now() - start,
    });
    return result;
  } catch (error) {
    logRpcFailure(options.label, options.agencyId, error);
    throw error;
  }
}

/** Records a failure for diagnosis without changing what the caller receives. */
export function logRpcFailure(label: string, agencyId: string | undefined, failure: unknown): void {
  const causes = failureCauses(failure);
  logger.error(`${label}: RPC failed`, {
    ...(agencyId === undefined ? {} : { agencyId: agencyId.slice(0, MAX_AGENCY_ID_LENGTH) }),
    error: describeFailure(failure),
    ...(causes.length === 0 ? {} : { cause: causes.map(describeFailure).join(" <- ") }),
  });
}

/** Failures can be arbitrary objects, including ones with throwing accessors. */
function readField(value: unknown, field: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

function failureCauses(failure: unknown): readonly unknown[] {
  const causes: unknown[] = [];
  let current = failure;
  while (causes.length < MAX_LOGGED_CAUSES) {
    current = readField(current, "cause");
    if (current === undefined) break;
    causes.push(current);
  }
  return causes;
}

function describeFailure(failure: unknown): string {
  const text = (field: string) => {
    const value = readField(failure, field);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const status = readField(failure, "status");
  const name = text("_tag") ?? text("name");
  const parts = [
    name !== undefined && FAILURE_NAME.test(name) ? name : undefined,
    typeof status === "number" ? `status ${status}` : undefined,
    text("message"),
  ].filter((part) => part !== undefined);
  if (parts.length > 0) return redactFailureText(parts.join(": "));
  return typeof failure === "object" || typeof failure === "function"
    ? UNPRINTABLE_FAILURE
    : redactFailureText(String(failure));
}

/** Keeps the upstream host for diagnosis and drops everything that can carry a credential. */
function urlHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return REDACTED;
  }
}

/** Checked per word because a single unbounded pattern backtracks on repeated `?`. */
function carriesEncodedCredential(word: string): boolean {
  if (word.toUpperCase().includes("%3A%2F%2F")) return true;
  const assignment = word.lastIndexOf("=");
  if (assignment < 0) return false;
  const query = word.indexOf("?");
  const separator = word.indexOf("&");
  return (query >= 0 && query < assignment) || (separator >= 0 && separator < assignment);
}

/** Failure text can quote upstream URLs and headers that carry credentials. */
function redactFailureText(text: string): string {
  return text
    .slice(0, MAX_FAILURE_INPUT_LENGTH)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, urlHost)
    .replace(/\b((?:[\w-]+\.)+[a-z]{2,})\/\S*/gi, "$1")
    .replace(/\S+/g, (word) => (carriesEncodedCredential(word) ? REDACTED : word))
    .replace(/\bauthorization["']?\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?\S+/gi, REDACTED)
    .replace(/\bbearer\s+\S+/gi, REDACTED)
    .replace(CREDENTIAL_PAIR, REDACTED)
    .replace(OPAQUE_TOKEN, REDACTED)
    .slice(0, MAX_LOGGED_FAILURE_LENGTH);
}
