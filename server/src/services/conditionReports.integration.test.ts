import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { rentalDatabase, proposed } from "./testing/rentalFixtures.js";

test("condition reports preserve private, versioned evidence using PostgreSQL", async t => {
  assert.ok(existsSync(resolve(__dirname, "conditionReports.service.ts")), "condition report service must be implemented");
  const { ConditionReports } = await import("./conditionReports.service.js");
  const db = await rentalDatabase(true);
  t.after(() => db.close());
  await db.exec(await readFile(resolve(__dirname, "../../../db/migrations/021_condition_reports.sql"), "utf8"));
  let gate = Promise.resolve();
  const query = async (sql: string, params?: any[]) => db.query(sql, params);
  const database = { query, async connect() {
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    const previous = gate; gate = next; await previous;
    return { query, release };
  }};
  const objects = new Map<string, Buffer>();
  let signed = 0;
  const service = new ConditionReports(database, {
    async put(path: string, bytes: Buffer) { assert.ok(!objects.has(path)); objects.set(path, bytes); },
    async remove(path: string) { objects.delete(path); },
    async sign(path: string) { assert.ok(objects.has(path)); signed++; return "https://storage.example/signed?token=synthetic"; },
  });
  const image = await sharp({create:{width:320,height:240,channels:3,background:"#ddd"}}).png().toBuffer();
  let report: any;
  await t.test("no baseline exists and strangers cannot create or read a report", async () => {
    assert.equal((await service.get(2, 1)).report, null);
    await assert.rejects(() => service.get(3, 1), /Not authorized/);
    await assert.rejects(() => service.create(3, 1), /Not authorized/);
    await db.exec("INSERT INTO users(name,nid,phone,password_hash) VALUES('Other synthetic tenant','SYNTH-4','SYNTH-4','x'); INSERT INTO tenants(user_id,monthly_income,emergency_contact) VALUES(4,10000,'SYNTH-4')");
    await assert.rejects(() => service.get(4,1), /Not authorized/);
    report = (await service.create(2, 1)).report;
    assert.equal(report.record_kind, "current_condition");
    assert.equal(report.status, "draft");
    assert.ok(report.recorded_at);
    assert.equal((await service.create(1, 1)).report.id, report.id);
  });
  await t.test("rooms, decoded photos and changes use expected versions", async () => {
    report = (await service.addRoom(2, 1, report.version, "Bedroom")).report;
    const room = report.rooms[0];
    const before = report.version;
    const result = await service.addPhoto(2, 1, before, room.id, image, "bedroom.png", "image/png", "No mark");
    report = result.report;
    assert.equal(report.photos.length, 1);
    assert.equal(report.photos[0].width, 320);
    assert.match(report.photos[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(report).includes("conditions/"), false, "API must not expose storage paths");
    await assert.rejects(() => service.addRoom(1, 1, before, "Stale room"), /changed/);
    await assert.rejects(() => service.addPhoto(1, 1, report.version, 9999, image, "x.png", "image/png", ""), /Room/);
  });
  await t.test("cross-contract access never reaches storage", async () => {
    const second = await proposed(db, 1);
    await db.query("UPDATE contracts SET status='signed' WHERE id=$1", [second]);
    await assert.rejects(() => service.photoUrl(2, second, report.photos[0].id), /Photo/);
    await assert.rejects(() => service.photoUrl(3, 1, report.photos[0].id), /Not authorized/);
    assert.equal(signed, 0);
    const link = await service.photoUrl(1, 1, report.photos[0].id);
    assert.equal(link.expires_in, 120);
    assert.equal(signed, 1);
  });
  await t.test("submission records an exact snapshot; duplicate confirmation is idempotent", async () => {
    report = (await service.submit(2, 1, report.version)).report;
    assert.equal(report.status, "submitted");
    assert.match(report.integrity_hash, /^[a-f0-9]{64}$/);
    report = (await service.confirm(1, 1, report.version, report.integrity_hash)).report;
    assert.equal(report.confirmations.length, 1);
    report = (await service.confirm(1, 1, report.version, report.integrity_hash)).report;
    assert.equal(report.confirmations.length, 1);
    const submitted = report.events.find((e: any) => e.action === "submitted");
    assert.equal(submitted.details.snapshot.photos[0].sha256, report.photos[0].sha256);
  });
  await t.test("submitted edits invalidate prior confirmation and retain old snapshots", async () => {
    const oldVersion = report.version, oldHash = report.integrity_hash;
    report = (await service.updatePhoto(2, 1, report.version, report.photos[0].id, "Small pre-existing mark")).report;
    assert.equal(report.status, "draft");
    assert.equal(report.confirmations.length, 0);
    assert.equal(report.integrity_hash, null);
    await assert.rejects(() => service.confirm(2, 1, oldVersion, oldHash), /changed/);
    assert.ok(report.events.some((e: any) => e.action === "confirmed"));
  });
  await t.test("replacement retains original evidence and stores a new immutable object", async () => {
    const old = report.photos[0].id;
    report = (await service.removePhoto(2, 1, report.version, old)).report;
    assert.equal(report.photos.length, 0);
    assert.equal(objects.size, 1);
    report = (await service.addPhoto(2, 1, report.version, report.rooms[0].id, image, "again.png", "image/png", "")).report;
    assert.notEqual(report.photos[0].id, old);
    assert.equal(objects.size, 2);
    assert.ok((await service.photoUrl(1, 1, old)).url);
  });
  await t.test("competing edits serialize and only one expected version succeeds", async () => {
    const outcomes = await Promise.allSettled([
      service.addRoom(1, 1, report.version, "Kitchen"),
      service.addRoom(2, 1, report.version, "Bathroom"),
    ]);
    assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
    report = (await service.get(1, 1)).report;
    // Submission requires a photograph in each room.
    const room = report.rooms.find((r: any) => !report.photos.some((p: any) => p.room_id === r.id));
    report = (await service.addPhoto(1, 1, report.version, room.id, image, "second.png", "image/png", "")).report;
  });
  await t.test("AI consent is optional, snapshot-bound and revocable without unlocking", async () => {
    report = (await service.submit(1, 1, report.version)).report;
    const version = report.version, hash = report.integrity_hash;
    await assert.rejects(()=>service.consent(1,1,version,hash,true),/identity documents/);
    await service.consent(1, 1, version, hash, true,true);
    report = (await service.confirm(1, 1, version, hash)).report;
    report = (await service.confirm(2, 1, version, hash)).report;
    assert.equal(report.status, "confirmed");
    assert.equal(report.confirmations.length, 2);
    assert.ok(report.locked_at);
    await service.consent(1, 1, version, hash, false);
    report = (await service.get(2, 1)).report;
    assert.equal(report.ai_consents.find((x: any) => x.actor_id === 1).details.granted, false);
    assert.equal(report.status, "confirmed");
  });
  await t.test("lost COMMIT acknowledgement never deletes committed photographic evidence", async () => {
    const id=await proposed(db,2);await db.query("UPDATE contracts SET status='signed' WHERE id=$1",[id]);
    let loseAcknowledgement=false;
    const faultyDatabase={query,async connect(){
      const connection=await database.connect();
      return {release:connection.release,async query(sql:string,params?:any[]){
        const result=await connection.query(sql,params);
        if(sql==="COMMIT"&&loseAcknowledgement){loseAcknowledgement=false;throw new Error("Commit acknowledgement lost");}
        return result;
      }};
    }};
    const faulty=new ConditionReports(faultyDatabase,{
      async put(path:string,bytes:Buffer){objects.set(path,bytes);},async remove(path:string){objects.delete(path);},async sign(){return "unused";}
    });
    let current=(await faulty.create(2,id)).report!;
    current=(await faulty.addRoom(2,id,current.version,"Commit test")).report!;
    loseAcknowledgement=true;
    await assert.rejects(()=>faulty.addPhoto(2,id,current.version,current.rooms[0].id,image,"commit.png","image/png",""),/acknowledgement/);
    const saved:any=(await db.query("SELECT storage_path FROM condition_photos WHERE report_id=$1",[current.id])).rows[0];
    assert.ok(saved,"Photo row committed before acknowledgement was lost");
    assert.ok(objects.has(saved.storage_path),"Committed image bytes must survive an ambiguous commit");
  });
  await t.test("eligibility is refreshed after acquiring a root lock",async()=>{
    const id=await proposed(db,3);await db.query("UPDATE contracts SET status='signed' WHERE id=$1",[id]);
    let closeAfterLock=true;
    const racingDatabase={query,async connect(){
      const connection=await database.connect();
      return {release:connection.release,async query(sql:string,params?:any[]){
        const result=await connection.query(sql,params);
        if(sql.includes("FOR UPDATE OF root")&&closeAfterLock){
          closeAfterLock=false;
          // Inject the state observed when a root-lock wait ends after closure. This is not a multi-session PostgreSQL test.
          await query("UPDATE contracts SET status='completed',occupancy_state='closed',owner_closed_at=now(),tenant_closed_at=now(),move_out_date=current_date,inspection_note='Synthetic reviewed',settlement_note='Synthetic reviewed' WHERE id=$1",[id]);
        }
        return result;
      }};
    }};
    const racing=new ConditionReports(racingDatabase);
    await assert.rejects(()=>racing.create(2,id),/physically open/);
  });
  await t.test("locked reports reject every ordinary mutation and direct SQL evidence changes", async () => {
    const v = report.version, photo = report.photos[0].id;
    await assert.rejects(() => service.addRoom(1, 1, v, "Locked"), /locked/);
    await assert.rejects(() => service.updatePhoto(2, 1, v, photo, "overwrite"), /locked/);
    await assert.rejects(() => service.removePhoto(1, 1, v, photo), /locked/);
    await assert.rejects(() => service.addPhoto(1, 1, v, report.rooms[0].id, image, "x.png", "image/png", ""), /locked/);
    await assert.rejects(() => db.query("UPDATE condition_photos SET notes='tampered' WHERE id=$1", [photo]), /locked/);
    await assert.rejects(() => db.query("DELETE FROM condition_photos WHERE id=$1", [photo]), /retained|locked/);
    await assert.rejects(() => db.query("UPDATE condition_reports SET status='draft' WHERE id=$1", [report.id]), /locked/);
    await assert.rejects(() => db.query("DELETE FROM condition_events WHERE report_id=$1", [report.id]), /retained/);
    report = (await service.confirm(1, 1, v, report.integrity_hash)).report;
    assert.equal(report.confirmations.length, 2);
  });
  await t.test("browser database roles cannot bypass the backend and lifecycle is unchanged", async () => {
    await db.exec("SET ROLE authenticated");
    await assert.rejects(() => db.query("SELECT * FROM condition_photos"), /permission denied/);
    await db.exec("RESET ROLE");
    const contract: any = (await db.query("SELECT status,occupancy_state FROM contracts WHERE id=1")).rows[0];
    assert.equal(contract.status, "signed");
    assert.notEqual(contract.occupancy_state, "closed");
  });
  await t.test("accepted renewals reuse the existing root baseline without a second tenancy record",async()=>{
    const root=await proposed(db,4,"20000","2026-01-01","2026-12-31");
    await assert.rejects(()=>service.create(2,root),/accepted/);
    await db.query("UPDATE contracts SET status='signed' WHERE id=$1",[root]);
    const baseline=(await service.create(2,root)).report!;
    const renewal=await proposed(db,4,"20000","2027-01-01","2027-12-31",root);
    await db.query("UPDATE contracts SET status='signed' WHERE id=$1",[renewal]);
    assert.equal((await service.get(2,renewal)).report.id,baseline.id);
    assert.equal((await service.create(1,renewal)).report!.id,baseline.id);
    assert.equal((await db.query("SELECT id FROM condition_reports WHERE contract_id=$1",[renewal])).rows.length,0);
  });
});
