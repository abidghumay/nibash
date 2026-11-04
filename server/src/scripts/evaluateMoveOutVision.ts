import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { compareMoveOutPairs, MOVE_OUT_PROMPT_VERSION } from "../services/moveOutVision.js";

// Reuse the original project-authored illustrations. Never substitute private photographs.
const fixtures = resolve(__dirname, "../../..", "output/condition-vision");
const defaultOutput = resolve(__dirname, "../../..", "output/condition-phase-two");
const cases = [
  { id: "01-identical", expected: "No meaningful visible difference; empty findings are valid.", changes: [], abstention: false },
  { id: "02-lighting", expected: "Exposure changed; do not describe lighting alone as surface damage.", changes: [], abstention: false },
  { id: "03-object-moved", expected: "The chair moved right. A scene-position difference is acceptable; do not infer property damage.", changes: ["chair position"], abstention: false },
  { id: "04-wall-mark", expected: "Possible new brown zigzag mark near the center of the back wall; cause and responsibility unknown.", changes: ["central back-wall mark"], abstention: false },
  { id: "05-obstruction", expected: "Most relevant surfaces are obscured. Explain comparison limitations and abstain from definite hidden-surface findings.", changes: [], abstention: true },
  { id: "06-multiple", expected: "Separate reviewable observations: central brown wall mark, upper-right wall line, brown floor patch.", changes: ["central back-wall mark", "upper-right wall line", "floor patch"], abstention: false },
];
async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--synthetic")) throw new Error("Pass --synthetic for project-authored fixtures only");
  const index = args.indexOf("--out");
  const out = index < 0 ? defaultOutput : resolve(args[index + 1]);
  if (out === fixtures) throw new Error("Phase 1 evidence must not be overwritten");
  if (existsSync(resolve(out, "results.json"))) throw new Error("Evaluation results already exist. Choose a new --out directory to preserve previous evidence.");
  await mkdir(out, { recursive: true });
  const baseline = await readFile(resolve(fixtures, "baseline.png"));
  const inputs = await Promise.all(cases.map(async c => ({ ...c, bytes: await readFile(resolve(fixtures, c.id + ".png")) })));
  const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  // This file must exist BEFORE inference. Expectations come from the authored SVG fixture source.
  await writeFile(resolve(out, "expectations.json"), JSON.stringify({
    recorded_before_inference: new Date().toISOString(),
    source: "Project-authored Phase 1 synthetic SVG fixtures, inspected against their generation source; no personal data",
    protocol: "Production Phase 2 text-only prompt/schema; no bounding boxes or accuracy percentage. Qualitative small feasibility sample.",
    prompt_version: MOVE_OUT_PROMPT_VERSION,
    baseline: { file: "../condition-vision/baseline.png", sha256: sha256(baseline) },
    cases: inputs.map(({ bytes, ...c }) => ({ ...c, sha256: sha256(bytes) })),
    manual_fallback_cases: [
      { id: "07-no-baseline", expected: "Manual documentation, no Gemini request or before/after claim", evidence_kind: "Backend integration test, not a live model sample" },
      { id: "08-model-unavailable", expected: "Bounded failure leaves manual human review usable", evidence_kind: "Injected unavailable provider in backend integration test, not a live provider outage" },
    ],
  }, null, 2));
  if (args.includes("--expectations-only")) return;
  const results: unknown[] = [];
  for (const c of inputs) {
    try {
      const result = await compareMoveOutPairs([{
        roomId: 1, roomName: "Synthetic living room", baselinePhotoId: 1, moveOutPhotoId: 2,
        baseline, moveOut: c.bytes, baselineMime: "image/png", moveOutMime: "image/png",
      }], { synthetic: true });
      results.push({ id: c.id, expected: c.expected, evidence_kind: "live Gemini response on synthetic images", ...result,
        review: { meaningful_change: "pending qualitative review", false_positives: "pending qualitative review", misses: "pending qualitative review", abstention: "pending qualitative review", description_clarity: "pending qualitative review", bounding_boxes: "Not used: Phase 1 localization was unreliable" } });
      console.log(`${c.id}: live response received (${result.runtime_ms} ms)`);
    } catch (error) {
      const e = error as { code?: string; model?: string; runtime_ms?: number; provider_status?: string };
      results.push({ id: c.id, expected: c.expected, evidence_kind: "live attempt; no valid model comparison", status: "blocked", code: e.code || "local_or_provider_failure", model: e.model, runtime_ms: e.runtime_ms, provider_status: e.provider_status });
      console.log(c.id + ": comparison unavailable");
    }
    await writeFile(resolve(out, "results.json"), JSON.stringify({ recorded_at: new Date().toISOString(), sample_scope: "Six synthetic illustrative pairs; qualitative feasibility only", results }, null, 2));
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Phase 2 synthetic evaluation failed; verify local fixtures and configuration"); process.exitCode = 1; });
