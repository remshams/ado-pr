import { writeFileSync } from "node:fs";

const responsesEnv = "ADO_PR_TEST_FETCH_RESPONSES";
const callsFileEnv = "ADO_PR_TEST_FETCH_CALLS_FILE";
const responsesJson = process.env[responsesEnv];
const callsPath = process.env[callsFileEnv];

if (responsesJson === undefined || callsPath === undefined) {
  throw new Error(`Fetch preload requires ${responsesEnv} and ${callsFileEnv}`);
}

const queue = JSON.parse(responsesJson);
const calls = [];

if (!Array.isArray(queue)) {
  throw new TypeError(`${responsesEnv} must contain a JSON array`);
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
  return responseFromDescriptor(queue.shift());
};

process.on("exit", () => {
  persistCalls();
  if (queue.length > 0) {
    process.stderr.write(`${queue.length} queued fetch response(s) were not consumed\n`);
    process.exitCode ||= 1;
  }
});
