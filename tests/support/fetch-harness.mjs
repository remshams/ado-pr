function queuedResponseFromDescriptor(descriptor, index) {
	if (descriptor instanceof Response) {
		return { response: descriptor, delayMs: 0 };
	}
	if (
		descriptor === null ||
		typeof descriptor !== "object" ||
		Array.isArray(descriptor)
	) {
		throw new TypeError(
			`Queued fetch response ${index + 1} must be a Response or descriptor object`,
		);
	}

	const delayMs = descriptor.delayMs ?? 0;
	if (!Number.isFinite(delayMs) || delayMs < 0) {
		throw new TypeError(
			`Queued fetch response ${index + 1} has an invalid delayMs`,
		);
	}

	const headers = new Headers(descriptor.headers);
	let body = descriptor.body ?? null;
	if (Object.hasOwn(descriptor, "json")) {
		body = JSON.stringify(descriptor.json);
		if (!headers.has("content-type"))
			headers.set("content-type", "application/json");
	}

	return {
		delayMs,
		response: new Response(body, {
			status: descriptor.status ?? 200,
			statusText: descriptor.statusText,
			headers,
		}),
	};
}

async function recordRequest(input, init) {
	const request = new Request(input, init);
	const headers = Object.fromEntries(request.headers);
	if (headers.authorization !== undefined) headers.authorization = "<redacted>";
	let body = null;
	if (request.body !== null) {
		body =
			request.headers.get("content-type") === "application/octet-stream"
				? {
						encoding: "base64",
						data: Buffer.from(await request.clone().arrayBuffer()).toString(
							"base64",
						),
					}
				: await request.clone().text();
	}
	return {
		url: request.url,
		method: request.method,
		headers,
		body,
	};
}

function normalizeFetchResponses(responses) {
	if (!Array.isArray(responses)) {
		throw new TypeError("Queued fetch responses must be an array");
	}
	return responses.map(queuedResponseFromDescriptor);
}

export function validateFetchResponses(responses) {
	normalizeFetchResponses(responses);
}

/**
 * Creates a strict FIFO fetch implementation shared by in-process and subprocess tests.
 * Response descriptors are validated eagerly so both environments reject the same fixtures.
 */
export function createFetchQueue(responses, { onCall } = {}) {
	const queue = normalizeFetchResponses(responses);
	if (onCall !== undefined && typeof onCall !== "function") {
		throw new TypeError("onCall must be a function");
	}

	const calls = [];

	const fetch = async (input, init) => {
		const call = await recordRequest(input, init);
		calls.push(call);
		await onCall?.(call, calls);

		if (queue.length === 0) {
			throw new Error(`Unexpected fetch request: ${call.method} ${call.url}`);
		}

		const { response, delayMs } = queue.shift();
		if (delayMs > 0) {
			const signal = init?.signal;
			await new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				const onAbort = () => {
					clearTimeout(timer);
					reject(signal.reason);
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, delayMs);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		return response;
	};

	return {
		fetch,
		calls,
		get remainingResponses() {
			return queue.length;
		},
	};
}
