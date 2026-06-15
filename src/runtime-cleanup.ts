import {
	definitiveCrabfleetReplayConflict,
	parseRootCrabboxRequest,
	participantStateForCrabfleetStatus,
	recoverRoomRootCrabbox,
	roomRootCrabboxRequest,
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
): Promise<Awaited<ReturnType<typeof recoverRoomRootCrabbox>> | null> {
	const persisted = await readRoomRootProvisioningRequest(env.DB, snapshot.room.id);
	// Pre-0014 rooms cannot have the exact request persisted. Reconstruct only for that legacy case.
	const request = persisted
		? parseRootCrabboxRequest(persisted)
		: roomRootCrabboxRequest(env, snapshot.room, snapshot.participants, snapshot.tasks);
	try {
		return await recoverRoomRootCrabbox(
			env,
			snapshot.room,
			snapshot.participants,
			snapshot.tasks,
			request,
		);
	} catch (error) {
		if (definitiveCrabfleetReplayConflict(error)) return null;
		throw error;
	}
}

export async function cleanupFailedLaunchRoom(
	env: Env,
	roomId: string,
	expectedBriefRevision: number,
	rootSessionId: string | null,
): Promise<boolean> {
	if (!rootSessionId) {
		await resetRoomProvisioning(env.DB, roomId, ["provisioning"], expectedBriefRevision);
		return false;
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
		const snapshot = await readRoomSnapshot(env.DB, roomId);
		if (
			snapshot.room.briefRevision === expectedBriefRevision &&
			snapshot.room.crabfleetRootSessionId === rootSessionId &&
			["building", "integrating", "presenting"].includes(snapshot.room.status)
		) {
			return true;
		}
		await stopRoomCrabboxes(env, rootSessionId, []);
		return false;
	}
	await reconcileFailedLaunchCleanup(env, roomId);
	return false;
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
			if (root) {
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
			if (root) {
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
