/** The package's one object guard for session-entry JSON; fields stay `unknown` and are checked where used. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
