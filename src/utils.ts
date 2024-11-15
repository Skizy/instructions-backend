import { $ } from "bun";

import { access, constants as fsConstants } from "node:fs/promises";

import type { Cookie, Context } from "elysia";

import { Long, ObjectId, type MongoClient, type WithId } from "mongodb";

type UserData = {
	email: string;
	name: string;
	avatarLink: string;
	passwordHash: string;
	uploadedInstructions: string[];
	uploadedRigTracks: string[];
	uploadedModels: string[];
	selectedRigModel?: { id: string; name: string };
	cameras?: string[];
};

type Instruction = {
	name: string;
	manufacturer: string;
	date: number | Long;
	fileName: string;
	uploader: string;
	hidden?: boolean;
};

type CookieDoc = {
	email: string;
	cookie: string;
	expires: number;
};

type AnyError = {
	code: number;
	message: string;
};

async function authenticate(
	// biome-ignore lint/suspicious/noExplicitAny: the function signature of elysia handler
	cookie: Record<string, Cookie<any>>,
	mongo: MongoClient,
): Promise<readonly [WithId<UserData>, null] | readonly [null, AnyError]> {
	const sessionId = cookie["session-id"];
	if (!sessionId.value) {
		return [null, { code: 0, message: "Unauthorized" } as AnyError] as const;
	}

	try {
		const db = mongo.db("setup3d");
		const cookiesCol = db.collection<CookieDoc>("cookies");
		const authDoc = await cookiesCol.findOne({
			cookie: sessionId.value,
		});

		if (!authDoc) {
			return [null, { code: 0, message: "Unauthorized" } as AnyError] as const;
		}

		const now = Date.now();

		if (authDoc.expires < now) {
			return [
				null,
				{ code: 3, message: "Cookie expired" } as AnyError,
			] as const;
		}

		const userCol = db.collection<UserData>("authentication");
		const userDoc = await userCol.findOne({ email: authDoc.email });

		if (!userDoc) {
			return [
				null,
				{ code: 1, message: "No doc in user col" } as AnyError,
			] as const;
		}

		return [userDoc, null] as const;
	} catch (e) {
		let message = "";
		if (typeof e === "string") {
			message = e;
		} else if (e instanceof Error) {
			message = e.message;
		}
		return [null, { code: 2, message: e } as AnyError] as const;
	}
}

function handleAuthError(err: AnyError, set: Context["set"]) {
	switch (err.code) {
		case 0: {
			set.status = "Unauthorized";

			break;
		}
		case 1: {
			set.status = "Internal Server Error";

			break;
		}
		case 2: {
			console.error(err.message);

			set.status = "Internal Server Error";

			break;
		}
		case 3: {
			console.warn("Used an expired cookie");

			set.status = "Unauthorized";

			set.headers["Set-Cookie"] = "session-id=; Path=/; Max-Age=0";

			break;
		}
		default: {
			console.warn(`Unknown AnyError code: ${err.code}. Error:`, err);
		}
	}
}

async function camUUIDtoUserId(uuid: string, mongo: MongoClient) {
	const db = mongo.db("setup3d");

	const users = db.collection<UserData>("authentication");

	const userDoc = await users.findOne({ cameras: uuid });

	if (userDoc) {
		return userDoc._id.toHexString();
	}

	return null;
}

type Resource = {
	name: string;
	date: number | Long;
	uploader: string;
	deleted: boolean;
};

async function requestResourceList({
	collection,
	cookie,
	mongo,
	set,
}: {
	collection: string;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	cookie: Record<string, Cookie<any>>;
	mongo: MongoClient;
	set: Context["set"];
}) {
	const [userDoc, err] = await authenticate(cookie, mongo);

	if (err) {
		handleAuthError(err, set);
		return;
	}

	const db = mongo.db("setup3d");

	const resourceCollection = db.collection<Resource>(collection);

	const resourceList = await resourceCollection
		.find({ uploader: userDoc._id.toHexString(), deleted: { $ne: true } })
		.map((doc) => ({ ...doc, _id: undefined, id: doc._id.toHexString() }))
		.toArray();

	return resourceList as Omit<(typeof resourceList)[number], "_id">[];
}

async function requestResourceAll({
	collection,
	cookie,
	mongo,
	resourcePath,
	set,
}: {
	collection: string;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	cookie: Record<string, Cookie<any>>;
	mongo: MongoClient;
	resourcePath: string;
	set: Context["set"];
}) {
	const [userDoc, err] = await authenticate(cookie, mongo);

	if (err) {
		handleAuthError(err, set);
		return;
	}

	const db = mongo.db("setup3d");

	const resourceCollection = db.collection<Resource>(collection);

	const resourceList = await resourceCollection.find({
		uploader: userDoc._id.toHexString(),
		deleted: { $ne: true },
	});
}

