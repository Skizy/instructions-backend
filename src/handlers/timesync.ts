import { Elysia, t } from "elysia";

import type { AppConfig } from "../config";
import { setup } from "../setup";

export const timesyncHandlers = (config: AppConfig) =>
	new Elysia({
		name: "timesyncHandlers",
	})
		.use(setup(config.mongourl))
		.get("/time-sync", () => {
			const t1 = Date.now();

			// Might do some stuff here in the future, idk

			return { t1, t2: Date.now() };
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
