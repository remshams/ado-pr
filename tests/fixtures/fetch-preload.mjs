import { writeFileSync } from "node:fs";

const responsesEnv = "ADO_PR_TEST_FETCH_RESPONSES";
const callsFileEnv = "ADO_PR_TEST_FETCH_CALLS_FILE";
const envProbeNamesEnv = "ADO_PR_TEST_ENV_PROBE_NAMES";
const envProbeFileEnv = "ADO_PR_TEST_ENV_PROBE_FILE";
const responsesJson = process.env[responsesEnv];
const callsPath = process.env[callsFileEnv];

if (responsesJson === undefined || callsPath === undefined) {
  throw new Error(`Fetch preload requires ${responsesEnv} and ${callsFileEnv}`);
}

const queue = JSON.parse(responsesJson);
const envProbeNames = JSON.parse(process.env[envProbeNamesEnv] ?? "[]");
const envProbePath = process.env[envProbeFileEnv];
const calls = [];

if (!Array.isArray(queue)) {
  throw new TypeError(`${responsesEnv} must contain a JSON array`);
}
if (!Array.isArray(envProbeNames) || envProbeNames.some((name) => typeof name !== "string")) {
  throw new TypeError(`${envProbeNamesEnv} must contain a JSON array of strings`);
}
if (envProbeNames.length > 0 && envProbePath === undefined) {
  throw new Error(`${envProbeFileEnv} is required when environment names are requested`);
}
if (envProbePath !== undefined) {
  const environment = Object.fromEntries(
    envProbeNames.map((name) => [name, process.env[name] ?? null]),
  );
  writeFileSync(envProbePath, `${JSON.stringify(environment, null, 2)}\n`);
}

function persistCalls() {
  writeFileSync(callsPath, `${JSON.stringify(calls, null, 2)}\n`);
}

function responseFromDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new TypeError("Queued fetch responses must be descriptor objects");
  }

  const headers = new Headers(descriptor.headers);
  let body = descriptor.body ?? null;
  if (Object.hasOwn(descriptor, "json")) {
    body = JSON.stringify(descriptor.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  return new Response(body, {
    status: descriptor.status ?? 200,
    statusText: descriptor.statusText,
    headers,
  });
}

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const call = {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body: request.body === null ? null : await request.clone().text(),
  };
  calls.push(call);
  persistCalls();

  if (queue.length === 0) {
    throw new Error(`Unexpected fetch request: ${call.method} ${call.url}`);
  }
  const descriptor = queue.shift();
  if (descriptor?.delayMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, descriptor.delayMs));
  }
  return responseFromDescriptor(descriptor);
};

process.on("exit", () => {
  persistCalls();
  if (queue.length > 0) {
    process.stderr.write(`${queue.length} queued fetch response(s) were not consumed\n`);
    process.exitCode ||= 1;
  }
});
