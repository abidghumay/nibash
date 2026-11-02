import cron from "node-cron";
import { pool } from "../db/pool.js";
import { generateInboxReminders } from "../services/notification.service.js";

cron.schedule("5 0 * * *", async () => {
  try {
    await generateInboxReminders();
  } catch (err) {
    console.error("Inbox reminders failed", err);
  }
}, { timezone: "Asia/Dhaka" });

// schedule functions to run automatically at specific times
// cron time format is minute hour day_of_month month day_of_week
cron.schedule("0 0 * * *", async () => {
  // runs every day at midnight
  try {
    const result = await pool.query(
      "UPDATE contracts SET status='completed' WHERE end_date < (NOW() AT TIME ZONE 'Asia/Dhaka')::date AND status='signed' RETURNING id",
    ); // The contract trigger creates inbox messages for both parties.
    console.log(`Updated ${result.rowCount} contracts to completed`);

    await pool.query(
      "DELETE FROM revoked_tokens WHERE expires_at < NOW()",
    );
  } catch (err) {
    console.log(err);
  }
}, { timezone: "Asia/Dhaka" });
export default {};
