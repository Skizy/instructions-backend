type AppConfig = { port: number; mongourl: string; datapath: string };

async function loadConfig(): Promise<AppConfig> {
	let config = {
		port: 3005,
		mongourl: "mongodb://localhost:27017",
		datapath: `${import.meta.dir}/../../data`,
	};

	let envConfigPath = Bun.env.CONFIG_PATH;

	if (envConfigPath === undefined) {
		envConfigPath = `${import.meta.dir}/../../config/server.json`;
	}

	if (URL.canParse(envConfigPath)) {
		const resp = await fetch(envConfigPath);

		try {
			config = {
				...config,
				...(await resp.json()),
			};
		} catch (e) {
			console.error(`Couldn't parse response as json: ${e}`);
			console.log("Using default config");
		}

		return config;
	}

	try {
		config = {
			...config,
			...(await Bun.file(envConfigPath).json()),
		};
	} catch (e) {
		console.error(`Couldn't read config file: ${e}`);
		console.log("Using default config");
	}

	return config;
}

export { loadConfig };
export type { AppConfig };
