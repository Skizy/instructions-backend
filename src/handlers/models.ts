import { Elysia, t } from "elysia";
import { Long, ObjectId } from "mongodb";

import type { AppConfig } from "../config";
import { setup } from "../setup";
import type { CookieDoc, UserData } from "../utils";

type RigTrack = {
	name: string;
	date: number | Long;
	uploader: string;
};

// type Model = {
// 	name: string;
// 	date: number | Long;
// 	uploader: string;
// };

export const modelsHandlers = (config: AppConfig) =>
	new Elysia({
		name: "modelsHandlers",
	})
		.use(setup(config.mongourl))
		.post(
			"/uploadRigData",
			async ({ body, set, cookie, mongo }) => {
				const sessionId = cookie["session-id"];
				if (!sessionId.value) {
					set.status = "Unauthorized";
					return;
				}
				console.dir(body);

				try {
					const db = mongo.db("setup3d");
					const cookiesCol = db.collection<CookieDoc>("cookies");
					const authDoc = await cookiesCol.findOne({
						cookie: sessionId.value,
					});

					if (!authDoc) {
						set.status = "Unauthorized";
						return;
					}

					const userCol = db.collection<UserData>("authentication");
					const userDoc = await userCol.findOne({ email: authDoc.email });

					if (!userDoc) {
						set.status = "Internal Server Error";
						return;
					}

					const col = db.collection<RigTrack>("rigdata");

					const date = new Long(BigInt(Date.now()));

					const result = await col.insertOne({
						name: body.name,
						uploader: userDoc._id.toHexString(),
						date,
					});

					if (result.insertedId !== null) {
						console.log("Writing the file");
						const id = result.insertedId.toHexString();

						await Bun.write(`${config.datapath}/rigData/${id}.json`, body.file);

						await userCol.updateOne(
							{ _id: userDoc._id },
							{ $addToSet: { uploadedRigDataList: id } },
						);
					} else {
						throw new Error("Didn't get the id of the inserted document");
					}
				} catch (e) {
					console.error(e);
					set.status = "Internal Server Error";
					return;
				}

				set.status = "Created";
				return;
			},
			{ body: t.Object({ name: t.String(), file: t.File() }) },
		)
		.get("/rigData", async ({ set, cookie, mongo }) => {
			const sessionId = cookie["session-id"];
			if (!sessionId.value) {
				set.status = "Unauthorized";
				return;
			}

			console.log("Responding with rigData");

			try {
				const db = mongo.db("setup3d");
				const cookiesCol = db.collection<CookieDoc>("cookies");
				const authDoc = await cookiesCol.findOne({
					cookie: sessionId.value,
				});

				if (!authDoc) {
					set.status = "Unauthorized";
					return;
				}

				const userCol = db.collection<UserData>("authentication");
				const userDoc = await userCol.findOne({ email: authDoc.email });

				if (!userDoc) {
					set.status = "Internal Server Error";
					return;
				}

				const col = db.collection<RigTrack>("rigdata");

				const results = await col
					.find({ uploader: userDoc._id.toHexString() })
					.map((doc) => ({
						id: doc._id.toHexString(),
						name: doc.name,
						date: doc.date,
					}))
					.toArray();

				return results;
			} catch (e) {
				console.error(e);
				set.status = "Internal Server Error";
				return;
			}
		})
		.get("/rigData/:id", async ({ params: { id }, set, mongo }) => {
			try {
				const db = mongo.db("setup3d");
				const col = db.collection<RigTrack>("rigdata");

				const result = await col.findOne({ _id: new ObjectId(id) });

				if (!result) {
					set.status = "Bad Request";
					return;
				}

				return Bun.file(`${config.datapath}/rigData/${id}.json`);
			} catch (e) {
				console.error(e);
				set.status = "Internal Server Error";
				return;
			}
		});
