/** Safe errors: every message is written for the model, carries no path or raw exception, and is stable. */

export class OpsError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "OpsError";
        this.code = code;
    }
}

export function fail(code: string, message: string): never {
    throw new OpsError(code, message);
}

/** The only text a caller may see for an unexpected failure. */
export function safeErrorMessage(error: unknown): string {
    if (error instanceof OpsError) {
        return error.message;
    }

    return "ops: operation failed safely; error details are not disclosed";
}

/** True when the signal is aborted because our deadline fired, not because the call was cancelled. */
export function isTimeoutAbort(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true && signal.reason === "ops-timeout";
}

/** Throw a safe error when the signal is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted !== true) {
        return;
    }

    if (isTimeoutAbort(signal)) {
        fail("timeout", "ops: request timed out; narrow the request or raise the owner's limit");
    }

    fail("cancelled", "ops: request was cancelled");
}
