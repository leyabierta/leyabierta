/**
 * Multi-agent dataset generation pipeline.
 *
 * Per (norm, article) seed:
 *   personas → questions → leak filter → answerability → critic →
 *   alternative finder → 3-judge panel → difficulty → dedup → dataset row
 *
 * Borderline (1-2/3) goes to a queue for human review.
 *
 * This file is the *orchestrator skeleton* — agent implementations and
 * NaN wiring land in subsequent commits. Keep this file boring so the
 * control flow stays auditable.
 */

import type {
	AlternativeFinderAgent,
	AnswerabilityAgent,
	ArticleSeed,
	CitizenVoiceCriticAgent,
	DedupAgent,
	DifficultyScorerAgent,
	JudgePanel,
	LeakDetectorAgent,
	PersonaAgent,
	QuestionGeneratorAgent,
	Sampler,
} from "./agents/types.ts";
import type {
	BorderlineEntry,
	EvalQuestion,
	ExpectedArticle,
} from "./schema.ts";

export interface PipelineDeps {
	sampler: Sampler;
	personas: PersonaAgent;
	questionGenerator: QuestionGeneratorAgent;
	leakDetector: LeakDetectorAgent;
	answerability: AnswerabilityAgent;
	citizenVoice: CitizenVoiceCriticAgent;
	alternatives: AlternativeFinderAgent;
	judges: JudgePanel;
	difficulty: DifficultyScorerAgent;
	dedup: DedupAgent;
}

export interface PipelineConfig {
	target: number; // desired accepted questions
	maxSeeds: number; // safety cap on samples
	personasPerSeed: number; // typically 3
	concurrency: number; // NaN allows 5 concurrent
	onAccepted?: (q: EvalQuestion) => void | Promise<void>;
	onRejected?: (q: {
		draft: string;
		seed: ArticleSeed;
		reason: string;
	}) => void | Promise<void>;
	onBorderline?: (entry: BorderlineEntry) => void | Promise<void>;
}

export interface PipelineResult {
	accepted: EvalQuestion[];
	borderline: BorderlineEntry[];
	stats: {
		seedsTried: number;
		draftsGenerated: number;
		droppedAtLeak: number;
		droppedAtAnswerability: number;
		droppedAtCritic: number;
		droppedAtJudges: number;
		droppedAtDedup: number;
		accepted: number;
		borderline: number;
	};
}

export async function runPipeline(
	deps: PipelineDeps,
	config: PipelineConfig,
): Promise<PipelineResult> {
	const accepted: EvalQuestion[] = [];
	const borderline: BorderlineEntry[] = [];
	const seenSeeds = new Set<string>();
	const stats: PipelineResult["stats"] = {
		seedsTried: 0,
		draftsGenerated: 0,
		droppedAtLeak: 0,
		droppedAtAnswerability: 0,
		droppedAtCritic: 0,
		droppedAtJudges: 0,
		droppedAtDedup: 0,
		accepted: 0,
		borderline: 0,
	};

	while (
		accepted.length < config.target &&
		stats.seedsTried < config.maxSeeds
	) {
		const batch = await deps.sampler.sample({
			n: Math.min(config.concurrency, config.maxSeeds - stats.seedsTried),
			seenSeeds,
		});
		if (batch.length === 0) break;

		await Promise.all(
			batch.map(async (seed) => {
				seenSeeds.add(`${seed.normId}#${seed.articleId}`);
				stats.seedsTried++;

				const personas = await deps.personas.generate(seed);
				const chosen = personas.slice(0, config.personasPerSeed);

				for (const persona of chosen) {
					const draft = await deps.questionGenerator.generate(seed, persona);
					stats.draftsGenerated++;

					const leak = await deps.leakDetector.check(draft);
					if (!leak.passed) {
						stats.droppedAtLeak++;
						await config.onRejected?.({
							draft: draft.text,
							seed,
							reason: `leak: ${leak.reasons.join("; ")}`,
						});
						continue;
					}

					const ans = await deps.answerability.check(draft, seed);
					if (!ans.passed) {
						stats.droppedAtAnswerability++;
						await config.onRejected?.({
							draft: draft.text,
							seed,
							reason: `unanswerable: ${ans.reason}`,
						});
						continue;
					}

					const voice = await deps.citizenVoice.rewrite(draft);
					if (!voice.passed) {
						stats.droppedAtCritic++;
						await config.onRejected?.({
							draft: draft.text,
							seed,
							reason: "voice critic gave up",
						});
						continue;
					}

					const finalText = voice.text;
					const primary: ExpectedArticle = {
						norm: seed.normId,
						article: seed.articleId,
						primary: true,
					};
					const altArticles = await deps.alternatives.find(finalText, primary);
					const expectedArticles = [primary, ...altArticles];
					const expectedNorms = Array.from(
						new Set(expectedArticles.map((a) => a.norm)),
					);

					const decision = await deps.judges.decide({
						question: finalText,
						voice: persona.register,
						expectedArticles,
					});

					if (decision.verdict === "reject") {
						stats.droppedAtJudges++;
						await config.onRejected?.({
							draft: finalText,
							seed,
							reason: `judges rejected (${decision.rejects}/${decision.votes.length})`,
						});
						continue;
					}

					const isDup = await deps.dedup.isDuplicate(finalText);
					if (isDup) {
						stats.droppedAtDedup++;
						await config.onRejected?.({
							draft: finalText,
							seed,
							reason: "duplicate",
						});
						continue;
					}

					const difficulty = await deps.difficulty.score({
						question: finalText,
						expectedArticles,
					});

					const row: EvalQuestion = {
						id: hashId(finalText),
						question: finalText,
						voice: persona.register,
						expectedNorms,
						expectedArticles,
						materia: seed.materia,
						jurisdiction: seed.jurisdiction,
						difficulty,
						split: "train", // assigned later by `split` command
						provenance: {
							source: "agent-generated",
							seedNorm: seed.normId,
							seedArticle: seed.articleId,
							persona: persona.label,
							generatorModel: draft.generator.model,
							generatorPrompt: draft.generator.prompt,
							leakChecks: leak,
							answerabilityCheck: ans,
							citizenVoiceRewrites: voice.passes,
							alternativesFound: altArticles,
							judges: decision.votes,
							humanReviewed: false,
						},
						createdAt: new Date().toISOString(),
						schemaVersion: 3,
					};

					if (decision.verdict === "borderline") {
						const entry: BorderlineEntry = {
							question: row,
							votes: { accept: decision.accepts, reject: decision.rejects },
							rationale: decision.votes
								.map((v) => `${v.model}: ${v.verdict} (${v.reason})`)
								.join("\n"),
						};
						borderline.push(entry);
						stats.borderline++;
						await config.onBorderline?.(entry);
						continue;
					}

					await deps.dedup.add(finalText);
					accepted.push(row);
					stats.accepted++;
					await config.onAccepted?.(row);
				}
			}),
		);
	}

	return { accepted, borderline, stats };
}

function hashId(text: string): string {
	// Deterministic, stable across runs. Real impl uses crypto subtle.
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return `q_${(h >>> 0).toString(16).padStart(8, "0")}`;
}
