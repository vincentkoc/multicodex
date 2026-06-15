import { DurableObject } from "cloudflare:workers";

import { applyEventAccessAttempt, type EventAdmissionState } from "./access.ts";

export class EventAdmission extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS event_admission (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					window_started_at INTEGER NOT NULL,
					failed_attempts INTEGER NOT NULL,
					blocked_until INTEGER NOT NULL
				)
			`);
		});
	}

	async authorize(valid: boolean): Promise<boolean> {
		const row = this.ctx.storage.sql
			.exec<{
				window_started_at: number;
				failed_attempts: number;
				blocked_until: number;
			}>(
				"SELECT window_started_at, failed_attempts, blocked_until FROM event_admission WHERE id = 1",
			)
			.toArray()[0];
		const previous: EventAdmissionState | null = row
			? {
					windowStartedAt: row.window_started_at,
					failedAttempts: row.failed_attempts,
					blockedUntil: row.blocked_until,
				}
			: null;
		const result = applyEventAccessAttempt(previous, valid, Date.now());
		if (!result.state) {
			this.ctx.storage.sql.exec("DELETE FROM event_admission WHERE id = 1");
			return result.authorized;
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO event_admission (id, window_started_at, failed_attempts, blocked_until)
			 VALUES (1, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			 	window_started_at = excluded.window_started_at,
			 	failed_attempts = excluded.failed_attempts,
			 	blocked_until = excluded.blocked_until`,
			result.state.windowStartedAt,
			result.state.failedAttempts,
			result.state.blockedUntil,
		);
		return result.authorized;
	}
}
