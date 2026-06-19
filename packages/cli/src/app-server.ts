import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

type JsonRpcResponse = {
	id?: number;
	result?: unknown;
	error?: { message?: string };
	method?: string;
	params?: Record<string, unknown>;
};

export type AppServerNotification = {
	method: string;
	params: Record<string, unknown>;
};

export class CodexAppServerClient {
	readonly endpoint: string;
	private socket: WebSocket | null = null;
	private nextRequestId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (cause: Error) => void }
	>();
	private readonly notificationHandlers = new Set<(notification: AppServerNotification) => void>();

	constructor(endpoint: string) {
		this.endpoint = endpoint;
	}

	async connect(timeoutMs = 15_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		let lastError = new Error("app-server connection timed out");
		while (Date.now() < deadline) {
			try {
				await this.open();
				await this.request("initialize", {
					clientInfo: { name: "multicodex-alpha", title: "MultiCodex Alpha", version: "0.1.0" },
					capabilities: { experimentalApi: true },
				});
				this.notify("initialized", {});
				return;
			} catch (cause) {
				lastError = cause instanceof Error ? cause : new Error(String(cause));
				this.socket?.close();
				this.socket = null;
				await delay(150);
			}
		}
		throw lastError;
	}

	onNotification(handler: (notification: AppServerNotification) => void): () => void {
		this.notificationHandlers.add(handler);
		return () => this.notificationHandlers.delete(handler);
	}

	async startThread(cwd: string): Promise<string> {
		const result = (await this.request("thread/start", {
			cwd,
			developerInstructions:
				"You are a builder lane in a MultiCodex room. Keep user-visible progress concise and continue to follow local approvals.",
		})) as { thread?: { id?: string } };
		const threadId = result.thread?.id;
		if (!threadId) throw new Error("Codex app-server did not return a thread id");
		return threadId;
	}

	async resumeThread(threadId: string): Promise<void> {
		await this.request("thread/resume", {
			threadId,
			excludeTurns: true,
		});
	}

	async startTurn(threadId: string, text: string): Promise<string> {
		const result = (await this.request("turn/start", {
			threadId,
			input: [{ type: "text", text, text_elements: [] }],
		})) as { turn?: { id?: string } };
		const turnId = result.turn?.id;
		if (!turnId) throw new Error("Codex app-server did not return a turn id");
		return turnId;
	}

	async steer(threadId: string, turnId: string, text: string): Promise<void> {
		await this.request("turn/steer", {
			threadId,
			expectedTurnId: turnId,
			input: [{ type: "text", text, text_elements: [] }],
		});
	}

	async interrupt(threadId: string, turnId: string): Promise<void> {
		await this.request("turn/interrupt", { threadId, turnId });
	}

	close(): void {
		const socket = this.socket;
		this.socket = null;
		socket?.close();
		for (const pending of this.pending.values()) {
			pending.reject(new Error("Codex app-server connection closed"));
		}
		this.pending.clear();
	}

	private async open(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const socket = new WebSocket(this.endpoint);
			const timer = setTimeout(() => {
				socket.close();
				reject(new Error("Codex app-server connection timed out"));
			}, 2_000);
			socket.addEventListener("open", () => {
				clearTimeout(timer);
				this.socket = socket;
				resolve();
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error("Codex app-server is not ready"));
			});
			socket.addEventListener("message", (event) => this.receive(String(event.data)));
			socket.addEventListener("close", () => {
				if (this.socket === socket) this.close();
			});
		});
	}

	private request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Codex app-server is not connected"));
		}
		const id = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	private notify(method: string, params: Record<string, unknown>): void {
		this.socket?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
	}

	private receive(raw: string): void {
		let message: JsonRpcResponse;
		try {
			message = JSON.parse(raw) as JsonRpcResponse;
		} catch {
			return;
		}
		if (typeof message.id === "number" && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id)!;
			this.pending.delete(message.id);
			if (message.error)
				pending.reject(new Error(message.error.message ?? "app-server request failed"));
			else pending.resolve(message.result);
			return;
		}
		if (message.method) {
			const notification = { method: message.method, params: message.params ?? {} };
			for (const handler of this.notificationHandlers) handler(notification);
		}
	}
}

export async function startCodexAppServer(
	codexPath = "codex",
	environment?: NodeJS.ProcessEnv,
): Promise<{
	endpoint: string;
	child: ChildProcess;
	stop: () => void;
}> {
	const port = await freePort();
	const endpoint = `ws://127.0.0.1:${port}`;
	const child = spawn(codexPath, ["app-server", "--listen", endpoint], {
		stdio: ["ignore", "ignore", "pipe"],
		env: environment,
	});
	let recentError = "";
	child.stderr?.on("data", (chunk) => {
		recentError = `${recentError}${String(chunk)}`.slice(-4_000);
	});
	await Promise.race([
		delay(100),
		new Promise<never>((_, reject) =>
			child.once("exit", (code) =>
				reject(new Error(`Codex app-server exited (${code ?? "signal"}): ${recentError}`)),
			),
		),
	]);
	return {
		endpoint,
		child,
		stop: () => {
			if (!child.killed) child.kill("SIGTERM");
		},
	};
}

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error("failed to allocate port"))));
		});
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
