import type { RoomStatus } from "./domain.ts";

export function roomAllowsPlanning(status: RoomStatus): boolean {
	return status === "setup" || status === "planning";
}

export function roomAllowsPresentation(status: RoomStatus): boolean {
	return status === "building" || status === "integrating";
}

export function roomAllowsRuntimeNudge(status: RoomStatus): boolean {
	return status === "building" || status === "integrating";
}