async function requestResource({
	collection,
	cookie,
	id,
	mongo,
	resourcePath,
	set,
	userProperty,
}: {
	collection: string;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	cookie: Record<string, Cookie<any>>;
	id: string;
	mongo: MongoClient;
	resourcePath: string;
	set: Context["set"];
	userProperty: "uploadedRigTracks" | "uploadedModels" | null;
}) {
	const [userDoc, err] = await authenticate(cookie, mongo);

	if (err) {
		handleAuthError(err, set);
		return;
	}

	if (userProperty && !userDoc[userProperty].includes(id)) {
		set.status = "Unauthorized";

		return;
	}

	const db = mongo.db("setup3d");
	const resourceCollection = db.collection<Resource>(collection);

	const resource = await resourceCollection.findOne({ _id: new ObjectId(id) });
	if (!resource) {
		set.status = "Not Found";

		return;
	}
	if (resource.uploader !== userDoc._id.toHexString()) {
		set.status = "Unauthorized";

		return;
	}

	const filePath = `${resourcePath}/${id}.json`;

	try {
		await access(filePath);
	} catch (e) {
		console.error(`${filePath} is not accessible`);

		set.status = "Internal Server Error";

		return;
	}

	return Bun.file(filePath);
}

async function createResource({
	collection,
	cookie,
	mongo,
	newResource,
	newResourceName,
	resourcePath,
	set,
	userProperty,
}: {
	collection: string;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	cookie: Record<string, Cookie<any>>;
	mongo: MongoClient;
	newResource: string | File;
	newResourceName: string;
	resourcePath: string;
	set: Context["set"];
	userProperty: "uploadedRigTracks" | "uploadedModels" | null;
}) {
	const [userDoc, err] = await authenticate(cookie, mongo);

	if (err) {
		handleAuthError(err, set);
		return;
	}

	const db = mongo.db("setup3d");
	const userCollection = db.collection<UserData>("authentication");

	const resourceCollection = db.collection<Resource>(collection);

	const date = new Long(BigInt(Date.now()));

	const result = await resourceCollection.insertOne({
		name: newResourceName,
		uploader: userDoc._id.toHexString(),
		date,
		deleted: false,
	});

	if (result.insertedId !== null) {
		const id = result.insertedId.toHexString();

		await Bun.write(`${resourcePath}/${id}.json`, newResource);

		if (userProperty) {
			await userCollection.updateOne(
				{ _id: userDoc._id },
				{ $addToSet: { [userProperty]: id } },
			);
		}
	} else {
		throw new Error("Didn't get the id of the inserted document");
	}

	set.status = "Created";
}

async function deleteResource({
	collection,
	cookie,
	id,
	mongo,
	resourcePath,
	set,
	trashPath,
	userProperty,
}: {
	collection: string;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	cookie: Record<string, Cookie<any>>;
	id: string;
	mongo: MongoClient;
	resourcePath: string;
	set: Context["set"];
	trashPath: string;
	userProperty: "uploadedRigTracks" | "uploadedModels" | null;
}) {
	const [userDoc, err] = await authenticate(cookie, mongo);

	if (err) {
		handleAuthError(err, set);
		return;
	}

	const filePath = `${resourcePath}/${id}.json`;

	try {
		await access(filePath, fsConstants.R_OK);
	} catch (e) {
		console.error(`${filePath} is not accessible`);

		set.status = "Internal Server Error";

		return;
	}

	try {
		await access(trashPath, fsConstants.W_OK | fsConstants.X_OK);
	} catch (e) {
		console.error(`${trashPath} is not accessible`);

		set.status = "Internal Server Error";

		return;
	}

	const db = mongo.db("setup3d");

	const usersCollection = db.collection<UserData>("authentication");
	const resourceCollection = db.collection<Resource>(collection);

	if (userProperty) {
		await usersCollection.updateOne(
			{ _id: userDoc._id },
			{ $pull: { [userProperty]: id } },
		);
	}

	await resourceCollection.updateOne(
		{ _id: ObjectId.createFromHexString(id) },
		{
			$set: { deleted: true },
		},
	);

	await $`mkdir -p ${trashPath}`;
	await $`mv ${filePath} ${trashPath}`;
}

export {
	authenticate,
	camUUIDtoUserId,
	handleAuthError,
	requestResource,
	requestResourceList,
	createResource,
	deleteResource,
};
export type { AnyError, CookieDoc, Instruction, UserData };
