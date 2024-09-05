import { MongoClient } from "mongodb";

class DBSingleton {
	client: MongoClient;

	private constructor(url: string) {
		this.client = new MongoClient(url);
	}

	static instances = new Map<string, DBSingleton>();

	static new(url: string) {
		const existing = DBSingleton.instances.get(url);

		if (existing !== undefined) {
			return existing;
		}

		const newInstance = new DBSingleton(url);

		DBSingleton.instances.set(url, newInstance);

		return newInstance;
	}
}

export { DBSingleton };
