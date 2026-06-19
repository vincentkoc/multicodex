export function terminalEventBytes(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const streamReader = body.getReader();
			reader = streamReader;
			const decoder = new TextDecoder();
			let buffered = "";
			try {
				while (true) {
					const { done, value } = await streamReader.read();
					if (done) break;
					buffered += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
					buffered = forwardTerminalFrames(buffered, controller);
				}
				buffered += decoder.decode().replaceAll("\r\n", "\n");
				forwardTerminalFrames(buffered, controller);
				controller.close();
			} catch (cause) {
				controller.error(cause);
			} finally {
				streamReader.releaseLock();
			}
		},
		cancel(reason) {
			return reader?.cancel(reason);
		},
	});
}

function forwardTerminalFrames(
	buffered: string,
	controller: ReadableStreamDefaultController<Uint8Array>,
): string {
	while (true) {
		const boundary = buffered.indexOf("\n\n");
		if (boundary < 0) return buffered;
		const frame = buffered.slice(0, boundary);
		buffered = buffered.slice(boundary + 2);
		const event = frame
			.split("\n")
			.find((line) => line.startsWith("event:"))
			?.slice("event:".length)
			.trim();
		const data = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trim())
			.join("");
		if (event === "terminal" && data) controller.enqueue(base64Bytes(data));
	}
}

function base64Bytes(value: string): Uint8Array {
	const decoded = atob(value);
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
