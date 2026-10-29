/** Minimal runtime shape checks for tools this layer wraps. A mismatch means passthrough, never a guess. */

interface Schema {
    readonly type?: unknown;
    readonly properties?: unknown;
    readonly required?: unknown;
    readonly anyOf?: unknown;
    readonly oneOf?: unknown;
}

function schema(value: unknown): Schema | undefined {
    return typeof value === "object" && value !== null ? (value as Schema) : undefined;
}

function properties(value: Schema | undefined): Record<string, unknown> | undefined {
    return typeof value?.properties === "object" && value.properties !== null
        ? (value.properties as Record<string, unknown>)
        : undefined;
}

function hasProperty(value: Schema | undefined, name: string): boolean {
    return Object.hasOwn(properties(value) ?? {}, name);
}

function isRequired(value: Schema | undefined, name: string): boolean {
    return Array.isArray(value?.required) && value.required.includes(name);
}

function objectWithRequired(value: unknown, names: readonly string[]): boolean {
    const found = schema(value);

    return (
        found?.type === "object" &&
        names.every((name) => hasProperty(found, name) && isRequired(found, name))
    );
}

/** The 0.18 built-in read: an object with a required relative `path` and optional range fields. */
export function builtinReadShape(parameters: unknown): boolean {
    const found = schema(parameters);

    return (
        objectWithRequired(parameters, ["path"]) &&
        found !== undefined &&
        (!hasProperty(found, "offset") || typeof properties(found)?.offset === "object") &&
        (!hasProperty(found, "limit") || typeof properties(found)?.limit === "object")
    );
}
