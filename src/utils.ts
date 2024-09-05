import type { Cookie } from "elysia";
import type { Long, MongoClient } from "mongodb";

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
};

type AnyError = {
	code: number;
	message: string;
};

async function authenticate(
	// biome-ignore lint/suspicious/noExplicitAny: the function signature of elysia handler
	cookie: Record<string, Cookie<any>>,
	mongo: MongoClient,
) {
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

function handleAuthError(
	err: AnyError,
	set: { status?: undefined | number | string },
) {
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

export { authenticate, camUUIDtoUserId, handleAuthError };
export type { AnyError, CookieDoc, Instruction, UserData };
