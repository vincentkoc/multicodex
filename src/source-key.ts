export async function requestSourceKey(request: Request): Promise<string> {
	const source = request.headers.get("cf-connecting-ip")?.trim() || "unidentified-source";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
