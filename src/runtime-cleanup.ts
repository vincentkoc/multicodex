import {
	parseRootCrabboxRequest,
	participantStateForCrabfleetStatus,
	recoverRoomRootCrabbox,
	stopRoomCrabboxes,
} from "./crabfleet.ts";
import type { RoomSnapshot, RoomStatus } from "./domain.ts";
import { HttpError } from "./http.ts";
import {
	addMessage,
	beginRoomCleanup,
	claimRoomRuntimeLease,
	claimStaleProvisioningCleanup,
	endRoom,
	markRoomCleanup,
	readRoomRootProvisioningRequest,
	readRoomSnapshot,
	releaseRoomRuntimeLease,
	resetRoomProvisioning,
	roomRootProvisioningAttempted,
} from "./store.ts";

export const provisioningLeaseMilliseconds = 5 * 60 * 1000;
export const cleanupActionLeaseMilliseconds = 2 * 60 * 1000;

export async function recoverPersistedRoomRootCrabbox(
	env: Env,
	snapshot: RoomSnapshot,
): ReturnType<typeof recoverRoomRootCrabbox> {
	const persisted = await readRoomRootProvisioningRequest(env.DB, snapshot.room.id);
	if (!persisted) {
		throw new HttpError(409, "persisted root Crabfleet request is unavailable");
	}
	return recoverRoomRootCrabbox(
		env,
		snapshot.room,
		snapshot.participants,
		snapshot.tasks,
		parseRootCrabboxRequest(persisted),
	);
}

export async function cleanupFailedLaunchRoom(
	env: Env,
	roomId: string,
	expectedBriefRevision: number,
	rootSessionId: string | null,
): Promise<void> {
	if (!rootSessionId) {
		await resetRoomProvisioning(env.DB, roomId, ["provisioning"], expectedBriefRevision);
		return;
	}
	const claimed = await markRoomCleanup(
		env.DB,
		roomId,
		expectedBriefRevision,
		rootSessionId,
		"cleanup-planning",
		["provisioning"],
		[],
	);
	if (!claimed) {
		await stopRoomCrabboxes(env, rootSessionId, []);
		return;
	}
	await reconcileFailedLaunchCleanup(env, roomId);
}

export async function reconcileRuntimeRoom(env: Env, roomId: string): Promise<void> {
	let snapshot = await readRoomSnapshot(env.DB, roomId);
	const now = Date.now();
	const cleanupPending =
		snapshot.room.status === "cleanup-planning" || snapshot.room.status === "cleanup-ending";
	const expired = snapshot.room.endsAt !== null && snapshot.room.endsAt <= now;
	const provisioningStale =
		snapshot.room.status === "provisioning" &&
		snapshot.room.updatedAt <= now - provisioningLeaseMilliseconds;
	if (!cleanupPending && !expired && !provisioningStale) return;
	if (snapshot.room.status === "cleanup-planning" && !expired) {
		await reconcileFailedLaunchCleanup(env, roomId);
		return;
	}
	if (snapshot.room.status === "provisioning") {
		if (
			!(await claimStaleProvisioningCleanup(env.DB, roomId, now - provisioningLeaseMilliseconds))
		) {
			return;
		}
		snapshot = await readRoomSnapshot(env.DB, roomId);
		if (!expired) {
			await reconcileFailedLaunchCleanup(env, roomId);
			return;
		}
	}
	const runtimeMayExist =
		snapshot.room.crabfleetRootSessionId !== null ||
		(await roomRootProvisioningAttempted(env.DB, roomId));
	const expectedStatuses: RoomStatus[] = [
		"building",
		"integrating",
		"presenting",
		"cleanup-planning",
		"cleanup-ending",
	];
	const cleanupLeaseId = await beginRoomCleanup(
		env.DB,
		roomId,
		snapshot.room.crabfleetRootSessionId,
		expectedStatuses,
		cleanupActionLeaseMilliseconds,
	);
	if (!cleanupLeaseId) return;
	try {
		snapshot = await readRoomSnapshot(env.DB, roomId);
		if (!snapshot.room.crabfleetRootSessionId && runtimeMayExist) {
			const root = await recoverPersistedRoomRootCrabbox(env, snapshot);
			if (
				!(await markRoomCleanup(
					env.DB,
					roomId,
					snapshot.room.briefRevision,
					root.binding.session.rootSessionId || root.binding.session.id,
					"cleanup-ending",
					["cleanup-ending"],
					[
						{
							participantId: root.participantId,
							sessionId: root.binding.session.id,
							browserUrl: root.binding.browserUrl,
							summary: root.binding.session.summary,
							state: participantStateForCrabfleetStatus(root.binding.session.status, "joined"),
						},
					],
				))
			) {
				throw new HttpError(409, "room cleanup state changed during root recovery");
			}
			snapshot = await readRoomSnapshot(env.DB, roomId);
		}
		if (snapshot.room.crabfleetRootSessionId) {
			await stopRoomCrabboxes(
				env,
				snapshot.room.crabfleetRootSessionId,
				snapshot.participants.flatMap((item) =>
					item.crabfleetSessionId ? [item.crabfleetSessionId] : [],
				),
			);
		}
		if (await endRoom(env.DB, roomId)) {
			await addMessage(env.DB, roomId, {
				authorKind: "conductor",
				authorId: "conductor",
				targetKind: "room",
				targetId: null,
				body: expired
					? "Sprint expired. Workspaces were stopped and the final state was preserved."
					: "Room cleanup completed. The final state was preserved.",
				replyToId: null,
			});
		}
	} finally {
		await releaseRoomRuntimeLease(env.DB, roomId, cleanupLeaseId);
	}
}

async function reconcileFailedLaunchCleanup(env: Env, roomId: string): Promise<void> {
	const cleanupLeaseId = await claimRoomRuntimeLease(
		env.DB,
		roomId,
		"launch_cleanup",
		["cleanup-planning"],
		cleanupActionLeaseMilliseconds,
	);
	if (!cleanupLeaseId) return;
	try {
		let snapshot = await readRoomSnapshot(env.DB, roomId);
		if (
			!snapshot.room.crabfleetRootSessionId &&
			(await roomRootProvisioningAttempted(env.DB, roomId))
		) {
			const root = await recoverPersistedRoomRootCrabbox(env, snapshot);
			if (
				!(await markRoomCleanup(
					env.DB,
					roomId,
					snapshot.room.briefRevision,
					root.binding.session.rootSessionId || root.binding.session.id,
					"cleanup-planning",
					["cleanup-planning"],
					[
						{
							participantId: root.participantId,
							sessionId: root.binding.session.id,
							browserUrl: root.binding.browserUrl,
							summary: root.binding.session.summary,
							state: participantStateForCrabfleetStatus(root.binding.session.status, "joined"),
						},
					],
				))
			) {
				throw new HttpError(409, "launch cleanup state changed during root recovery");
			}
			snapshot = await readRoomSnapshot(env.DB, roomId);
		}
		if (snapshot.room.crabfleetRootSessionId) {
			await stopRoomCrabboxes(
				env,
				snapshot.room.crabfleetRootSessionId,
				snapshot.participants.flatMap((item) =>
					item.crabfleetSessionId ? [item.crabfleetSessionId] : [],
				),
			);
		}
		if (
			!(await resetRoomProvisioning(
				env.DB,
				roomId,
				["cleanup-planning"],
				snapshot.room.briefRevision,
			))
		) {
			throw new HttpError(409, "launch cleanup state changed before reset");
		}
	} finally {
		await releaseRoomRuntimeLease(env.DB, roomId, cleanupLeaseId);
	}
}
