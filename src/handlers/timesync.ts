import { Elysia, t } from "elysia";

import type { AppConfig } from "../config";
import { setup } from "../setup";

declare global {
	interface Request {
		t1?: number | undefined;
	}
}

export const timesyncHandlers = (config: AppConfig) =>
	new Elysia({
		name: "timesyncHandlers",
	})
		.use(setup(config.mongourl))
		.onRequest(({ request }) => {
			request.t1 = Date.now();
		})
		.get("/time-sync", ({ request }) => {
			return { t1: request.t1, t2: Date.now() };
		})
		.decorate("camRoundTrips", new Map<string, number>())
		.post(
			"/round-trip",
			({ body, camRoundTrips }) => {
				camRoundTrips.set(body.uuid, body.roundTrip);
			},
			{
				body: t.Object({ uuid: t.String(), roundTrip: t.Number() }),
			},
		);
