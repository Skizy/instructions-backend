import Elysia from "elysia";

import { CameraState, type CameraStreamMessageT } from "custom-types";

import { DBSingleton } from "./mongo";

type ExternalCamera = {
	uuid: string;
	expires: number;
	status: CameraState;
	userAgent: string | null;
	startedAt: number | null;
};

type CameraUpdate = {
	send: (val: CameraStreamMessageT) => void;

	close: () => void;
};

export const setup = (mongoUrl: string) => {
	const mongo = DBSingleton.new(mongoUrl);

	// Reset camera state on server restart
	const db = mongo.client.db("setup3d");
	const cameraCol = db.collection<ExternalCamera>("cameras");
	cameraCol.updateMany(
		{},
		{
			$set: {
				status: CameraState.Uninitialized,
				userAgent: null,
				startedAt: null,
			},
		},
	);

	return new Elysia({ name: "setup" })
		.decorate("mongo", mongo.client)
		.decorate("camStreams", new Map<string, CameraUpdate>())
		.decorate("timeouts", new Map<string, { reset: boolean; timer: Timer }>());
};
