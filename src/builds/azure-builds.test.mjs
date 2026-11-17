import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { build, setup, showResponses } from "../../tests/support/builds.mjs";

describe("build response validation contracts", () => {
	test("show identifies malformed optional build metadata", async (t) => {
		for (const [overrides, field, expectedType] of [
			[{ definition: [] }, "build.definition", "an object"],
			[
				{ definition: { id: 0 } },
				"build.definition.id",
				"a positive safe integer",
			],
			[
				{ definition: { name: false } },
				"build.definition.name",
				"a non-empty string",
			],
			[{ _links: [] }, "build._links", "an object"],
			[{ _links: { web: null } }, "build._links.web", "an object"],
			[
				{ _links: { web: { href: 4 } } },
				"build._links.web.href",
				"a non-empty string",
			],
			[{ buildNumber: false }, "build.buildNumber", "a non-empty string"],
		]) {
			const { service } = setup(t, [{ json: build(overrides) }]);
			await assert.rejects(service.show(42, 700), {
				message: `Malformed Azure DevOps response: ${field} must be ${expectedType}.`,
			});
		}
	});

	test("show identifies malformed issue fields before reading logs", async (t) => {
		for (const field of ["type", "category", "message"]) {
			const { service } = setup(t, [
				{ json: build() },
				{
					json: {
						records: [{ id: "task", type: "Task", issues: [{ [field]: 42 }] }],
					},
				},
			]);
			await assert.rejects(service.show(42, 700), {
				message: `Malformed Azure DevOps response: timeline.records[0].issues[0].${field} must be a non-empty string.`,
			});
		}
	});

	test("show validates log metadata and rejects duplicate IDs", async (t) => {
		for (const [logs, detail] of [
			[
				[{ id: 0 }],
				"build logs response.value[0].id must be a positive safe integer.",
			],
			[
				[{ id: 1, type: 7 }],
				"build logs response.value[0].type must be a non-empty string.",
			],
			[
				[{ id: 1, url: false }],
				"build logs response.value[0].url must be a non-empty string.",
			],
			[
				[{ id: 1, lineCount: -1 }],
				"build logs response.value[0].lineCount must be a non-negative safe integer.",
			],
			[
				[{ id: 1, lineCount: 0.5 }],
				"build logs response.value[0].lineCount must be a non-negative safe integer.",
			],
			[
				[{ id: 1, lineCount: "2" }],
				"build logs response.value[0].lineCount must be a non-negative safe integer.",
			],
			[[{ id: 1 }, { id: 1 }], "duplicate build log ID 1."],
		]) {
			const { service } = setup(t, showResponses({ logs }));
			await assert.rejects(service.show(42, 700), {
				message: `Malformed Azure DevOps response: ${detail}`,
			});
		}
	});
});
