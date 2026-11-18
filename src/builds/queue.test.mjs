import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	build,
	buildBase,
	pullRequest,
	requestShapes,
	setup,
} from "../../tests/support/builds.mjs";

describe("policy evaluations", () => {
	const prWithProject = pullRequest({
		repository: {
			id: "Repo-ID",
			name: "widgets",
			project: { id: "project-id" },
		},
	});

	test("maps each evaluation to its policy name, blocking flag, satisfied flag and status", async (t) => {
		const evaluation = (status, isBlocking, displayName) => ({
			status,
			configuration: { isBlocking, type: { displayName } },
		});
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							evaluation("rejected", true, "Minimum number of reviewers"),
							evaluation("queued", false, "Comment requirements"),
							evaluation("approved", true, "Build"),
							evaluation("NotApplicable", true, "Skipped"),
							{ configuration: {} },
							{},
							{
								status: "",
								configuration: { isBlocking: "yes", type: { displayName: "" } },
							},
						],
					},
				},
			],
			{ resolveValues: [] },
		);

		const unknown = {
			name: "unknown policy",
			blocking: false,
			satisfied: false,
			status: "unknown",
		};
		assert.deepEqual(await service.policyEvaluations(prWithProject), [
			{
				name: "Minimum number of reviewers",
				blocking: true,
				satisfied: false,
				status: "rejected",
			},
			{
				name: "Comment requirements",
				blocking: false,
				satisfied: false,
				status: "queued",
			},
			{ name: "Build", blocking: true, satisfied: true, status: "approved" },
			{
				name: "Skipped",
				blocking: true,
				satisfied: true,
				status: "NotApplicable",
			},
			unknown,
			unknown,
			unknown,
		]);
		assert.equal(
			calls[0].url,
			"https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproject-id%2F42&api-version=7.1-preview.1",
		);
	});

	test("reports a missing project ID and malformed responses", async (t) => {
		const noProject = setup(t, []);
		await assert.rejects(noProject.service.policyEvaluations(pullRequest()), {
			message:
				"Cannot read policy evaluations for PR #42: Azure DevOps did not return its project ID.",
		});
		assert.deepEqual(noProject.calls, []);

		const malformed = setup(t, [{ json: {} }]);
		await assert.rejects(
			malformed.service.policyEvaluations(prWithProject),
			/policy evaluations response\.value must be an array/,
		);

		const notObject = setup(t, [{ json: { value: [{}, 7] } }]);
		await assert.rejects(
			notObject.service.policyEvaluations(prWithProject),
			/policy evaluation 2 must be an object/,
		);

		const invalidPr = setup(t, []);
		await assert.rejects(
			invalidPr.service.policyEvaluations({ ...prWithProject, title: "" }),
			/pull request\.title must be a non-empty string/,
		);
	});
});

