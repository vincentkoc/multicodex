import {
	ArrowRight,
	Bot,
	Check,
	CircleStop,
	Clipboard,
	Code2,
	Copy,
	ExternalLink,
	GitBranch,
	LayoutDashboard,
	MonitorPlay,
	RefreshCw,
	Rocket,
	Send,
	Shuffle,
	Sparkles,
	TimerReset,
	UserPlus,
	Users,
	WandSparkles,
	X,
	Zap,
} from "lucide-preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
	Participant,
	RoomMessage,
	RoomSnapshot,
	RoomStatus,
	Task,
	TaskState,
} from "../domain.ts";
import { roomAllowsMessages, roomAllowsRuntimeNudge } from "../room-state.ts";
import {
	ApiError,
	catalog,
	type Catalog,
	createRoom,
	issueRoomSocketTicket,
	joinRoom,
	nudgeParticipant,
	postMessage,
	readMessagesPage,
	readRoom,
	type RoomIdentity,
	roomAction,
	roomSocketUrl,
	setTaskState,
} from "./api.ts";

type View = "workbench" | "recap";
type Target = { kind: "room" | "conductor" | "participant"; id?: string };
type NudgeDraft = { participant: Participant; message: string; reason: string };

const taskStates: TaskState[] = ["ready", "active", "blocked", "review", "done", "cut"];
const roleFallbacks = ["#e24a33", "#2563eb", "#16825d", "#d99b16", "#8b5cf6"];

export function App() {
	const [roomId, setRoomId] = useState(roomIdFromPath());
	const [identity, setIdentity] = useState<RoomIdentity | null>(() =>
		roomId ? loadIdentity(roomId) : null,
	);
	const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
	const [roleCatalog, setRoleCatalog] = useState<Catalog["roles"]>([]);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(Boolean(roomId));
	const [socketConnected, setSocketConnected] = useState(false);
	const snapshotRequestSequence = useRef(0);
	const [builderInviteToken, clearBuilderInviteToken] = useBuilderInviteToken(roomId);

	useEffect(() => {
		const synchronizeHistory = () => {
			const nextRoomId = roomIdFromPath();
			snapshotRequestSequence.current += 1;
			setRoomId(nextRoomId);
			setIdentity(nextRoomId ? loadIdentity(nextRoomId) : null);
			setSnapshot(null);
			setSocketConnected(false);
			setError("");
			setLoading(Boolean(nextRoomId));
		};
		window.addEventListener("popstate", synchronizeHistory);
		return () => window.removeEventListener("popstate", synchronizeHistory);
	}, []);

	useEffect(() => {
		catalog()
			.then((value) => setRoleCatalog(value.roles))
			.catch(() => setRoleCatalog([]));
	}, []);

	const refreshRoom = useCallback(async (): Promise<void> => {
		if (!roomId) return;
		const sequence = ++snapshotRequestSequence.current;
		try {
			let value: RoomSnapshot;
			try {
				value = await readRoom(roomId, identity?.participantToken);
			} catch (cause) {
				if (!identity?.participantToken || !(cause instanceof ApiError) || cause.status !== 403) {
					throw cause;
				}
				value = await readRoom(roomId);
				if (sequence === snapshotRequestSequence.current && roomIdFromPath() === roomId) {
					clearIdentity(roomId);
					setIdentity(null);
				}
			}
			if (sequence === snapshotRequestSequence.current && roomIdFromPath() === roomId) {
				setSnapshot(value);
			}
		} catch (cause) {
			if (sequence === snapshotRequestSequence.current) throw cause;
		}
	}, [roomId, identity?.participantToken]);

	useEffect(() => {
		if (!roomId) return;
		let disposed = false;
		setLoading(true);
		refreshRoom()
			.catch((cause: Error) => {
				if (!disposed) setError(cause.message);
			})
			.finally(() => {
				if (!disposed) setLoading(false);
			});
		return () => {
			disposed = true;
		};
	}, [roomId, identity?.participantToken, refreshRoom]);

	useEffect(() => {
		if (!roomId || !snapshot || snapshot.room.status === "ended") return;
		let disposed = false;
		const intervalMilliseconds = socketConnected ? 60_000 : 10_000;
		const interval = window.setInterval(() => {
			refreshRoom().catch((cause: Error) => {
				if (!disposed) setError(cause.message);
			});
		}, intervalMilliseconds);
		return () => {
			disposed = true;
			window.clearInterval(interval);
		};
	}, [roomId, snapshot?.room.status, socketConnected, refreshRoom]);

	useEffect(() => {
		if (!roomId || !snapshot || snapshot.room.status === "ended") return;
		setSocketConnected(false);
		let socket: WebSocket | null = null;
		let retry: number | null = null;
		let retryAttempt = 0;
		let connecting = false;
		let disposed = false;
		const syncRoom = () => {
			refreshRoom().catch((cause: Error) => {
				if (!disposed) setError(cause.message);
			});
		};
		const scheduleReconnect = () => {
			if (disposed || retry !== null) return;
			const baseDelay = Math.min(30_000, 1000 * 2 ** Math.min(retryAttempt, 5));
			retryAttempt += 1;
			const delay = baseDelay + Math.floor(Math.random() * Math.max(250, baseDelay / 4));
			retry = window.setTimeout(() => {
				retry = null;
				void connect();
			}, delay);
		};
		const connect = async () => {
			if (connecting || disposed) return;
			connecting = true;
			let ticket: string | null = null;
			if (identity?.participantToken) {
				try {
					ticket = await issueRoomSocketTicket(roomId, identity.participantToken);
				} catch {
					connecting = false;
					scheduleReconnect();
					return;
				}
			}
			connecting = false;
			if (disposed) return;
			socket = new WebSocket(roomSocketUrl(roomId, ticket));
			socket.onopen = () => {
				retryAttempt = 0;
				setSocketConnected(true);
				syncRoom();
			};
			socket.onmessage = (event) => {
				if (event.data === "pong") return;
				const payload = JSON.parse(String(event.data)) as { type: string };
				if (payload.type === "changed") syncRoom();
			};
			socket.onclose = () => {
				setSocketConnected(false);
				scheduleReconnect();
			};
		};
		void connect();
		return () => {
			disposed = true;
			if (retry !== null) window.clearTimeout(retry);
			socket?.close();
			setSocketConnected(false);
		};
	}, [roomId, snapshot?.room.status, identity?.participantToken, refreshRoom]);

	function enterRoom(next: RoomSnapshot, nextIdentity: RoomIdentity): boolean {
		const identity = minimalRoomIdentity(nextIdentity);
		const persisted = persistIdentity(next.room.id, identity);
		const cleanPath = `/rooms/${next.room.id}`;
		if (roomIdFromPath() === next.room.id) {
			history.replaceState({ roomId: next.room.id }, "", cleanPath);
		} else {
			history.pushState({ roomId: next.room.id }, "", cleanPath);
		}
		snapshotRequestSequence.current += 1;
		clearBuilderInviteToken();
		setRoomId(next.room.id);
		setIdentity(identity);
		setSnapshot(next);
		setError("");
		return persisted;
	}

	if (!roomId) return <CreateRoom onEnter={enterRoom} />;
	if (loading && !snapshot) return <LoadingRoom />;
	if (error && !snapshot) return <ErrorRoom message={error} />;
	if (!snapshot) return null;
	const validParticipant = identity
		? snapshot.participants.find((participant) => participant.id === identity.participantId)
		: null;
	const validIdentity = validParticipant ? identity : null;
	if (
		!validIdentity &&
		["cleanup-planning", "cleanup-ending", "ended"].includes(snapshot.room.status)
	) {
		return (
			<Recap
				snapshot={snapshot}
				roleMap={new Map(roleCatalog.map((role) => [role.id, role]))}
				onBack={() => {
					history.pushState({}, "", "/");
					setRoomId(null);
					setSnapshot(null);
				}}
				backLabel="home"
				busy=""
			/>
		);
	}
	const observerCanUseBuilderInvite =
		validParticipant?.kind === "observer" &&
		Boolean(builderInviteToken) &&
		["setup", "planning"].includes(snapshot.room.status);
	if (!validIdentity || observerCanUseBuilderInvite) {
		return <JoinRoom snapshot={snapshot} inviteToken={builderInviteToken} onEnter={enterRoom} />;
	}

	return (
		<RoomWorkbench
			snapshot={snapshot}
			identity={validIdentity}
			roleCatalog={roleCatalog}
			onRefresh={refreshRoom}
			onError={setError}
			error={error}
		/>
	);
}

