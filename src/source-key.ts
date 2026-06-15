const browserSourceIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function requestSourceKey(
	request: Request,
	browserSourceId: string | null = null,
): Promise<string> {
	const source = request.headers.get("cf-connecting-ip")?.trim() || "unidentified-source";
	const browserSource = browserSourceIdPattern.test(browserSourceId ?? "")
		? browserSourceId!.toLowerCase()
		: "unidentified-browser";
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${source}\0${browserSource}`),
	);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
