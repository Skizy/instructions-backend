import { type Elysia, type Static, t } from "elysia";
import { TypeCompiler } from "elysia/type-system";

import {
	CameraState,
	type CameraStreamMessageT,
	CameraStreamMessageType,
	ClientMessage,
	ClientMessageType,
	type ServerMessage,
	ServerMessageType,
} from "custom-types";

import type { AppConfig } from "../config";
import { setup } from "../setup";
import {
	type UserData,
	authenticate,
	camUUIDtoUserId,
	handleAuthError,
} from "../utils";
import { timesyncHandlers } from "./timesync";

/** Status:
 *  0 - inactive
 *  1 - active
 *  2 - used */
type ExternalCamera = {
	uuid: string;
	expires: number;
	status: CameraState;
	userAgent: string | null;
	startedAt: number | null;
};

const ClientMessageCompiled = TypeCompiler.Compile(ClientMessage);

type CameraUpdate = {
	send: (val: CameraStreamMessageT) => void;
	close: () => void;
};

export const cameraHandlers = (config: AppConfig) => {
	return (instance: Elysia) => {
		/** @returns `boolean` - sent successfully */
		function sendToSocket(uuid: string, message: Static<typeof ServerMessage>) {
			return (instance.server?.publish(uuid, JSON.stringify(message)) ?? 0) > 0;
		}

		return instance
			.use(setup(config.mongourl))
			.use(timesyncHandlers(config))
			.get(
				"/generate-external-camera-id",
				async ({ set, cookie, mongo, camStreams }) => {
					const [doc, err] = await authenticate(cookie, mongo);
					if (err) {
						handleAuthError(err, set);

						return;
					}

					const uuid = crypto.randomUUID();
					const expires = Date.now() + 24 * 60 * 60 * 1000;

					const db = mongo.db("setup3d");

					const userCol = db.collection<UserData>("authentication");
					const result = await userCol.updateOne(
						{ _id: { $eq: doc._id } },
						{ $addToSet: { cameras: uuid } },
					);

					if (result.modifiedCount !== 1) {
						set.status = "Internal Server Error";

						return;
					}

					const obj = {
						uuid,
						expires,
						status: CameraState.Uninitialized,
						userAgent: null,
						startedAt: null,
					};

					const cameraCol = db.collection<ExternalCamera>("cameras");
					const camResult = await cameraCol.insertOne(obj);

					if (!camResult.acknowledged) {
						await userCol.updateOne(
							{ _id: { $eq: doc._id } },
							{ $pull: { cameras: { uuid } } },
						);

						set.status = "Internal Server Error";

						return;
					}

					const stream = camStreams.get(doc._id.toHexString());
					if (stream) {
						stream.send({ type: CameraStreamMessageType.New, ...obj });
					}

					return uuid;
				},
			)
			.get("/external-cameras", async ({ set, cookie, mongo, camStreams }) => {
				const [doc, err] = await authenticate(cookie, mongo);

				if (err) {
					handleAuthError(err, set);

					return;
				}

				const db = mongo.db("setup3d");

				const userCol = db.collection<UserData>("authentication");

				const col = db.collection<ExternalCamera>("cameras");
				const result = col.find({
					uuid: { $in: doc.cameras },
				});

				const filtered: ExternalCamera[] = [];
				const now = Date.now();
				for await (const cam of result) {
					if (cam.expires < now) {
						console.log("deleting cam with uuid", cam.uuid);

						col.deleteOne({ _id: cam._id });

						const stream = camStreams.get(doc._id.toHexString());
						if (stream) {
							stream.send({
								type: CameraStreamMessageType.Delete,
								uuid: cam.uuid,
							});
						}
					} else {
						filtered.push(cam);
					}
				}

				userCol.updateOne(
					{ _id: doc._id },
					{ $pull: { cameras: { $nin: filtered.map((cam) => cam.uuid) } } },
				);

				return filtered;
			})
			.ws("/cameras-update", {
				async open(ws) {
					const [doc, err] = await authenticate(ws.data.cookie, ws.data.mongo);

					if (err) {
						ws.close();

						return;
					}

					const db = ws.data.mongo.db("setup3d");

					const userCol = db.collection<UserData>("authentication");

					const col = db.collection<ExternalCamera>("cameras");
					const result = col.find({
						uuid: { $in: doc.cameras },
					});

					const filtered: ExternalCamera[] = [];
					const now = Date.now();
					for await (const cam of result) {
						if (cam.expires < now) {
							console.log("deleting cam with uuid", cam.uuid);

							col.deleteOne({ _id: cam._id });
						} else {
							filtered.push(cam);
						}
					}

					userCol.updateOne(
						{ _id: doc._id },
						{ $pull: { cameras: { $nin: filtered.map((cam) => cam.uuid) } } },
					);

					const send = (val: CameraStreamMessageT) =>
						ws.send(JSON.stringify(val));
					const close = () => ws.close();

					send({ type: CameraStreamMessageType.Open, cameras: filtered });
					send({ type: CameraStreamMessageType.Ping });

					setInterval(() => {
						send({ type: CameraStreamMessageType.Ping });
					}, 2000);
					const cameraStream: CameraUpdate = {
						send,
						close,
					};

					ws.data.camStreams.set(doc._id.toHexString(), cameraStream);

					console.log(`Creating an update socket of ${doc.email}`);
				},
				async close(ws) {
					const [doc, err] = await authenticate(ws.data.cookie, ws.data.mongo);

					if (err) {
						return;
					}

					ws.data.camStreams.delete(doc._id.toHexString());

					console.log(`Closed the update socket of ${doc.email}`);
				},
			})
			.post(
				"/start-cameras",
				async ({ set, cookie, mongo, body, camRoundTrips }) => {
					const [doc, err] = await authenticate(cookie, mongo);

					if (err) {
						handleAuthError(err, set);

						return;
					}

					const ids = body.ids;

					if (ids.some((cam) => !(doc.cameras?.includes(cam) ?? false))) {
						set.status = "Unauthorized";

						return;
					}

					const db = mongo.db("setup3d");
					const col = db.collection<ExternalCamera>("cameras");
					const toEnable = await col.find({ uuid: { $in: ids } }).toArray();

					if (toEnable.some((x) => x.status !== 1)) {
						set.status = "Bad Request";

						return;
					}

					let longestRT = 0;

					for (const id of ids.concat("main")) {
						const rt = camRoundTrips.get(id);

						if (rt === undefined) {
							if (id === "main") continue;

							set.status = "Internal Server Error";

							return "Not all external cameras are synced";
						}

						if (rt > longestRT) {
							longestRT = rt;
						}
					}

					const startAt = Date.now() + longestRT * 2 + 300;

					for (let i = 0; i < ids.length; i += 1) {
						const result = sendToSocket(ids[i], {
							type: ServerMessageType.Start,
							fps: body.fps,
							at: startAt,
						});

						if (!result) {
							for (let j = 0; j < i; j += 1) {
								sendToSocket(ids[j], {
									type: ServerMessageType.Stop,
									sendVideo: false,
								});
							}

							set.status = "Internal Server Error";

							return;
						}
					}

					col.updateMany({ uuid: { $in: ids } }, { $set: { status: 2 } });

					return { startAt };
				},
				{
					body: t.Object({ ids: t.Array(t.String()), fps: t.Number() }),
				},
			)
			.post("/stop-cameras", async ({ set, cookie, mongo }) => {
				const [doc, err] = await authenticate(cookie, mongo);

				if (err) {
					handleAuthError(err, set);

					return;
				}

				const db = mongo.db("setup3d");
				const col = db.collection<ExternalCamera>("cameras");

				const active = await col
					.find({ $and: [{ uuid: { $in: doc.cameras } }, { status: 2 }] })
					.toArray();

				for (const cam of active) {
					sendToSocket(cam.uuid, {
						type: ServerMessageType.Stop,
						sendVideo: true,
					});
				}

				await col.updateMany(
					{ uuid: { $in: active.map((x) => x.uuid) } },
					{ $set: { status: 1 } },
				);
			})
			.ws("/camera-socket/:uuid", {
				query: t.Object({
					userAgent: t.String(),
				}),
				async open(ws) {
					const uuid = ws.data.params.uuid;
					const userAgent = ws.data.query.userAgent;

					const db = ws.data.mongo.db("setup3d");
					const col = db.collection<ExternalCamera>("cameras");
					const doc = await col.findOne({ uuid });

					if (doc === null || doc.status !== CameraState.Uninitialized) {
						const error = doc === null ? "NotFound" : "InUse";

						ws.close(4000, error);

						return;
					}

					await col.updateOne(
						{ _id: doc._id },
						{
							$set: {
								status: CameraState.Waiting,
								userAgent,
							},
						},
					);

					const authCol = db.collection<UserData>("authentication");
					const result = await authCol.findOne({
						cameras: doc.uuid,
					});
					if (result) {
						const stream = ws.data.camStreams.get(result._id.toHexString());
						if (stream) {
							stream.send({
								type: CameraStreamMessageType.StateUpdate,
								uuid: doc.uuid,
								state: CameraState.Waiting,
								userAgent,
							});
						}
					}

					ws.subscribe(uuid);

					const timeout = ws.data.timeouts.get(ws.id);
					if (timeout) {
						clearInterval(timeout.timer);
					}

					const timer = setInterval(async () => {
						const timeout = ws.data.timeouts.get(ws.id);
						if (!timeout) {
							console.warn("Didn't find the interval in 'timeouts'");

							ws.close();
							clearInterval(timer);
							return;
						}

						console.log("Interval for", uuid);

						if (timeout.reset) {
							timeout.reset = false;
						} else {
							console.log(`Lost connection to camera with id ${uuid}`);
							ws.data.timeouts.delete(ws.id);

							ws.data.camRoundTrips.delete(uuid);

							const db = ws.data.mongo.db("setup3d");
							const col = db.collection<ExternalCamera>("cameras");
							col.updateOne(
								{ uuid },
								{
									$set: {
										status: CameraState.Uninitialized,
										userAgent: null,
										startedAt: null,
									},
								},
							);

							const authCol = db.collection<UserData>("authentication");
							const result = await authCol.findOne({
								cameras: uuid,
							});
							if (result) {
								const stream = ws.data.camStreams.get(result._id.toHexString());
								if (stream) {
									stream.send({
										type: CameraStreamMessageType.StateUpdate,
										uuid,
										state: CameraState.Uninitialized,
									});
								}
							}

							ws.close();
							clearInterval(timeout.timer);
						}
					}, 10000);
					ws.data.timeouts.set(ws.id, {
						reset: false,
						timer,
					});
				},
				async message(ws, message) {
					if (message instanceof Buffer) {
						console.log("Received a Buffer in the websocket:", message);

						return;
					}

					if (!ClientMessageCompiled.Check(message)) {
						return;
					}

					const uuid = ws.data.params.uuid;

					switch (message.type) {
						case ClientMessageType.StateUpdate: {
							const db = ws.data.mongo.db("setup3d");
							const col = db.collection<ExternalCamera>("cameras");

							col.updateOne({ uuid }, { $set: { status: message.state } });

							// Get the owner document id
							const authCol = db.collection<UserData>("authentication");
							const result = await authCol.findOne({
								cameras: uuid,
							});
							if (result) {
								const stream = ws.data.camStreams.get(result._id.toHexString());
								if (stream) {
									console.log("Sending state update for uuid", uuid);

									stream.send({
										type: CameraStreamMessageType.StateUpdate,
										uuid,
										state: message.state,
									});
								}
							}

							break;
						}
						case ClientMessageType.Free: {
							console.log("Free message:", message.message);
							break;
						}
						case ClientMessageType.ToggleResponse: {
							console.log("Camera toggle recording succeded:", message.success);
							if (!message.success) {
								console.log(message.error);
							}
							break;
						}
						case ClientMessageType.Ping: {
							const timeout = ws.data.timeouts.get(ws.id);
							if (timeout) {
								timeout.reset = true;
							}

							ws.send(
								JSON.stringify({
									type: ServerMessageType.Pong,
								} satisfies Static<typeof ServerMessage>),
							);
							break;
						}
						case ClientMessageType.PoseData: {
							const db = ws.data.mongo.db("setup3d");
							const col = db.collection<ExternalCamera>("cameras");

							const startedAt =
								(await col.findOne({ uuid }))?.startedAt ?? null;

							if (startedAt === null) {
								console.error("Didn't find the start time for this camera");
								return;
							}

							const data = message.data;

							console.log("Received Pose data");

							const userId = await camUUIDtoUserId(uuid, ws.data.mongo);
							if (!userId) {
								break;
							}

							const stream = ws.data.camStreams.get(userId);
							if (!stream) {
								break;
							}

							stream.send({
								type: CameraStreamMessageType.ExternalPoseData,
								uuid,
								data,
								startedAt,
							});

							break;
						}
						case ClientMessageType.StartedAt: {
							const db = ws.data.mongo.db("setup3d");
							const col = db.collection<ExternalCamera>("cameras");

							col.updateOne({ uuid }, { $set: { startedAt: message.at } });
							break;
						}
						case ClientMessageType.EstimationData: {
							console.log("Received Estimation data from camera", uuid);

							const userId = await camUUIDtoUserId(uuid, ws.data.mongo);
							if (!userId) {
								break;
							}

							const stream = ws.data.camStreams.get(userId);
							if (!stream) {
								break;
							}

							stream.send({
								type: CameraStreamMessageType.StreamedPoseData,
								uuid,
								data: message.data,
							});

							break;
						}
						default: {
							throw new Error(
								`Unknown message type of message: ${JSON.stringify(message satisfies never)}`,
							);
						}
					}
				},
				async close(ws, _code, _message) {
					const uuid = ws.data.params.uuid;

					ws.data.camRoundTrips.delete(uuid);

					const db = ws.data.mongo.db("setup3d");
					const col = db.collection<ExternalCamera>("cameras");
					col.updateOne(
						{ uuid },
						{
							$set: {
								status: CameraState.Uninitialized,
								userAgent: null,
								startedAt: null,
							},
						},
					);

					const authCol = db.collection<UserData>("authentication");
					const result = await authCol.findOne({
						cameras: uuid,
					});
					if (result) {
						const stream = ws.data.camStreams.get(result._id.toHexString());
						if (stream) {
							stream.send({
								type: CameraStreamMessageType.StateUpdate,
								uuid,
								state: CameraState.Uninitialized,
							});
						}
					}

					console.log("Closed socket of camera with uuid", uuid);

					const timeout = ws.data.timeouts.get(ws.id);
					if (timeout) {
						clearInterval(timeout.timer);

						ws.data.timeouts.delete(ws.id);
					}
				},
			});
	};
};