function CreateRoom({
	onEnter,
}: {
	onEnter: (snapshot: RoomSnapshot, identity: RoomIdentity) => boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const createRequestId = useMemo(loadCreateRequestId, []);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const data = new FormData(event.currentTarget as HTMLFormElement);
		setBusy(true);
		setError("");
		try {
			const result = await createRoom({
				title: String(data.get("title") || "OpenAI event build"),
				hostName: String(data.get("hostName") || "Host"),
				repo: String(data.get("repo") || "vincentkoc/multicodex"),
				durationMinutes: Number(data.get("durationMinutes") || 30),
				eventCode: String(data.get("eventCode") || "").trim(),
				requestId: createRequestId,
			});
			if (onEnter(result.snapshot, result)) clearCreateRequestId();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<main class="entry-shell">
			<section class="entry-stage">
				<Brand />
				<div class="entry-art" aria-hidden="true">
					<div class="entry-art-grid">
						{["brief", "design", "backend", "demo"].map((label, index) => (
							<div class={`entry-lane lane-${index}`} key={label}>
								<span>{label}</span>
								<Code2 size={22} />
							</div>
						))}
					</div>
					<div class="entry-conductor">
						<WandSparkles size={20} />
						<span>conductor</span>
						<i />
					</div>
				</div>
			</section>
			<section class="entry-form-wrap">
				<div class="entry-form-header">
					<span class="eyebrow">new room</span>
					<h1>start the build</h1>
					<p>one team room, one Codex workspace per person.</p>
				</div>
				<form class="entry-form" onSubmit={submit}>
					<label>
						Room name
						<input name="title" defaultValue="OpenAI event build" required maxLength={100} />
					</label>
					<label>
						Your name
						<input name="hostName" placeholder="Vincent" required maxLength={80} />
					</label>
					<label>
						Event code
						<input name="eventCode" type="password" required maxLength={200} autoComplete="off" />
					</label>
					<label>
						GitHub repo
						<input name="repo" defaultValue="vincentkoc/multicodex" required maxLength={160} />
					</label>
					<label>
						Sprint
						<select name="durationMinutes" defaultValue="30">
							<option value="10">10 minutes</option>
							<option value="20">20 minutes</option>
							<option value="30">30 minutes</option>
							<option value="45">45 minutes</option>
							<option value="60">60 minutes</option>
						</select>
					</label>
					{error && <InlineError message={error} />}
					<button class="button primary wide" type="submit" disabled={busy}>
						<Rocket size={17} />
						{busy ? "starting..." : "create room"}
					</button>
				</form>
			</section>
		</main>
	);
}

function JoinRoom({
	snapshot,
	inviteToken,
	onEnter,
}: {
	snapshot: RoomSnapshot;
	inviteToken: string | undefined;
	onEnter: (snapshot: RoomSnapshot, identity: RoomIdentity) => boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [kind, setKind] = useState<"human" | "ai" | "observer">(inviteToken ? "human" : "observer");
	const joinRequestId = useMemo(() => loadJoinRequestId(snapshot.room.id), [snapshot.room.id]);

	useEffect(() => setKind(inviteToken ? "human" : "observer"), [inviteToken]);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const data = new FormData(event.currentTarget as HTMLFormElement);
		setBusy(true);
		setError("");
		try {
			const result = await joinRoom(snapshot.room.id, {
				displayName: String(data.get("displayName") || ""),
				githubLogin: String(data.get("githubLogin") || ""),
				kind,
				requestId: joinRequestId,
				inviteToken,
			});
			if (onEnter(result.snapshot, result)) clearJoinRequestId(snapshot.room.id);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	if (!inviteToken) return <PublicRoom snapshot={snapshot} />;

	return (
		<main class="join-shell">
			<section class="join-context">
				<Brand />
				<span class={`status-pill status-${snapshot.room.status}`}>{snapshot.room.status}</span>
				<h1>{snapshot.room.title}</h1>
				<p>
					{snapshot.room.brief.productGoal ||
						"the conductor is waiting to shape the build with the team."}
				</p>
				<div class="join-people">
					{snapshot.participants.map((participant, index) => (
						<span
							key={participant.id}
							style={{ "--role": roleFallbacks[index % roleFallbacks.length] }}
						>
							{initials(participant.displayName)}
						</span>
					))}
					<strong>{snapshot.participants.length} in room</strong>
				</div>
			</section>
			<form class="join-form" onSubmit={submit}>
				<span class="eyebrow">join room</span>
				<h2>take a seat</h2>
				<label>
					Display name
					<input name="displayName" required autoFocus maxLength={80} />
				</label>
				<label>
					GitHub handle
					<input name="githubLogin" placeholder="optional" maxLength={80} />
				</label>
				<label>
					Seat
					<select
						name="kind"
						value={kind}
						onChange={(event) => setKind(event.currentTarget.value as "human" | "ai" | "observer")}
					>
						<option value="human">Builder</option>
						<option value="ai">AI builder</option>
						<option value="observer">Observer</option>
					</select>
				</label>
				{error && <InlineError message={error} />}
				<button class="button primary wide" type="submit" disabled={busy}>
					<UserPlus size={17} />
					{busy ? "joining..." : "join build"}
				</button>
			</form>
		</main>
	);
}

function PublicRoom({ snapshot }: { snapshot: RoomSnapshot }) {
	const recentMessages = snapshot.messages.slice(-6);
	const activeTasks = snapshot.tasks.filter((task) => task.state !== "cut").slice(0, 5);
	return (
		<main class="join-shell">
			<section class="join-context">
				<Brand />
				<span class={`status-pill status-${snapshot.room.status}`}>{snapshot.room.status}</span>
				<h1>{snapshot.room.title}</h1>
				<p>
					{snapshot.room.brief.productGoal ||
						"the conductor is waiting to shape the build with the team."}
				</p>
				<div class="join-people">
					{snapshot.participants.map((participant, index) => (
						<span
							key={participant.id}
							style={{ "--role": roleFallbacks[index % roleFallbacks.length] }}
						>
							{initials(participant.displayName)}
						</span>
					))}
					<strong>{snapshot.participants.length} in room</strong>
				</div>
			</section>
			<section class="join-form public-room">
				<div class="public-room-heading">
					<div>
						<span class="eyebrow">public view</span>
						<h2>watching live</h2>
					</div>
					<span class="presence online" />
				</div>
				<div class="public-room-stats">
					<div>
						<strong>{snapshot.tasks.length}</strong>
						<span>tasks</span>
					</div>
					<div>
						<strong>{snapshot.messageCount}</strong>
						<span>events</span>
					</div>
					<div>
						<strong>{snapshot.participants.length}</strong>
						<span>seats</span>
					</div>
				</div>
				<div class="public-room-section">
					<span class="eyebrow">current work</span>
					<div class="public-task-list">
						{activeTasks.map((task) => (
							<div key={task.id}>
								<strong>{task.title}</strong>
								<span>{task.state}</span>
							</div>
						))}
						{!activeTasks.length && <p class="quiet-empty">the plan is taking shape.</p>}
					</div>
				</div>
				<div class="public-room-section">
					<span class="eyebrow">room line</span>
					<div class="public-message-list">
						{recentMessages.map((message) => (
							<Message
								key={message.id}
								message={message}
								participants={snapshot.participants}
								mine={false}
							/>
						))}
						{!recentMessages.length && <p class="quiet-empty">no room events yet.</p>}
					</div>
				</div>
			</section>
		</main>
	);
}

function RoomWorkbench({
	snapshot,
	identity,
	roleCatalog,
	onRefresh,
	onError,
	error,
}: {
	snapshot: RoomSnapshot;
	identity: RoomIdentity;
	roleCatalog: Catalog["roles"];
	onRefresh: () => Promise<void>;
	onError: (error: string) => void;
	error: string;
}) {
	const [view, setView] = useState<View>(
		snapshot.room.status === "presenting" ? "recap" : "workbench",
	);
	const [busy, setBusy] = useState("");
	const [copied, setCopied] = useState(false);
	const [nudge, setNudge] = useState<NudgeDraft | null>(null);
	const { participantId, participantToken } = identity;
	const me = snapshot.participants.find((participant) => participant.id === participantId)!;
	const isHost = snapshot.room.hostParticipantId === participantId;
	const readOnly = me.kind === "observer";
	const canNudge = isHost && roomAllowsRuntimeNudge(snapshot.room.status);
	const roleMap = useMemo(() => new Map(roleCatalog.map((role) => [role.id, role])), [roleCatalog]);

	useEffect(() => {
		if (snapshot.room.status === "presenting" || snapshot.room.status === "ended") setView("recap");
	}, [snapshot.room.status]);

	useEffect(() => {
		if (!canNudge) setNudge(null);
	}, [canNudge]);

	async function action(label: string, run: () => Promise<RoomSnapshot>): Promise<boolean> {
		setBusy(label);
		onError("");
		try {
			await run();
			try {
				await onRefresh();
			} catch (cause) {
				onError(`action completed; room refresh failed: ${errorMessage(cause)}`);
			}
			return true;
		} catch (cause) {
			onError(errorMessage(cause));
			return false;
		} finally {
			setBusy("");
		}
	}

	async function copyInvite() {
		const invite = new URL(`/rooms/${snapshot.room.id}`, location.origin);
		if (isHost && identity.builderInviteToken) {
			invite.hash = new URLSearchParams({ invite: identity.builderInviteToken }).toString();
		}
		await navigator.clipboard.writeText(invite.toString());
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1600);
	}

	async function changeTask(task: Task, state: TaskState) {
		await action(`task-${task.id}`, () =>
			setTaskState(snapshot.room.id, participantToken, task.id, state),
		);
	}

	async function sendNudge() {
		if (!nudge || !canNudge) return;
		await action("nudge", () =>
			nudgeParticipant(snapshot.room.id, participantToken, {
				participantId: nudge.participant.id,
				message: nudge.message,
				reason: nudge.reason,
			}),
		);
		setNudge(null);
	}

	const timer = useRoomTimer(snapshot.room.endsAt);
	const recapAction = isHost
		? snapshot.room.status === "provisioning" || snapshot.room.status === "cleanup-planning"
			? {
					label:
						snapshot.room.status === "provisioning"
							? "cancel stalled launch"
							: "retry workspace cleanup",
					run: () =>
						action("retry-cleanup", () =>
							roomAction(snapshot.room.id, participantToken, "retry-cleanup"),
						),
				}
			: ["setup", "planning", "building", "integrating", "presenting", "cleanup-ending"].includes(
						snapshot.room.status,
				  )
				? {
						label:
							snapshot.room.status === "cleanup-ending"
								? "retry workspace cleanup"
								: "end room + workspaces",
						run: () => action("end", () => roomAction(snapshot.room.id, participantToken, "end")),
					}
				: undefined
		: undefined;

	if (view === "recap") {
		return (
			<Recap
				snapshot={snapshot}
				roleMap={roleMap}
				onBack={() => setView("workbench")}
				action={recapAction}
				busy={busy}
				error={error}
			/>
		);
	}

	return (
		<div class="app-shell">
			<header class="topbar">
				<Brand compact />
				<div class="room-title">
					<span class={`live-dot live-${snapshot.room.status}`} />
					<div>
						<strong>{snapshot.room.title}</strong>
						<span>
							{snapshot.room.repo} · {snapshot.room.status}
						</span>
					</div>
				</div>
				<RoomProgress status={snapshot.room.status} />
				<div class="topbar-actions">
					<span class={`timer ${timer.urgent ? "urgent" : ""}`}>
						<TimerReset size={15} /> {timer.label}
					</span>
					<button class="icon-button" title="copy invite link" onClick={copyInvite}>
						{copied ? <Check size={17} /> : <Copy size={17} />}
					</button>
					<button class="button ghost recap-button" onClick={() => setView("recap")}>
						<MonitorPlay size={16} />
						recap
					</button>
				</div>
			</header>

			{error && (
				<div class="error-strip">
					<span>{error}</span>
					<button class="icon-button" title="dismiss error" onClick={() => onError("")}>
						<X size={15} />
					</button>
				</div>
			)}

			<main class="workbench">
				<aside class="team-panel">
					<div class="panel-heading">
						<div>
							<span class="eyebrow">team</span>
							<h2>{snapshot.participants.length} seats</h2>
						</div>
						<button class="icon-button" title="copy invite link" onClick={copyInvite}>
							<UserPlus size={17} />
						</button>
					</div>
					<div class="conductor-seat">
						<span class="avatar conductor-avatar">
							<WandSparkles size={17} />
						</span>
						<div>
							<strong>conductor</strong>
							<span>watching dependencies</span>
						</div>
						<span class="presence online" />
					</div>
					<div class="participant-list">
						{snapshot.participants.map((participant, index) => {
							const role = participant.roleId ? roleMap.get(participant.roleId) : undefined;
							const color = role?.color || roleFallbacks[index % roleFallbacks.length];
							return (
								<article class="participant-row" style={{ "--role": color }} key={participant.id}>
									<span class="avatar">{initials(participant.displayName)}</span>
									<div class="participant-copy">
										<div>
											<strong>{participant.displayName}</strong>
											{participant.id === me.id && <span class="you-label">you</span>}
										</div>
										<span>{role?.label || participant.kind}</span>
										{participant.runtimeSummary && <p>{participant.runtimeSummary}</p>}
									</div>
									<span class={`state-mark state-${participant.state}`} title={participant.state} />
									{(participant.browserUrl || (canNudge && participant.kind !== "observer")) && (
										<div class="row-actions">
											{participant.browserUrl && (
												<a
													class="icon-button"
													href={participant.browserUrl}
													target="_blank"
													title="open Codex workspace"
												>
													<ExternalLink size={15} />
												</a>
											)}
											{canNudge && participant.kind !== "observer" && (
												<button
													class="icon-button"
													title={`nudge ${participant.displayName}`}
													onClick={() =>
														setNudge({
															participant,
															message:
																"Share your current contract and flag anything blocking integration.",
															reason: "Keep the integration lane current.",
														})
													}
												>
													<Zap size={15} />
												</button>
											)}
										</div>
									)}
								</article>
							);
						})}
					</div>
					<div class="branch-block">
						<GitBranch size={16} />
						<div>
							<span>integration branch</span>
							<code>{snapshot.room.integrationBranch}</code>
						</div>
					</div>
				</aside>

				<section class="mission-panel">
					<div class="mission-toolbar">
						<div>
							<span class="eyebrow">current mission</span>
							<h1>{ideaTitle(snapshot)}</h1>
						</div>
						{isHost && (
							<HostControls
								snapshot={snapshot}
								busy={busy}
								action={(name) =>
									action(name, () => roomAction(snapshot.room.id, participantToken, name))
								}
								onRecap={() => setView("recap")}
							/>
						)}
					</div>

					<section class="brief-band">
						<div class="brief-promise">
							<span class="brief-index">01</span>
							<div>
								<span class="eyebrow">product promise</span>
								<p>
									{snapshot.room.brief.productGoal ||
										"talk with the team, then shuffle or draft the first plan."}
								</p>
							</div>
						</div>
						<div class="brief-demo">
							<Sparkles size={18} />
							<div>
								<span class="eyebrow">demo moment</span>
								<p>
									{snapshot.room.brief.demoMoment ||
										"the conductor catches a mismatch before integration."}
								</p>
							</div>
						</div>
					</section>

					<section class="lanes-section">
						<div class="section-heading">
							<div>
								<span class="eyebrow">build lanes</span>
								<h2>
									{snapshot.tasks.length
										? `${snapshot.tasks.length} scoped tasks`
										: "waiting for a plan"}
								</h2>
							</div>
							{!readOnly &&
								["building", "integrating", "presenting"].includes(snapshot.room.status) && (
									<button
										class="button ghost"
										disabled={busy === "refresh"}
										onClick={() =>
											action("refresh", () =>
												roomAction(snapshot.room.id, participantToken, "refresh"),
											)
										}
									>
										<RefreshCw size={15} />
										refresh
									</button>
								)}
						</div>
						{snapshot.tasks.length ? (
							<div class="task-board">
								{snapshot.tasks.map((task, index) => (
									<TaskLane
										key={task.id}
										task={task}
										owner={snapshot.participants.find(
											(participant) => participant.id === task.ownerParticipantId,
										)}
										color={
											roleMap.get(
												snapshot.participants.find(
													(participant) => participant.id === task.ownerParticipantId,
												)?.roleId || "",
											)?.color || roleFallbacks[index % roleFallbacks.length]!
										}
										canEdit={
											!readOnly &&
											(isHost || (task.ownerParticipantId === me.id && task.state !== "cut"))
										}
										canCut={isHost}
										onState={(state) => changeTask(task, state)}
									/>
								))}
							</div>
						) : (
							<EmptyPlan isHost={isHost} />
						)}
					</section>

					<section class="activity-section">
						<div class="section-heading">
							<div>
								<span class="eyebrow">conductor log</span>
								<h2>visible orchestration</h2>
							</div>
							<span class="count-badge">
								{snapshot.conductorActions.length + snapshot.decisions.length}
							</span>
						</div>
						<ActivityLog snapshot={snapshot} />
					</section>
				</section>

				<ChatPanel
					key={snapshot.room.id}
					snapshot={snapshot}
					participantId={participantId}
					participantToken={participantToken}
					onRefresh={onRefresh}
					onError={onError}
					readOnly={readOnly}
					messagesOpen={roomAllowsMessages(snapshot.room.status)}
				/>
			</main>

			{nudge && (
				<NudgeDialog
					draft={nudge}
					busy={busy === "nudge"}
					onChange={setNudge}
					onClose={() => setNudge(null)}
					onSend={sendNudge}
				/>
			)}
		</div>
	);
}

function HostControls({
	snapshot,
	busy,
	action,
	onRecap,
}: {
	snapshot: RoomSnapshot;
	busy: string;
	action: (
		action: "shuffle" | "plan" | "approve-plan" | "retry-cleanup" | "present" | "end",
	) => Promise<boolean>;
	onRecap: () => void;
}) {
	const launched = ["building", "integrating"].includes(snapshot.room.status);
	if (snapshot.room.status === "presenting" || snapshot.room.status === "ended") {
		return (
			<button class="button primary" onClick={onRecap}>
				<MonitorPlay size={16} />
				open recap
			</button>
		);
	}
	if (snapshot.room.status === "cleanup-planning" || snapshot.room.status === "cleanup-ending") {
		const cleanupAction = snapshot.room.status === "cleanup-planning" ? "retry-cleanup" : "end";
		return (
			<button class="button danger" disabled={Boolean(busy)} onClick={() => action(cleanupAction)}>
				<CircleStop size={16} />
				retry workspace cleanup
			</button>
		);
	}
	if (snapshot.room.status === "provisioning") {
		return (
			<button
				class="button danger"
				disabled={Boolean(busy)}
				onClick={() => action("retry-cleanup")}
			>
				<CircleStop size={16} />
				cancel stalled launch
			</button>
		);
	}
	if (launched) {
		return (
			<button
				class="button primary"
				disabled={Boolean(busy)}
				onClick={async () => {
					if (await action("present")) onRecap();
				}}
			>
				<MonitorPlay size={16} />
				present
			</button>
		);
	}
	return (
		<div class="host-controls">
			<button class="button ghost" disabled={Boolean(busy)} onClick={() => action("shuffle")}>
				<Shuffle size={15} />
				shuffle
			</button>
			<button class="button ghost" disabled={Boolean(busy)} onClick={() => action("plan")}>
				<Clipboard size={15} />
				draft plan
			</button>
			<button
				class="button primary"
				disabled={Boolean(busy) || !snapshot.tasks.length}
				onClick={() => action("approve-plan")}
			>
				<Rocket size={16} />
				{busy === "approve-plan" ? "launching..." : "launch Codex"}
			</button>
		</div>
	);
}

function TaskLane({
	task,
	owner,
	color,
	canEdit,
	canCut,
	onState,
}: {
	task: Task;
	owner?: Participant;
	color: string;
	canEdit: boolean;
	canCut: boolean;
	onState: (state: TaskState) => void;
}) {
	return (
		<article class="task-lane" style={{ "--role": color }}>
			<div class="task-topline">
				<span class={`task-state task-${task.state}`}>{task.state}</span>
				<span class="task-owner">{owner?.displayName || "unassigned"}</span>
			</div>
			<h3>{task.title}</h3>
			<p>{task.description}</p>
			<div class="path-list">
				{task.ownsPaths.map((path) => (
					<code key={path}>{path}</code>
				))}
			</div>
			<div class="task-footer">
				{task.branch && (
					<span title={task.branch}>
						<GitBranch size={13} />
						{shortBranch(task.branch)}
					</span>
				)}
				{canEdit && (
					<select
						value={task.state}
						aria-label={`state for ${task.title}`}
						onChange={(event) => onState(event.currentTarget.value as TaskState)}
					>
						{taskStates
							.filter((state) => canCut || state !== "cut")
							.map((state) => (
								<option key={state} value={state}>
									{state}
								</option>
							))}
					</select>
				)}
			</div>
		</article>
	);
}

function ChatPanel({
	snapshot,
	participantId,
	participantToken,
	onRefresh,
	onError,
	readOnly,
	messagesOpen,
}: {
	snapshot: RoomSnapshot;
	participantId: string;
	participantToken: string;
	onRefresh: () => Promise<void>;
	onError: (message: string) => void;
	readOnly: boolean;
	messagesOpen: boolean;
}) {
	const [target, setTarget] = useState<Target>({ kind: "room" });
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [olderMessages, setOlderMessages] = useState<RoomMessage[]>([]);
	const timeline = useRef<HTMLDivElement>(null);
	const previousSnapshotMessages = useRef(snapshot.messages);
	const messages = useMemo(() => {
		return mergeRoomMessages([
			...olderMessages,
			...previousSnapshotMessages.current,
			...snapshot.messages,
		]);
	}, [olderMessages, snapshot.messages]);
	const hasEarlierMessages = messages.length < snapshot.messageCount;

	useEffect(() => {
		timeline.current?.scrollTo({ top: timeline.current.scrollHeight, behavior: "smooth" });
	}, [snapshot.room.id, snapshot.messages.at(-1)?.id]);

	useEffect(() => {
		const currentIds = new Set(snapshot.messages.map((message) => message.id));
		const rotatedMessages = previousSnapshotMessages.current.filter(
			(message) => !currentIds.has(message.id),
		);
		if (rotatedMessages.length) {
			setOlderMessages((current) => mergeRoomMessages([...current, ...rotatedMessages]));
		}
		previousSnapshotMessages.current = snapshot.messages;
	}, [snapshot.messages]);

	async function loadEarlierMessages() {
		const earliest = messages[0];
		if (!earliest || loadingHistory) return;
		setLoadingHistory(true);
		onError("");
		const previousHeight = timeline.current?.scrollHeight ?? 0;
		try {
			const page = await readMessagesPage(
				snapshot.room.id,
				{ createdAt: earliest.createdAt, id: earliest.id },
				participantToken,
			);
			setOlderMessages((current) => {
				return mergeRoomMessages([...page.messages, ...current]);
			});
			requestAnimationFrame(() => {
				if (timeline.current) {
					timeline.current.scrollTop += timeline.current.scrollHeight - previousHeight;
				}
			});
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setLoadingHistory(false);
		}
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!text.trim()) return;
		setSending(true);
		onError("");
		try {
			await postMessage(snapshot.room.id, participantToken, {
				body: text,
				targetKind: target.kind,
				targetId: target.id || null,
			});
			setText("");
			try {
				await onRefresh();
			} catch (cause) {
				onError(`message sent; room refresh failed: ${errorMessage(cause)}`);
			}
		} catch (cause) {
			onError(errorMessage(cause));
		} finally {
			setSending(false);
		}
	}

	return (
		<aside class="chat-panel">
			<div class="panel-heading chat-heading">
				<div>
					<span class="eyebrow">room line</span>
					<h2>team + conductor</h2>
				</div>
				<span class="presence online" />
			</div>
			<div class="timeline" ref={timeline}>
				{hasEarlierMessages && (
					<button
						type="button"
						class="history-button"
						disabled={loadingHistory}
						onClick={loadEarlierMessages}
					>
						{loadingHistory ? "loading..." : "load earlier"}
					</button>
				)}
				{messages.map((message) => (
					<Message
						key={message.id}
						message={message}
						participants={snapshot.participants}
						mine={message.authorId === participantId}
					/>
				))}
			</div>
			{readOnly || !messagesOpen ? (
				<div class="composer">
					<div class="composer-footer">
						<span>{readOnly ? "observer mode" : "room line closed"}</span>
					</div>
				</div>
			) : (
				<form class="composer" onSubmit={submit}>
					<div class="target-control">
						<button
							type="button"
							class={target.kind === "room" ? "active" : ""}
							onClick={() => setTarget({ kind: "room" })}
						>
							<Users size={14} /> team
						</button>
						<button
							type="button"
							class={target.kind === "conductor" ? "active" : ""}
							onClick={() => setTarget({ kind: "conductor" })}
						>
							<WandSparkles size={14} /> conductor
						</button>
						<select
							value={target.kind === "participant" ? target.id : ""}
							aria-label="message a teammate"
							onChange={(event) =>
								setTarget(
									event.currentTarget.value
										? { kind: "participant", id: event.currentTarget.value }
										: { kind: "room" },
								)
							}
						>
							<option value="">teammate</option>
							{snapshot.participants
								.filter((participant) => participant.id !== participantId)
								.map((participant) => (
									<option key={participant.id} value={participant.id}>
										{participant.displayName}
									</option>
								))}
						</select>
					</div>
					<textarea
						value={text}
						onInput={(event) => setText(event.currentTarget.value)}
						placeholder={
							target.kind === "conductor" ? "ask the conductor..." : "say it to the room..."
						}
						rows={3}
						maxLength={2000}
					/>
					<div class="composer-footer">
						<span>{targetLabel(target, snapshot.participants)}</span>
						<button
							class="icon-button primary-icon"
							title="send message"
							disabled={sending || !text.trim()}
						>
							<Send size={17} />
						</button>
					</div>
				</form>
			)}
		</aside>
	);
}

function Message({
	message,
	participants,
	mine,
}: {
	message: RoomMessage;
	participants: Participant[];
	mine: boolean;
}) {
	const participant = participants.find((item) => item.id === message.authorId);
	const author =
		message.authorKind === "conductor"
			? "conductor"
			: message.authorKind === "system"
				? "room"
				: message.authorKind === "ai"
					? `${participant?.displayName || "AI participant"} · AI`
					: participant?.displayName || "participant";
	const target =
		message.targetKind === "participant"
			? participants.find((participant) => participant.id === message.targetId)?.displayName
			: message.targetKind;
	return (
		<article class={`message message-${message.authorKind} ${mine ? "message-mine" : ""}`}>
			<div class="message-meta">
				<strong>{author}</strong>
				<span>to {target}</span>
				<time>{formatTime(message.createdAt)}</time>
			</div>
			<p>{message.body}</p>
		</article>
	);
}

function ActivityLog({ snapshot }: { snapshot: RoomSnapshot }) {
	const entries = [
		...snapshot.decisions.map((decision) => ({
			id: decision.id,
			at: decision.createdAt,
			icon: <Check size={15} />,
			label: decision.title,
			detail: decision.reason,
		})),
		...snapshot.conductorActions.map((action) => ({
			id: action.id,
			at: action.createdAt,
			icon: <Zap size={15} />,
			label: action.kind.replaceAll("_", " "),
			detail:
				action.kind === "session_nudge"
					? `${action.reason} / ${action.approvalState.replaceAll("_", " ")}`
					: action.reason,
		})),
	].sort((a, b) => b.at - a.at);
	if (!entries.length) {
		return <p class="quiet-empty">decisions, nudges, and conflict calls will appear here.</p>;
	}
	return (
		<div class="activity-list">
			{entries.map((entry) => (
				<article key={entry.id}>
					<span>{entry.icon}</span>
					<div>
						<strong>{entry.label}</strong>
						<p>{entry.detail}</p>
					</div>
					<time>{formatTime(entry.at)}</time>
				</article>
			))}
		</div>
	);
}

function NudgeDialog({
	draft,
	busy,
	onChange,
	onClose,
	onSend,
}: {
	draft: NudgeDraft;
	busy: boolean;
	onChange: (draft: NudgeDraft) => void;
	onClose: () => void;
	onSend: () => void;
}) {
	return (
		<div class="dialog-backdrop" onClick={onClose}>
			<section
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="nudge-title"
				onClick={(event) => event.stopPropagation()}
			>
				<div class="dialog-heading">
					<div>
						<span class="eyebrow">visible intervention</span>
						<h2 id="nudge-title">nudge {draft.participant.displayName}</h2>
					</div>
					<button class="icon-button" title="close" onClick={onClose}>
						<X size={16} />
					</button>
				</div>
				<label>
					Codex message
					<textarea
						rows={4}
						value={draft.message}
						onInput={(event) => onChange({ ...draft, message: event.currentTarget.value })}
					/>
				</label>
				<label>
					Room-visible reason
					<input
						value={draft.reason}
						onInput={(event) => onChange({ ...draft, reason: event.currentTarget.value })}
					/>
				</label>
				<button
					class="button primary wide"
					disabled={busy || !draft.message.trim() || !draft.reason.trim()}
					onClick={onSend}
				>
					<Zap size={16} />
					{busy ? "sending..." : "send nudge"}
				</button>
			</section>
		</div>
	);
}

function Recap({
	snapshot,
	roleMap,
	onBack,
	backLabel = "workbench",
	action,
	busy,
	error = "",
}: {
	snapshot: RoomSnapshot;
	roleMap: Map<string, Catalog["roles"][number]>;
	onBack: () => void;
	backLabel?: string;
	action?: { label: string; run: () => void };
	busy: string;
	error?: string;
}) {
	const done = snapshot.tasks.filter((task) => task.state === "done").length;
	const interventions = snapshot.decisions.length + snapshot.conductorActions.length;
	const interventionTimeline = [...snapshot.decisions, ...snapshot.conductorActions].sort(
		(left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
	);
	return (
		<main class="recap-shell">
			<header class="recap-header">
				<Brand compact />
				<button class="button ghost" onClick={onBack}>
					<LayoutDashboard size={16} />
					{backLabel}
				</button>
			</header>
			<section class="recap-hero">
				<span class="eyebrow">MultiCodex room recap</span>
				<h1>{snapshot.room.title}</h1>
				<p>{snapshot.room.brief.productGoal || "a coordinated team build."}</p>
				<div class="recap-stats">
					<div>
						<strong>
							{
								snapshot.participants.filter((participant) => participant.kind !== "observer")
									.length
							}
						</strong>
						<span>build lanes</span>
					</div>
					<div>
						<strong>
							{done}/{snapshot.tasks.length}
						</strong>
						<span>tasks done</span>
					</div>
					<div>
						<strong>{interventions}</strong>
						<span>visible calls</span>
					</div>
					<div>
						<strong>{snapshot.messageCount}</strong>
						<span>room events</span>
					</div>
				</div>
			</section>
			<section class="recap-grid">
				<div class="recap-section">
					<span class="eyebrow">the team</span>
					<h2>parallel lanes, one result</h2>
					<div class="recap-team">
						{snapshot.participants
							.filter((participant) => participant.kind !== "observer")
							.map((participant, index) => {
								const role = roleMap.get(participant.roleId || "");
								return (
									<article
										key={participant.id}
										style={{ "--role": role?.color || roleFallbacks[index % roleFallbacks.length] }}
									>
										<span class="avatar">{initials(participant.displayName)}</span>
										<div>
											<strong>{participant.displayName}</strong>
											<span>{role?.label || participant.roleId || "builder"}</span>
											<p>{participant.runtimeSummary || "lane ready for the final recap."}</p>
										</div>
									</article>
								);
							})}
					</div>
				</div>
				<div class="recap-section">
					<span class="eyebrow">demo moment</span>
					<h2>{snapshot.room.brief.demoMoment || "the project converges."}</h2>
					<div class="recap-decisions">
						{interventionTimeline.map((entry) => (
							<article key={entry.id}>
								<span>{"kind" in entry ? <Zap size={15} /> : <Check size={15} />}</span>
								<div>
									<strong>{"kind" in entry ? entry.kind.replaceAll("_", " ") : entry.title}</strong>
									<p>{"reason" in entry ? entry.reason : ""}</p>
								</div>
							</article>
						))}
						{!interventions && <p class="quiet-empty">no conductor interventions recorded yet.</p>}
					</div>
					{error && <InlineError message={error} />}
					{action && (
						<button class="button danger" disabled={Boolean(busy)} onClick={action.run}>
							<CircleStop size={16} />
							{action.label}
						</button>
					)}
				</div>
			</section>
		</main>
	);
}

function RoomProgress({ status }: { status: RoomStatus }) {
	const steps: RoomStatus[] = ["setup", "planning", "building", "presenting"];
	const current =
		status === "provisioning"
			? 2
			: status === "cleanup-planning" || status === "cleanup-ending"
				? 3
				: status === "integrating"
					? 3
					: status === "ended"
						? 4
						: steps.indexOf(status);
	return (
		<div class="room-progress" aria-label={`room status ${status}`}>
			{steps.map((step, index) => (
				<span key={step} class={index <= current ? "complete" : ""}>
					{index < current ? <Check size={11} /> : index + 1}
					<i>{step}</i>
				</span>
			))}
		</div>
	);
}

function mergeRoomMessages(messages: RoomMessage[]): RoomMessage[] {
	const byId = new Map(messages.map((message) => [message.id, message]));
	return [...byId.values()].sort(
		(left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
	);
}

function Brand({ compact = false }: { compact?: boolean }) {
	return (
		<div class={`brand ${compact ? "brand-compact" : ""}`}>
			<span class="brand-mark">
				<Code2 size={compact ? 18 : 23} />
				<Users size={compact ? 13 : 16} />
			</span>
			<strong>MultiCodex</strong>
			{!compact && <span>team build control room</span>}
		</div>
	);
}

function EmptyPlan({ isHost }: { isHost: boolean }) {
	return (
		<div class="empty-plan">
			<div class="empty-diagram">
				<span>
					<Bot size={18} />
				</span>
				<i />
				<span>
					<Users size={18} />
				</span>
				<i />
				<span>
					<Code2 size={18} />
				</span>
			</div>
			<strong>
				{isHost ? "shuffle an idea or draft the team plan" : "the host is shaping the first plan"}
			</strong>
			<p>each active seat receives a role, scoped task, branch, and Codex workspace.</p>
		</div>
	);
}

function LoadingRoom() {
	return (
		<main class="state-shell">
			<Brand />
			<RefreshCw class="spin" size={24} />
			<p>opening room...</p>
		</main>
	);
}

function ErrorRoom({ message }: { message: string }) {
	return (
		<main class="state-shell">
			<Brand />
			<h1>room unavailable</h1>
			<p>{message}</p>
			<a class="button primary" href="/">
				start a room <ArrowRight size={16} />
			</a>
		</main>
	);
}

function InlineError({ message }: { message: string }) {
	return <p class="inline-error">{message}</p>;
}

function useRoomTimer(endsAt: number | null) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	if (!endsAt) return { label: "not started", urgent: false };
	const remaining = Math.max(0, endsAt - now);
	const minutes = Math.floor(remaining / 60_000);
	const seconds = Math.floor((remaining % 60_000) / 1000);
	return {
		label: `${minutes}:${String(seconds).padStart(2, "0")}`,
		urgent: remaining < 5 * 60_000,
	};
}

function roomIdFromPath(): string | null {
	const encoded = location.pathname.match(/^\/rooms\/([^/]+)$/)?.[1];
	if (!encoded) return null;
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null;
	}
}

function builderInviteTokenFromUrl(): string | undefined {
	const token = new URLSearchParams(location.hash.replace(/^#/, "")).get("invite")?.trim();
	return token || undefined;
}

function useBuilderInviteToken(roomId: string | null): [string | undefined, () => void] {
	const [token, setToken] = useState(builderInviteTokenFromUrl);
	const clearToken = useCallback(() => setToken(undefined), []);
	useEffect(() => {
		const synchronizeToken = () => setToken(builderInviteTokenFromUrl());
		synchronizeToken();
		window.addEventListener("hashchange", synchronizeToken);
		return () => window.removeEventListener("hashchange", synchronizeToken);
	}, [roomId]);
	return [token, clearToken];
}

function identityKey(roomId: string): string {
	return `multicodex.identity.${roomId}`;
}

function joinRequestKey(roomId: string): string {
	return `multicodex.join-request.${roomId}`;
}

function loadCreateRequestId(): string {
	return loadSessionRequestId("multicodex.create-request");
}

function clearCreateRequestId(): void {
	clearSessionRequestId("multicodex.create-request");
}

function loadJoinRequestId(roomId: string): string {
	return loadSessionRequestId(joinRequestKey(roomId));
}

function clearJoinRequestId(roomId: string): void {
	clearSessionRequestId(joinRequestKey(roomId));
}

function loadSessionRequestId(key: string): string {
	const requestId = crypto.randomUUID();
	try {
		const existing = sessionStorage.getItem(key);
		if (existing) return existing;
		sessionStorage.setItem(key, requestId);
	} catch {
		// The in-memory value still makes retries idempotent while this view remains mounted.
	}
	return requestId;
}

function clearSessionRequestId(key: string): void {
	try {
		sessionStorage.removeItem(key);
	} catch {
		// Storage may be unavailable in hardened browser contexts.
	}
}

function minimalRoomIdentity(identity: RoomIdentity): RoomIdentity {
	return {
		participantId: identity.participantId,
		participantToken: identity.participantToken,
		...(identity.builderInviteToken ? { builderInviteToken: identity.builderInviteToken } : {}),
	};
}

function persistIdentity(roomId: string, identity: RoomIdentity): boolean {
	const value = JSON.stringify(identity);
	try {
		localStorage.setItem(identityKey(roomId), value);
		return true;
	} catch {
		try {
			sessionStorage.setItem(identityKey(roomId), value);
			return true;
		} catch {
			return false;
		}
	}
}

function loadIdentity(roomId: string): RoomIdentity | null {
	const key = identityKey(roomId);
	try {
		const identity = parseIdentity(localStorage.getItem(key));
		if (identity) return identity;
	} catch {
		// Fall through to tab-scoped storage.
	}
	try {
		return parseIdentity(sessionStorage.getItem(key));
	} catch {
		return null;
	}
}

function clearIdentity(roomId: string): void {
	const key = identityKey(roomId);
	try {
		localStorage.removeItem(key);
	} catch {
		// Storage may be unavailable in hardened browser contexts.
	}
	try {
		sessionStorage.removeItem(key);
	} catch {
		// Storage may be unavailable in hardened browser contexts.
	}
}

function parseIdentity(value: string | null): RoomIdentity | null {
	const identity = JSON.parse(value || "null") as RoomIdentity | null;
	return identity?.participantId && identity.participantToken
		? minimalRoomIdentity(identity)
		: null;
}

function initials(name: string): string {
	return name
		.split(/\s+/)
		.slice(0, 2)
		.map((part) => part[0])
		.join("")
		.toUpperCase();
}

function shortBranch(branch: string): string {
	const parts = branch.split("/");
	return parts.slice(-2).join("/");
}

function ideaTitle(snapshot: RoomSnapshot): string {
	const goal = snapshot.room.brief.productGoal;
	if (!goal) return "shape the build";
	return goal.split(/[.!?]/)[0] || "team build";
}

function targetLabel(target: Target, participants: Participant[]): string {
	if (target.kind === "conductor") return "visible to room · asks conductor";
	if (target.kind === "participant") {
		return `visible to room · mentions ${participants.find((person) => person.id === target.id)?.displayName || "teammate"}`;
	}
	return "visible to everyone";
}

function formatTime(value: number): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : "something went wrong";
}