describe("build queueing", () => {
	const projectId = "project-id";
	const buildPolicyType = "0609b952-1397-4640-95ec-e00a01b2c241";

	test("returns the evaluation when Azure has not returned a build ID", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
			lastMergeSourceCommit: { commitId: "head123" },
		});
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							{
								evaluationId: "evaluation-id",
								configuration: {
									name: "Widget CI",
									type: { id: buildPolicyType },
								},
							},
						],
					},
				},
				{ json: { status: "queued" } },
			],
			{ resolveValues: [pr] },
		);

		const result = await service.queuePr(42);

		assert.deepEqual(result, { evaluationId: "evaluation-id" });
		assert.deepEqual(
			requestShapes(calls).map(({ url, method, body }) => ({
				url,
				method,
				body,
			})),
			[
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproject-id%2F42&api-version=7.1-preview.1",
					method: "GET",
					body: null,
				},
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations/evaluation-id?api-version=7.1-preview.1",
					method: "PATCH",
					body: JSON.stringify({ status: "queued" }),
				},
			],
		);
	});

	test("reports a missing build policy evaluation", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		const { service } = setup(t, [{ json: { value: [] } }], {
			resolveValues: [pr],
		});
		await assert.rejects(
			service.queuePr(42),
			/No build policy evaluation.*PR #42/,
		);
	});

	test("rejects an invalid PR ID before resolving the pull request", async (t) => {
		const { service, calls, pullRequestCalls } = setup(t, []);

		await assert.rejects(service.queuePr(0), {
			message: "Pull request ID must be a positive safe integer.",
		});
		assert.deepEqual(pullRequestCalls, []);
		assert.deepEqual(calls, []);
	});

	test("reports a missing project ID before looking up policy evaluations", async (t) => {
		for (const project of [undefined, {}]) {
			const pr = pullRequest({
				repository: { id: "Repo-ID", name: "widgets", project },
			});
			const { service, calls } = setup(t, [], { resolveValues: [pr] });

			await assert.rejects(service.queuePr(42), {
				message:
					"Cannot queue a build for PR #42: Azure DevOps did not return its project ID.",
			});
			assert.deepEqual(calls, []);
		}
	});

	test("reports malformed evaluation responses with their field names", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		for (const [response, error] of [
			[{ json: [] }, /policy evaluations response must be an object/],
			[{ json: {} }, /policy evaluations response\.value must be an array/],
		]) {
			const { service, calls } = setup(t, [response], { resolveValues: [pr] });
			await assert.rejects(service.queuePr(42), error);
			assert.match(calls[0].url, /_apis\/policy\/evaluations\?/);
		}
	});

	test("fetches the build ID from the requeued evaluation context", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		const returned = build({ id: 703 });
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							{
								evaluationId: "evaluation-id",
								configuration: { type: { id: buildPolicyType } },
							},
						],
					},
				},
				{
					json: {
						evaluationId: "evaluation-id",
						status: "queued",
						context: { buildId: 703 },
					},
				},
				{ json: returned },
			],
			{ resolveValues: [pr] },
		);

		const result = await service.queuePr(42);

		assert.equal(result.build.id, 703);
		assert.deepEqual(
			requestShapes(calls).map(({ url, method, body }) => ({
				url,
				method,
				body,
			})),
			[
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations?artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproject-id%2F42&api-version=7.1-preview.1",
					method: "GET",
					body: null,
				},
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/evaluations/evaluation-id?api-version=7.1-preview.1",
					method: "PATCH",
					body: JSON.stringify({ status: "queued" }),
				},
				{
					url: `${buildBase}/703?api-version=7.1`,
					method: "GET",
					body: null,
				},
			],
		);
	});

	for (const [name, requeueResponse] of [
		["context.buildId is null", { context: { buildId: null } }],
		["context.buildId is missing", { context: {} }],
		["context is null", { context: null }],
		["context is missing", {}],
	]) {
		test(`returns the evaluation ID when the requeue response says ${name}`, async (t) => {
			const pr = pullRequest({
				repository: {
					id: "Repo-ID",
					name: "widgets",
					project: { id: projectId },
				},
			});
			const { service, calls } = setup(
				t,
				[
					{
						json: {
							value: [
								{
									evaluationId: "evaluation-id",
									configuration: { type: { id: buildPolicyType } },
								},
							],
						},
					},
					{
						json: {
							evaluationId: "evaluation-id",
							status: "queued",
							...requeueResponse,
						},
					},
				],
				{ resolveValues: [pr] },
			);

			assert.deepEqual(await service.queuePr(42), {
				evaluationId: "evaluation-id",
			});
			assert.equal(calls.length, 2);
		});
	}

	for (const [name, requeueResponse, reason] of [
		[
			"a build ID of 0",
			{ context: { buildId: 0 } },
			/requeued policy evaluation context\.buildId must be a positive safe integer/,
		],
		[
			"a string build ID",
			{ context: { buildId: "703" } },
			/requeued policy evaluation context\.buildId must be a positive safe integer/,
		],
		["a non-object body", ["queued"], /requeued policy evaluation response/],
		[
			"a non-object context",
			{ context: "queued" },
			/requeued policy evaluation context must be an object/,
		],
	]) {
		test(`says the requeue was accepted when the response has ${name}`, async (t) => {
			const pr = pullRequest({
				repository: {
					id: "Repo-ID",
					name: "widgets",
					project: { id: projectId },
				},
			});
			const { service, calls } = setup(
				t,
				[
					{
						json: {
							value: [
								{
									evaluationId: "evaluation-id",
									configuration: { type: { id: buildPolicyType } },
								},
							],
						},
					},
					{ json: requeueResponse },
				],
				{ resolveValues: [pr] },
			);

			await assert.rejects(service.queuePr(42), (error) => {
				assert.match(
					error.message,
					/Requeue request for build policy evaluation evaluation-id on PR #42 was accepted, but Azure DevOps sent an invalid build ID or response/,
				);
				assert.match(error.message, /pr\.sh build list --pr 42 --history/);
				assert.match(error.message, reason);
				assert.doesNotMatch(error.message, /failed after dispatch|uncertain/);
				return true;
			});
			assert.equal(calls.length, 2);
		});
	}

	test("gives uncertain-outcome guidance when the evaluation requeue fails after dispatch", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							{
								evaluationId: "evaluation-id",
								configuration: { type: { id: buildPolicyType } },
							},
						],
					},
				},
				{ status: 503, statusText: "Service Unavailable", body: "try later" },
			],
			{ resolveValues: [pr] },
		);

		await assert.rejects(service.queuePr(42), (error) => {
			assert.match(
				error.message,
				/Requeue request for build policy evaluation evaluation-id on PR #42 failed after dispatch/,
			);
			assert.match(error.message, /do not retry automatically/);
			assert.match(error.message, /pr\.sh build show --latest --pr 42/);
			assert.match(error.message, /503 Service Unavailable/);
			return true;
		});
		assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
	});

	test("keeps the uncertain-outcome guidance for an empty or non-JSON 2xx requeue body", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		for (const body of ["", "<html>proxy</html>"]) {
			const { service } = setup(
				t,
				[
					{
						json: {
							value: [
								{
									evaluationId: "evaluation-id",
									configuration: { type: { id: buildPolicyType } },
								},
							],
						},
					},
					{ status: 200, body },
				],
				{ resolveValues: [pr] },
			);
			await assert.rejects(service.queuePr(42), (error) => {
				assert.match(error.message, /failed after dispatch/);
				assert.doesNotMatch(error.message, /was accepted/);
				return true;
			});
		}
	});

	test("lists several build policy evaluations and asks for a manual choice", async (t) => {
		const pr = pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});
		const evaluations = [
			{
				evaluationId: "first-evaluation",
				configuration: {
					name: "Widget CI",
					type: { id: buildPolicyType },
				},
			},
			{
				evaluationId: "second-evaluation",
				configurationName: "Widget CD",
				configuration: { type: { id: buildPolicyType } },
			},
			{
				evaluationId: "other-policy",
				configuration: { type: { id: "other-policy-type" } },
			},
		];
		const { service } = setup(t, [{ json: { value: evaluations } }], {
			resolveValues: [pr],
		});
		await assert.rejects(service.queuePr(42), {
			message:
				"More than one build policy evaluation was found for PR #42. Choose one with --definition <id>: evaluation first-evaluation (Widget CI); evaluation second-evaluation (Widget CD).",
		});
	});

	test("queues a branch build with the repository build policy definition", async (t) => {
		const returned = build({
			id: 702,
			sourceBranch: "refs/heads/release/next",
		});
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 3,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 9,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
			{ json: returned },
		]);

		const result = await service.queueBranch("release/next");

		assert.equal(result.id, 702);
		assert.deepEqual(
			requestShapes(calls).map(({ url, method, body }) => ({
				url,
				method,
				body,
			})),
			[
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/git/repositories/checkout-name?api-version=7.1",
					method: "GET",
					body: null,
				},
				{
					url: "https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/configurations?api-version=7.1&policyType=0609b952-1397-4640-95ec-e00a01b2c241",
					method: "GET",
					body: null,
				},
				{
					url: `${buildBase}?api-version=7.1`,
					method: "POST",
					body: JSON.stringify({
						definition: { id: 9 },
						sourceBranch: "refs/heads/release/next",
					}),
				},
			],
		);
	});

	test("preserves a fully qualified source branch when queueing", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 7,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 9,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
			{ json: build({ id: 706, sourceBranch: "refs/heads/main" }) },
		]);

		const result = await service.queueBranch("refs/heads/main");

		assert.equal(result.id, 706);
		assert.equal(
			calls[2].body,
			JSON.stringify({
				definition: { id: 9 },
				sourceBranch: "refs/heads/main",
			}),
		);
	});

	test("gives uncertain-outcome guidance when the branch queue request fails after dispatch", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 7,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 9,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
			{ status: 503, statusText: "Service Unavailable", body: "try later" },
		]);

		await assert.rejects(service.queueBranch("main"), (error) => {
			assert.match(
				error.message,
				/Queue request for build pipeline 9 on refs\/heads\/main failed after dispatch/,
			);
			assert.match(error.message, /do not retry automatically/);
			assert.match(error.message, /503 Service Unavailable/);
			return true;
		});
		assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
	});

	test("reports a missing build policy for branch queueing", async (t) => {
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: [] } },
		]);
		await assert.rejects(
			service.queueBranch("main"),
			/No build policy.*checkout-name/,
		);
	});

	test("lists multiple repository build definitions and their policies", async (t) => {
		const policies = [
			{
				id: 1,
				type: { id: buildPolicyType },
				settings: {
					buildDefinitionId: 9,
					displayName: "Main CI",
					scope: [{ repositoryId: "Repo-ID" }],
				},
			},
			{
				id: 2,
				displayName: "Release policy",
				type: { id: buildPolicyType },
				settings: {
					buildDefinitionId: 10,
					scope: [{ repositoryId: "Repo-ID" }],
				},
			},
		];
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: policies } },
		]);
		await assert.rejects(service.queueBranch("main"), {
			message:
				"More than one build pipeline was found for repository checkout-name. Choose one with --definition <id>: build pipeline 9: policy 1 (Main CI); build pipeline 10: policy 2 (Release policy).",
		});
	});

	test("follows policy continuation tokens to find a build policy on a later page", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: { value: [] },
				headers: { "x-ms-continuationtoken": "page-2" },
			},
			{
				json: {
					value: [
						{
							id: 7,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 9,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
			{ json: build({ id: 707, sourceBranch: "refs/heads/main" }) },
		]);

		const result = await service.queueBranch("main");

		assert.equal(result.id, 707);
		assert.equal(
			calls[2].url,
			"https://dev.azure.com/test%20org/test%2Fproject/_apis/policy/configurations?api-version=7.1&policyType=0609b952-1397-4640-95ec-e00a01b2c241&continuationToken=page-2",
		);
		assert.match(calls[3].body, /"definition":\{"id":9\}/);
	});

	test("rejects a repeated policy continuation token", async (t) => {
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: [] }, headers: { "x-ms-continuationtoken": "same" } },
			{ json: { value: [] }, headers: { "x-ms-continuationtoken": "same" } },
		]);
		await assert.rejects(service.queueBranch("main"), {
			message:
				"Azure DevOps policy pagination repeated a continuation token; refusing to loop.",
		});
	});

	test("strips terminal controls from policy names in ambiguity errors", async (t) => {
		const policies = [9, 10].map((definitionId) => ({
			id: definitionId,
			type: { id: buildPolicyType },
			settings: {
				buildDefinitionId: definitionId,
				displayName: "\u001b[31mEvil\u001b[0m\nname",
				scope: [{ repositoryId: "repo-id" }],
			},
		}));
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: policies } },
		]);
		await assert.rejects(service.queueBranch("main"), {
			message:
				"More than one build pipeline was found for repository checkout-name. Choose one with --definition <id>: build pipeline 9: policy 9 (Evil name); build pipeline 10: policy 10 (Evil name).",
		});
	});

	test("queues once when several repository policies share a build definition", async (t) => {
		const policies = [1, 2].map((id) => ({
			id,
			type: { id: buildPolicyType },
			settings: {
				buildDefinitionId: 9,
				scope: [{ repositoryId: "repo-id" }],
			},
		}));
		policies.unshift(
			{
				type: { id: "other-policy-type" },
				settings: {
					buildDefinitionId: 13,
					scope: [{ repositoryId: "repo-id" }],
				},
			},
			{
				type: null,
				settings: {
					buildDefinitionId: 15,
					scope: [{ repositoryId: "repo-id" }],
				},
			},
			{
				type: { id: buildPolicyType },
				settings: { buildDefinitionId: 16, scope: null },
			},
			{
				type: { id: buildPolicyType },
				settings: {
					buildDefinitionId: 14,
					scope: [{ repositoryId: "another-repo" }],
				},
			},
		);
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: policies } },
			{ json: build({ id: 704 }) },
		]);

		const result = await service.queueBranch("main");

		assert.equal(result.id, 704);
		assert.equal(
			calls[2].body,
			JSON.stringify({
				definition: { id: 9 },
				sourceBranch: "refs/heads/main",
			}),
		);
	});

	test("includes project-wide build policies for the repository", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 4,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 11,
								scope: [{ matchKind: "Exact", refName: "refs/heads/main" }],
							},
						},
						{
							id: 5,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 11,
								scope: [{ repositoryId: null }],
							},
						},
					],
				},
			},
			{ json: build({ id: 705 }) },
		]);

		const result = await service.queueBranch("main");

		assert.equal(result.id, 705);
		assert.equal(
			calls[2].body,
			JSON.stringify({
				definition: { id: 11 },
				sourceBranch: "refs/heads/main",
			}),
		);
	});

	test("ignores disabled build policies", async (t) => {
		const { service, calls } = setup(t, [
			{ json: { id: "repo-id" } },
			{
				json: {
					value: [
						{
							id: 6,
							isEnabled: false,
							type: { id: buildPolicyType },
							settings: {
								buildDefinitionId: 12,
								scope: [{ repositoryId: "repo-id" }],
							},
						},
					],
				},
			},
		]);

		await assert.rejects(
			service.queueBranch("main"),
			/No build policy.*checkout-name/,
		);
		assert.equal(calls.length, 2);
	});

	function evaluation(evaluationId, definitionId, name) {
		return {
			evaluationId,
			configuration: {
				name,
				type: { id: buildPolicyType },
				settings: { buildDefinitionId: definitionId },
			},
		};
	}

	const queuePrPullRequest = () =>
		pullRequest({
			repository: {
				id: "Repo-ID",
				name: "widgets",
				project: { id: projectId },
			},
		});

	test("requeues the evaluation whose pipeline matches --definition", async (t) => {
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							evaluation("first-evaluation", 9, "Widget CI"),
							evaluation("second-evaluation", 12, "Widget CD"),
						],
					},
				},
				{ json: { status: "queued" } },
			],
			{ resolveValues: [queuePrPullRequest()] },
		);

		const result = await service.queuePr(42, 12);

		assert.deepEqual(result, { evaluationId: "second-evaluation" });
		assert.match(calls[1].url, /evaluations\/second-evaluation\?/);
		assert.equal(calls[1].method, "PATCH");
	});

	test("lists the candidates and sends no mutation when --definition matches no evaluation", async (t) => {
		const { service, calls } = setup(
			t,
			[
				{
					json: {
						value: [
							evaluation("first-evaluation", 9, "Widget CI"),
							{
								evaluationId: "unknown-pipeline",
								configuration: { type: { id: buildPolicyType } },
							},
						],
					},
				},
			],
			{ resolveValues: [queuePrPullRequest()] },
		);

		await assert.rejects(service.queuePr(42, 77), {
			message:
				"No build policy evaluation for build pipeline (definition) 77 was found for PR #42. Candidates: evaluation first-evaluation (Widget CI), build pipeline 9; evaluation unknown-pipeline.",
		});
		assert.equal(calls.filter(({ method }) => method !== "GET").length, 0);
	});

	test("fails when several evaluations share the --definition pipeline", async (t) => {
		const { service } = setup(
			t,
			[
				{
					json: {
						value: [
							evaluation("first-evaluation", 9, "Main CI"),
							evaluation("second-evaluation", 9, "Release CI"),
						],
					},
				},
			],
			{ resolveValues: [queuePrPullRequest()] },
		);

		await assert.rejects(service.queuePr(42, 9), {
			message:
				"More than one build policy evaluation was found for PR #42 for build pipeline 9: evaluation first-evaluation (Main CI), build pipeline 9; evaluation second-evaluation (Release CI), build pipeline 9.",
		});
	});

	test("queues --definition on a branch without reading build policies", async (t) => {
		const { service, calls } = setup(t, [{ json: build({ id: 707 }) }]);

		const result = await service.queueBranch("feature/x", 21);

		assert.equal(result.id, 707);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "POST");
		assert.equal(
			calls[0].body,
			JSON.stringify({
				definition: { id: 21 },
				sourceBranch: "refs/heads/feature/x",
			}),
		);
	});

	test("prefers --definition over the repository build policies", async (t) => {
		const { service, calls } = setup(t, [{ json: build({ id: 708 }) }]);

		await service.queueBranch("main", 33);

		assert.equal(calls.length, 1);
		assert.match(calls[0].body, /"definition":\{"id":33\}/);
	});

	test("points to --definition when a branch has no build policy", async (t) => {
		const { service } = setup(t, [
			{ json: { id: "repo-id" } },
			{ json: { value: [] } },
		]);

		await assert.rejects(service.queueBranch("main"), /Pass --definition <id>/);
	});

	describe("scope hint on 401 and 403", () => {
		for (const status of [401, 403]) {
			test(`names the Build (Read & execute) scope when a branch queue gets ${status}`, async (t) => {
				const { service, calls } = setup(t, [
					{ status, statusText: "Denied", body: "no" },
				]);

				await assert.rejects(service.queueBranch("main", 9), (error) => {
					assert.match(
						error.message,
						new RegExp(`rejected with HTTP ${status}`),
					);
					assert.match(error.message, /Build \(Read & execute\)/);
					assert.match(error.message, /vso\.build_execute/);
					assert.doesNotMatch(error.message, /unverified/);
					assert.doesNotMatch(error.message, /may be uncertain/);
					return true;
				});
				assert.equal(calls.length, 1);
			});
		}

		test("adds that a policy requeue may need more scope", async (t) => {
			const { service } = setup(
				t,
				[
					{ json: { value: [evaluation("evaluation-id", 9, "Widget CI")] } },
					{ status: 403, statusText: "Forbidden", body: "no" },
				],
				{ resolveValues: [queuePrPullRequest()] },
			);

			await assert.rejects(service.queuePr(42), (error) => {
				assert.match(error.message, /rejected with HTTP 403/);
				assert.match(error.message, /Build \(Read & execute\)/);
				assert.match(
					error.message,
					/may need more than that; this is unverified/,
				);
				return true;
			});
		});

		test("names the scope when a build retry gets 403", async (t) => {
			const failed = build({ status: "completed", result: "failed" });
			const { service } = setup(
				t,
				[
					{ json: failed },
					{ json: failed },
					{ status: 403, statusText: "Forbidden", body: "no" },
				],
				{ resolveValues: [pullRequest(), pullRequest()] },
			);

			await assert.rejects(service.retry(42, 700), (error) => {
				assert.match(
					error.message,
					/Retry request for build 700 was rejected with HTTP 403/,
				);
				assert.match(error.message, /Build \(Read & execute\)/);
				assert.doesNotMatch(error.message, /unverified/);
				return true;
			});
		});

		test("leaves reads without a scope hint", async (t) => {
			const { service } = setup(t, [
				{ status: 403, statusText: "Forbidden", body: "no" },
			]);

			await assert.rejects(service.queueBranch("main"), (error) => {
				assert.doesNotMatch(error.message, /vso\.build_execute/);
				return true;
			});
		});
	});

	test("rejects 400 and 404 without uncertain-outcome text or a scope hint", async (t) => {
		for (const status of [400, 404]) {
			const { service, calls } = setup(t, [
				{ status, statusText: "Nope", body: "no such pipeline" },
			]);

			await assert.rejects(service.queueBranch("main", 99), (error) => {
				assert.match(
					error.message,
					new RegExp(
						`Queue request for build pipeline 99 on refs/heads/main was rejected with HTTP ${status}; Azure DevOps took no action\\.\\n`,
					),
				);
				assert.doesNotMatch(error.message, /uncertain|retry automatically/);
				assert.doesNotMatch(error.message, /vso\.build_execute/);
				return true;
			});
			assert.equal(calls.length, 1);
		}
	});

	test("keeps 409, 5xx and network failures uncertain", async (t) => {
		for (const response of [
			{ status: 409, statusText: "Conflict", body: "busy" },
			{ status: 500, statusText: "Server Error", body: "oops" },
			{ error: new TypeError("fetch failed") },
		]) {
			const { service } = setup(t, [response]);

			await assert.rejects(service.queueBranch("main", 9), (error) => {
				assert.match(error.message, /failed after dispatch/);
				assert.match(error.message, /may be uncertain/);
				return true;
			});
		}
	});

	test("also says the account may lack permission to queue the build pipeline", async (t) => {
		const { service } = setup(t, [
			{ status: 403, statusText: "Forbidden", body: "no" },
		]);

		await assert.rejects(service.queueBranch("main", 9), (error) => {
			assert.match(
				error.message,
				/the account needs permission to queue builds for that build pipeline/,
			);
			return true;
		});
	});

	test("does not call a failed build read after a successful requeue a rejection", async (t) => {
		const { service, calls } = setup(
			t,
			[
				{ json: { value: [evaluation("evaluation-id", 9, "Widget CI")] } },
				{
					json: {
						evaluationId: "evaluation-id",
						status: "queued",
						context: { buildId: 701 },
					},
				},
				{ status: 403, statusText: "Forbidden", body: "no read" },
			],
			{ resolveValues: [queuePrPullRequest()] },
		);

		await assert.rejects(service.queuePr(42), (error) => {
			assert.match(
				error.message,
				/^Requeued build policy evaluation evaluation-id on PR #42; reading build 701 failed\./,
			);
			assert.match(error.message, /pr\.sh build show --build 701 --pr 42/);
			assert.doesNotMatch(
				error.message,
				/rejected|uncertain|vso\.build_execute/,
			);
			return true;
		});
		assert.equal(calls.filter(({ method }) => method === "PATCH").length, 1);
	});

	describe("queue output", () => {
		test("formatQueue names the build pipeline and adds the wait line for a PR", (t) => {
			const { service } = setup(t, []);

			assert.equal(
				service.formatQueue(
					build({ id: 701, definition: { id: 9, name: "Widget CI" } }),
					42,
				),
				[
					"Azure DevOps queued build 701/2026.8.18.1.",
					"Build pipeline: Widget CI (9)",
					"URL: https://dev.azure.com/build/700",
					"Wait with: pr.sh build wait --build 701 --pr 42",
				].join("\n"),
			);
		});

		test("formatQueue adds a wait that follows the PR head for a PR build", (t) => {
			const { service } = setup(t, []);

			assert.match(
				service.formatQueue(build({ id: 701 }), 42, true),
				/\nWait with: pr\.sh build wait --build 701 --pr 42\nOr follow the PR head, whichever build validates it after later pushes: pr\.sh build wait --latest --pr 42$/,
			);
		});

		test("formatQueue omits the wait line without a PR and the pipeline line without a name", (t) => {
			const { service } = setup(t, []);

			assert.equal(
				service.formatQueue(build({ id: 702, definition: undefined })),
				[
					"Azure DevOps queued build 702/2026.8.18.1.",
					"URL: https://dev.azure.com/build/700",
				].join("\n"),
			);
		});

		test("formatRequeue points to build show and a wait command with the new build ID", (t) => {
			const { service } = setup(t, []);

			assert.equal(
				service.formatRequeue("evaluation-id", 42),
				[
					"Requeued build policy evaluation evaluation-id for PR #42.",
					"Azure DevOps did not return the build ID yet. When `pr.sh build show --latest --pr 42` shows a new build ID, run `pr.sh build wait --build <id> --pr 42`.",
				].join("\n"),
			);
		});
	});

	describe("pull request for a queued branch", () => {
		test("returns the ID of the one active pull request", async (t) => {
			const { service, pullRequestCalls } = setup(t, [], {
				branchPullRequests: [{ pullRequestId: 55 }],
			});

			assert.equal(await service.branchPullRequestId("feature/x"), 55);
			assert.deepEqual(pullRequestCalls, [
				{ method: "findActiveForBranch", branch: "feature/x" },
			]);
		});

		test("returns undefined when the branch has no active pull request", async (t) => {
			const { service } = setup(t, [], { branchPullRequests: [] });

			assert.equal(await service.branchPullRequestId("feature/x"), undefined);
		});

		test("fails naming the candidates when several pull requests share the source", async (t) => {
			const { service } = setup(t, [], {
				branchPullRequests: [{ pullRequestId: 55 }, { pullRequestId: 56 }],
			});

			await assert.rejects(service.branchPullRequestId("feature/x"), {
				message:
					"Multiple active pull requests have feature/x as their source: #55, #56. Run `pr.sh build wait --build <id> --pr <id>` with the one you want.",
			});
		});
	});
});
