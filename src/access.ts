export function activeRoomLimit(value: string | undefined): number {
	const parsed = Number.parseInt(value || "20", 10);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 20;
}
