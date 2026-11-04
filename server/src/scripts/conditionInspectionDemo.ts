/** Isolated local judge demo. It deliberately disables all production database/storage access. */
import "dotenv/config";
import { mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const root = resolve(__dirname, "../../..");
const fixtureNames = ["baseline", "01-identical", "02-lighting", "03-object-moved", "04-wall-mark", "05-obstruction", "06-multiple"];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Local demo cannot run in production");
  const live = process.argv.includes("--live-synthetic");
  if (live && process.argv.includes("--fixture")) throw new Error("Choose one inference mode");
  const resumeIndex = process.argv.indexOf("--resume");
  const resume = resumeIndex < 0 ? "" : process.argv[resumeIndex + 1];
  if (resumeIndex >= 0 && (!/^\d{13}$/.test(resume || "") || process.argv.includes("--fresh"))) throw new Error("Use --resume with a prior printed 13-digit run ID, without --fresh");
  // These assignments run before importing any application module that constructs a pg pool.
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = "postgres://disabled:disabled@127.0.0.1:1/never_connect";
  process.env.JWT_SECRET = "isolated-condition-demo-synthetic-accounts-only";
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.CONDITION_AI_PROCESSING_ENABLED;
  // Fixture mode must work offline, even without a configured provider key. It never invokes the provider.
  if (!live) process.env.GEMINI_API_KEY = "local-fixture-mode-no-provider-key";
  const runId = resume || (process.argv.includes("--fresh") ? String(Date.now()) : "");
  const suffix = runId ? "-" + runId : "";
  const directory = resolve(root, "server/.condition-inspection-demo-data-v1" + suffix);
  await mkdir(directory, { recursive: true });
  const db = new PGlite(resolve(directory, "database"), { extensions: { pg_trgm } });
  const existing = (await db.query<{ name: string | null }>("SELECT to_regclass('public.users') AS name")).rows[0].name;
  if (!existing) {
    const migrations = resolve(root, "db/migrations");
    for (const name of (await readdir(migrations)).filter(n => n.endsWith(".sql")).sort())
      await db.exec((await readFile(resolve(migrations, name), "utf8")).replace(/^\uFEFF/, ""));
    const password = await bcrypt.hash("NibashCondition2026!", 10);
    await db.query(`INSERT INTO users(name,email,nid,phone,password_hash) VALUES
      ('TEST Condition Landlord','condition-owner@example.test','TEST-COND-OWNER','TEST-COND-OWNER',$1),
      ('TEST Condition Tenant','condition-tenant@example.test','TEST-COND-TENANT','TEST-COND-TENANT',$1),
      ('TEST Unrelated Owner','condition-other@example.test','TEST-COND-OTHER','TEST-COND-OTHER',$1)`, [password]);
    await db.exec(`INSERT INTO owners VALUES(1),(3); INSERT INTO tenants VALUES(2,50000,'TEST-EMERGENCY');
      INSERT INTO areas(name,city,latitude,longitude,radius) VALUES('TEST condition area','Dhaka',23.8,90.4,1);
      INSERT INTO listings(title,description,latitude,longitude,bedroom_count,bathroom_count,on_which_floor,area_id,owner_id)
        VALUES('TEST Living Room Apartment','Synthetic condition inspection demonstration',23.8,90.4,1,1,2,1,1),
        ('TEST No Baseline Apartment','Manual documentation demonstration',23.8,90.4,1,1,3,1,1);
      INSERT INTO terms(rent,security_deposit,advance_rent,monthly_due_date) VALUES(100,0,0,5),(100,0,0,5);
      INSERT INTO agreements VALUES(1),(2);
      INSERT INTO contracts(tenant_id,listing_id,agreement_id,start_date,end_date,created_by_id)
        VALUES(2,1,1,(now() AT TIME ZONE 'Asia/Dhaka')::date,(now() AT TIME ZONE 'Asia/Dhaka')::date+365,1),
        (2,2,2,(now() AT TIME ZONE 'Asia/Dhaka')::date,(now() AT TIME ZONE 'Asia/Dhaka')::date+365,1);
      UPDATE contracts SET status='signed' WHERE id IN(1,2);
      INSERT INTO payments(contract_id,amount,due_date)
        VALUES(1,100,(now() AT TIME ZONE 'Asia/Dhaka')::date+1);`);
  } else if (!(await db.query<{ name: string | null }>("SELECT to_regclass('public.condition_analysis_jobs') AS name")).rows[0].name) {
    throw new Error("Demo schema differs; restart with --fresh to create a new isolated directory");
  }
  const { bindSandboxDatabase } = await import("../services/testing/sandboxDatabase.js");
  bindSandboxDatabase(db);
  const { conditionStorage } = await import("../services/conditionStorage.service.js");
  const evidenceRoot = resolve(directory, "private-evidence");
  const signingKey = randomBytes(32).toString("hex");
  const localPath = (path: string) => {
    if (!/^conditions\/[1-9]\d*\/[a-f0-9-]{36}\.(png|jpg)$/.test(path)) throw new Error("Invalid local evidence path");
    return resolve(evidenceRoot, path);
  };
  Object.assign(conditionStorage, {
    async put(path: string, bytes: Buffer) { const target = localPath(path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx" }); },
    async remove(path: string) { await unlink(localPath(path)); },
    async read(path: string) { return readFile(localPath(path)); },
    async sign(path: string) { localPath(path); return "/api/demo-evidence?ticket=" + jwt.sign({ path }, signingKey, { expiresIn: 120, audience: "condition-demo-evidence" }); },
  });
  const { normalizeConditionImage } = await import("../services/conditionImages.js");
  const fixtures = new Map<string, Buffer>();
  for (const name of fixtureNames) fixtures.set(name, (await normalizeConditionImage(await readFile(resolve(root, "output/condition-vision", name + ".png")), "image/png")).buffer);
  const allowedMoveOutHashes = new Set([...fixtures.values()].map(digest));
  const baselineHash = digest(fixtures.get("baseline")!);
  const { ConditionReports } = await import("../services/conditionReports.service.js");
  const baselineService = new ConditionReports();
  let baseline = (await baselineService.get(2, 1)).report;
  if (!baseline) baseline = (await baselineService.create(2, 1)).report;
  if (baseline.status === "draft") {
    if (!baseline.rooms.length) baseline = (await baselineService.addRoom(2, 1, baseline.version, "Living room")).report;
    if (!baseline.photos.length) baseline = (await baselineService.addPhoto(2, 1, baseline.version, baseline.rooms[0].id, fixtures.get("baseline")!, "baseline.png", "image/png", "Project-authored synthetic living room; no personal information")).report;
    baseline = (await baselineService.submit(2, 1, baseline.version)).report;
  }
  if (baseline.status === "submitted") {
    baseline = (await baselineService.confirm(1, 1, baseline.version, baseline.integrity_hash)).report;
    baseline = (await baselineService.confirm(2, 1, baseline.version, baseline.integrity_hash)).report;
  }
  const { compareMoveOutPairs, parseMoveOutComparison } = await import("../services/moveOutVision.js");
  const evaluator: typeof compareMoveOutPairs = async pairs => {
    // Synthetic bypass NEVER accepts arbitrary uploads. Hash checks happen before any provider request.
    if (pairs.some(pair => digest(pair.baseline) !== baselineHash || !allowedMoveOutHashes.has(digest(pair.moveOut))))
      throw new Error("demo_only_project_authored_synthetic_fixtures_allowed");
    if (live) return compareMoveOutPairs(pairs, { synthetic: true });
    const findings = pairs.flatMap(pair => {
      const name = [...fixtures].find(([, bytes]) => digest(bytes) === digest(pair.moveOut))?.[0];
      if (name !== "04-wall-mark" && name !== "06-multiple") return [];
      return [{ roomId: pair.roomId, baselinePhotoId: pair.baselinePhotoId, moveOutPhotoId: pair.moveOutPhotoId, category: "possible_visible_change",
        description: "FIXTURE FALLBACK: A brown mark appears near the center of the back wall. Inspect this area.", locationHint: "Center of back wall", visualEvidence: "Project-authored synthetic fixture contains a brown zigzag wall mark." }];
    });
    return { result: parseMoveOutComparison({ comparisonStatus: "compared", summary: "FIXTURE FALLBACK — precomputed demonstration, no live Gemini inference.", findings,
      limitations: ["Synthetic fixture response is only a demonstration of the review workflow; it is not model evaluation evidence."] }, pairs),
      model: "FIXTURE-NO-MODEL", runtime_ms: 0, usage: null, raw_response: { fixture: true }, api: "explicit fixture fallback", prompt_version: "explicit-demo-fixture-v1" };
  };
  const { ConditionAiJobs } = await import("../services/conditionAiJobs.service.js");
  // This gate is local to this isolated process. The injected evaluator still rejects all unknown photo hashes.
  process.env.CONDITION_AI_PROCESSING_ENABLED = "true";
  const jobs = new ConditionAiJobs(undefined, conditionStorage, evaluator, () => true);
  const app = express();
  app.use(cors({ origin: ["http://127.0.0.1:5056", "http://localhost:5173"] }));
  app.use(express.json());
  app.get("/api/demo-evidence", async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    try {
      if (typeof req.query.ticket !== "string" || Object.keys(req.query).length !== 1) throw new Error("Missing signed ticket");
      const payload = jwt.verify(req.query.ticket, signingKey, { audience: "condition-demo-evidence" }) as { path: string };
      const bytes = await readFile(localPath(payload.path));
      res.type(payload.path.endsWith("png") ? "png" : "jpeg").send(bytes);
    } catch { res.status(403).json({ error: "Evidence access requires a valid unexpired signed ticket" }); }
  });
  app.get("/demo-fixtures/:name", async (req, res) => {
    const name = req.params.name.replace(/\.png$/, "");
    if (!fixtureNames.includes(name)) { res.sendStatus(404); return; }
    res.type("png").send(fixtures.get(name));
  });
  for (const [path, module] of [["auth", "auth"], ["contracts", "contract"], ["rental", "rental"], ["payments", "payment"], ["notifications", "notification"], ["areas", "area"], ["owners/me/income", "income"]] as const) {
    const route = await import("../routes/" + module + ".route.js");
    app.use("/api/" + path, route.default);
  }
  const authModule = await import("../middleware/auth.js");
  const authMiddleware = (typeof authModule.default === "function" ? authModule.default : authModule.default.default) as express.RequestHandler;
  const { asyncHandler } = await import("../utils/asyncHandler.js");
  const { getForContract } = await import("../controllers/review.controller.js");
  app.get("/api/reviews/contract/:contract_id", authMiddleware, asyncHandler(getForContract));
  app.use("/api", (_req, res) => { res.status(404).json({ error: "Endpoint outside the isolated condition demo" }); });
  const assets = resolve(root, "client/dist/condition-demo");
  app.use(express.static(assets, { index: false }));
  app.get("/{*path}", async (_req, res) => {
    try {
      const html = await readFile(resolve(assets, "index.html"), "utf8");
      const mode = live ? "LIVE GEMINI — authored synthetic image pairs only" : "FIXTURE FALLBACK — no live Gemini inference";
      res.type("html").send(html.replace(/(<body[^>]*>)/, '$1<aside style="padding:12px;background:#fff3ce;color:#3c2900;text-align:center;font:600 14px system-ui">LOCAL SYNTHETIC CONDITION DEMO · ' + mode + " · Local PGlite, private disk storage and test accounts.</aside>"));
    } catch { res.status(503).type("text").send("Build the condition demo client first; see docs/condition-inspection-demo.md"); }
  });
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void jobs.processOne().catch(() => console.error("Condition demo job failed; manual inspection remains available")).finally(() => { running = false; });
  }, 1000);
  const server = app.listen(5056, "127.0.0.1", () => {
    console.log("Condition demo: http://127.0.0.1:5056/contracts/1");
    console.log(live ? "LIVE GEMINI, synthetic fixture hashes only" : "FIXTURE FALLBACK, no live model inference");
    console.log("Accounts: condition-owner@example.test / condition-tenant@example.test; password: NibashCondition2026!");
    console.log("Persistent isolated directory: " + directory);
    if (runId) console.log("Resume this run with --resume " + runId + (live ? " --live-synthetic" : " --fixture"));
  });
  const stop = () => { clearInterval(timer); server.close(() => { const wait = setInterval(() => { if (!running) { clearInterval(wait); void db.close().then(() => process.exit(0)); } }, 100); }); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
void main().catch(error => { console.error("Condition demo startup failed: " + (error instanceof Error ? error.message : "local setup failure")); process.exit(1); });
