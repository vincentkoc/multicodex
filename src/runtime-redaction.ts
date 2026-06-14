import type { RoomSnapshot } from "./domain.ts";

const runtimeIdentifierRedaction = "[redacted Crabfleet runtime identifier]";
const runtimeIdentifierPattern = /\b(?:IS|LOCAL|SIM)-[A-Za-z0-9][A-Za-z0-9._:-]*\b/g;

export function runtimeRedactor(snapshot: RoomSnapshot): (value: string) => string {
	const identifiers = [
		snapshot.room.crabfleetRootSessionId,
		...snapshot.participants.flatMap((participant) => [
			participant.crabfleetSessionId,
			participant.browserUrl,
		]),
		...snapshot.runtimeRedactions,
	]
		.filter((value): value is string => Boolean(value))
		.sort((left, right) => right.length - left.length);
	return (value) => {
		let redacted = value;
		for (const identifier of identifiers) {
			redacted = redacted.replaceAll(identifier, runtimeIdentifierRedaction);
		}
		return redacted.replace(runtimeIdentifierPattern, runtimeIdentifierRedaction);
	};
}

export function redactRuntimeValue(value: unknown, redact: (value: string) => string): unknown {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map((item) => redactRuntimeValue(item, redact));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, redactRuntimeValue(item, redact)]),
		);
	}
	return value;
}
