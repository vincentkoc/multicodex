export async function eventAccessAuthorized(
	provided: string | null,
	expected: string | undefined,
): Promise<boolean> {
	if (!provided || !expected) return false;
	const encoder = new TextEncoder();
	const [providedDigest, expectedDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(provided)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	const workerSubtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (left: ArrayBuffer, right: ArrayBuffer) => boolean;
	};
	if (typeof workerSubtle.timingSafeEqual === "function") {
		return workerSubtle.timingSafeEqual(providedDigest, expectedDigest);
	}
	const left = new Uint8Array(providedDigest);
	const right = new Uint8Array(expectedDigest);
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
	return difference === 0;
}

export function activeRoomLimit(value: string | undefined): number {
	const parsed = Number.parseInt(value || "20", 10);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 20;
}
