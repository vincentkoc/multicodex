const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export function clean(value: unknown, max: number): string {
	return Array.from(String(value ?? ""))
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
		})
		.join("")
		.trim()
		.slice(0, max);
}

export function json(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: {
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

export async function readJson<T>(request: Request, maxBytes = 64 * 1024): Promise<T> {
	const text = await readBoundedText(request, maxBytes);
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new HttpError(400, "invalid json");
	}
}

export async function readBoundedText(
	source: Request | Response,
	maxBytes = 256 * 1024,
): Promise<string> {
	const declared = Number(source.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new HttpError(413, "body too large");
	}
	if (!source.body) return "";
	const reader = source.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > maxBytes) {
				await reader.cancel();
				throw new HttpError(413, "body too large");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return decoder.decode(bytes);
}

export function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

export function slugify(value: string, fallback = "room"): string {
	const slug = clean(value, 80)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || fallback;
}

export function optionalParticipantToken(request: Request): string | null {
	const authorization = request.headers.get("authorization") ?? "";
	const token = clean(authorization.startsWith("Bearer ") ? authorization.slice(7) : "", 100);
	return token || null;
}

export function participantToken(request: Request): string {
	const token = optionalParticipantToken(request);
	if (!token) throw new HttpError(401, "participant capability required");
	return token;
}

export function encodeJson(value: unknown): string {
	return JSON.stringify(value);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function utf8Bytes(value: string): number {
	return encoder.encode(value).byteLength;
}
