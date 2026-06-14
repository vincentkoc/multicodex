import type { RoomSnapshot } from "./domain.ts";
import { clean, HttpError, readBoundedText } from "./http.ts";

type ConductorTools = {
	postMessage(body: string): Promise<void>;
	recordDecision(input: { title: string; decision: string; reason: string }): Promise<void>;
	nudge(input: { participantId: string; message: string; reason: string }): Promise<void>;
};

type OpenAIOutput = {
	id?: string;
	output?: Array<{
		type?: string;
		name?: string;
		arguments?: string;
		call_id?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
};

export async function runConductorTurn(
	env: Env,
	snapshot: RoomSnapshot,
	trigger: string,
	tools: ConductorTools,
): Promise<void> {
	if (!env.OPENAI_API_KEY) {
		await tools.postMessage(fallbackReply(snapshot, trigger));
		return;
	}
	const toolDefinitions = [
		functionTool(
			"post_room_message",
			"Post one concise visible room message.",
			{
				body: { type: "string" },
			},
			["body"],
		),
		functionTool(
			"record_decision",
			"Record a durable room decision.",
			{
				title: { type: "string" },
				decision: { type: "string" },
				reason: { type: "string" },
			},
			["title", "decision", "reason"],
		),
		functionTool(
			"send_session_nudge",
			"Nudge one participant's Codex workspace.",
			{
				participantId: { type: "string" },
				message: { type: "string" },
				reason: { type: "string" },
			},
			["participantId", "message", "reason"],
		),
	];
	let previousResponseId: string | undefined;
	let input: unknown = [
		{
			role: "user",
			content: `Trigger: ${trigger}\n\nCurrent room state:\n${JSON.stringify(compactSnapshot(snapshot))}`,
		},
	];
	for (let turn = 0; turn < 4; turn += 1) {
		const response = await fetch("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				authorization: `Bearer ${env.OPENAI_API_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: env.OPENAI_MODEL || "gpt-5.4-mini",
				instructions: conductorInstructions,
				input,
				previous_response_id: previousResponseId,
				tools: toolDefinitions,
				parallel_tool_calls: false,
				store: false,
			}),
		});
		if (!response.ok) {
			const detail = await readBoundedText(response, 32 * 1024).catch(() => "");
			throw new HttpError(
				502,
				`OpenAI conductor ${response.status}: ${detail || "request failed"}`,
			);
		}
		const output = JSON.parse(await readBoundedText(response, 256 * 1024)) as OpenAIOutput;
		previousResponseId = output.id;
		const calls = (output.output ?? []).filter((item) => item.type === "function_call");
		if (!calls.length) {
			const text = outputText(output);
			if (text) await tools.postMessage(text);
			return;
		}
		const results: unknown[] = [];
		for (const call of calls) {
			const args = parseArguments(call.arguments);
			const result = await executeTool(call.name ?? "", args, tools);
			results.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: JSON.stringify(result),
			});
		}
		input = results;
	}
}

const conductorInstructions = `You are the visible conductor of a small MultiCodex hackathon room.
Be concise, practical, and calm. Help humans coordinate; do not act like their boss.
Every intervention must be attributable and based on current room evidence.
Use tools to post messages, record decisions, or nudge a participant workspace.
Do not create scope after plan approval. Do not nudge without a specific reason.
Ask the host before destructive actions or material goal changes.`;

function functionTool(
	name: string,
	description: string,
	properties: Record<string, unknown>,
	required: string[],
): Record<string, unknown> {
	return {
		type: "function",
		name,
		description,
		parameters: { type: "object", properties, required, additionalProperties: false },
		strict: true,
	};
}

async function executeTool(
	name: string,
	args: Record<string, unknown>,
	tools: ConductorTools,
): Promise<unknown> {
	if (name === "post_room_message") {
		await tools.postMessage(clean(args.body, 1200));
		return { posted: true };
	}
	if (name === "record_decision") {
		await tools.recordDecision({
			title: clean(args.title, 120),
			decision: clean(args.decision, 500),
			reason: clean(args.reason, 500),
		});
		return { recorded: true };
	}
	if (name === "send_session_nudge") {
		await tools.nudge({
			participantId: clean(args.participantId, 100),
			message: clean(args.message, 2000),
			reason: clean(args.reason, 500),
		});
		return { nudged: true };
	}
	return { error: "unknown tool" };
}

function compactSnapshot(snapshot: RoomSnapshot): unknown {
	return {
		room: snapshot.room,
		participants: snapshot.participants.map((participant) => ({
			id: participant.id,
			name: participant.displayName,
			role: participant.roleId,
			state: participant.state,
			summary: participant.runtimeSummary,
			sessionId: participant.crabfleetSessionId,
		})),
		tasks: snapshot.tasks,
		recentMessages: snapshot.messages.slice(-20),
		recentDecisions: snapshot.decisions.slice(-10),
	};
}

function fallbackReply(snapshot: RoomSnapshot, trigger: string): string {
	const blocked = snapshot.tasks.filter((task) => task.state === "blocked");
	if (blocked.length) {
		return `I see ${blocked.length} blocked task${blocked.length === 1 ? "" : "s"}. Name the dependency and I will route it to the right lane.`;
	}
	if (/next|what should|help/i.test(trigger)) {
		const ready = snapshot.tasks.find((task) => task.state === "ready");
		return ready
			? `Take "${ready.title}" next. Its acceptance criteria are already narrow enough to ship.`
			: "The room is moving. Post a blocker or mark your task ready for review when the contract is stable.";
	}
	return "I am watching the plan, task dependencies, and workspace summaries. Mention me when a contract changes or a lane gets blocked.";
}

function parseArguments(value: string | undefined): Record<string, unknown> {
	try {
		return JSON.parse(value || "{}") as Record<string, unknown>;
	} catch {
		return {};
	}
}

function outputText(output: OpenAIOutput): string {
	return clean(
		(output.output ?? [])
			.flatMap((item) => item.content ?? [])
			.filter((item) => item.type === "output_text")
			.map((item) => item.text ?? "")
			.join("\n"),
		1200,
	);
}
