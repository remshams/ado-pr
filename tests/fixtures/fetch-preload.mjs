import { writeFileSync } from "node:fs";

import { createFetchQueue } from "../support/fetch-harness.mjs";

const responsesEnv = "ADO_PR_TEST_FETCH_RESPONSES";
const callsFileEnv = "ADO_PR_TEST_FETCH_CALLS_FILE";
const envProbeNamesEnv = "ADO_PR_TEST_ENV_PROBE_NAMES";
const envProbeFileEnv = "ADO_PR_TEST_ENV_PROBE_FILE";
const responsesJson = process.env[responsesEnv];
const callsPath = process.env[callsFileEnv];

if (responsesJson === undefined || callsPath === undefined) {
	throw new Error(`Fetch preload requires ${responsesEnv} and ${callsFileEnv}`);
}

const responses = JSON.parse(responsesJson);
const envProbeNames = JSON.parse(process.env[envProbeNamesEnv] ?? "[]");
const envProbePath = process.env[envProbeFileEnv];

if (
	!Array.isArray(envProbeNames) ||
	envProbeNames.some((name) => typeof name !== "string")
) {
	throw new TypeError(
		`${envProbeNamesEnv} must contain a JSON array of strings`,
	);
}
if (envProbeNames.length > 0 && envProbePath === undefined) {
	throw new Error(
		`${envProbeFileEnv} is required when environment names are requested`,
	);
}
if (envProbePath !== undefined) {
	const environment = Object.fromEntries(
		envProbeNames.map((name) => [name, process.env[name] ?? null]),
	);
	writeFileSync(envProbePath, `${JSON.stringify(environment, null, 2)}\n`);
}

function persistCalls(calls) {
	writeFileSync(callsPath, `${JSON.stringify(calls, null, 2)}\n`);
}

const queue = createFetchQueue(responses, {
	onCall(_call, calls) {
		persistCalls(calls);
	},
});

globalThis.fetch = queue.fetch;

process.on("exit", () => {
	persistCalls(queue.calls);
	if (queue.remainingResponses > 0) {
		process.stderr.write(
			`${queue.remainingResponses} queued fetch response(s) were not consumed\n`,
		);
		process.exitCode ||= 1;
	}
});
