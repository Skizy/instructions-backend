import { Elysia, t } from "elysia";

import type { AppConfig } from "../config";
import { setup } from "../setup";
import {
	authenticate,
	deleteResource,
	handleAuthError,
	requestResource,
	requestResourceList,
	type UserData,
} from "../utils";

const Quaternion = () =>
	t.Tuple([t.Number(), t.Number(), t.Number(), t.Number()]);
const Vector3 = () => t.Tuple([t.Number(), t.Number(), t.Number()]);

const Draft = t.Object({
	name: t.String(),
	time: t.Number(),
	toc: t.Number(),
	transformations: t.Array(
		t.Tuple([
			t.String(),
			t.Object({
				rotations: t.Array(t.Tuple([t.String(), Quaternion()])),
				position: t.Union([t.Null(), Vector3()]),
			}),
		]),
	),
});

type DraftResource = {
	name: string;
	uploader: string;
	toc: number;
	time: number;
	deleted: boolean;
};

export const draftHandlers = (config: AppConfig) =>
	new Elysia({
		name: "draftHandlers",
	})
		.use(setup(config.mongourl))
		.get("/drafts/:id", ({ params: { id }, cookie, set, mongo }) => {
			return requestResource({
				collection: "drafts",
				cookie,
				id,
				mongo,
				set,
				userProperty: null,
				resourcePath: `${config.datapath}/drafts`,
			});
		})
		.get("/drafts", async ({ cookie, set, mongo }) => {
			const [userDoc, err] = await authenticate(cookie, mongo);

			if (err) {
				handleAuthError(err, set);
				return;
			}

			const db = mongo.db("setup3d");
			const collection = db.collection<DraftResource>("drafts");

			return collection
				.find({ uploader: userDoc._id.toHexString() })
				.map((doc) => ({
					id: doc._id.toHexString(),
					name: doc.name,
					time: doc.time,
					toc: doc.toc,
				}))
				.toArray();
		})
		.post(
			"/drafts",
			async ({ cookie, body, set, mongo }) => {
				const [userDoc, err] = await authenticate(cookie, mongo);

				if (err) {
					handleAuthError(err, set);
					return;
				}

				const db = mongo.db("setup3d");

				const resourceCollection = db.collection<DraftResource>("drafts");

				const result = await resourceCollection.insertOne({
					name: body.name,
					uploader: userDoc._id.toHexString(),
					toc: body.toc,
					time: body.time,
					deleted: false,
				});

				if (result.insertedId !== null) {
					const id = result.insertedId.toHexString();

					await Bun.write(
						`${config.datapath}/drafts/${id}.json`,
						JSON.stringify(body.transformations),
					);
				} else {
					throw new Error("Didn't get the id of the inserted document");
				}

				set.status = "Created";
			},
			{ body: Draft },
		)
		.delete("/drafts/:id", ({ params: { id }, cookie, mongo, set }) => {
			return deleteResource({
				collection: "drafts",
				cookie,
				id,
				mongo,
				set,
				userProperty: null,
				resourcePath: `${config.datapath}/drafts`,
				trashPath: `${config.datapath}/trash`,
			});
		});
