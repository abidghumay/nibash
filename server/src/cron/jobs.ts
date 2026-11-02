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
    // Expiry is a date, not proof of vacancy. Only dual-party closure releases a listing.
    await pool.query("UPDATE contracts SET occupancy_state='occupied' WHERE status='signed' AND occupancy_state='upcoming' AND start_date <= (NOW() AT TIME ZONE 'Asia/Dhaka')::date");
    await pool.query('CALL generate_monthly_payments()');
    await pool.query('CALL mark_overdue_payments()');

    await pool.query(
      "DELETE FROM revoked_tokens WHERE expires_at < NOW()",
    );
  } catch (err) {
    console.log(err);
  }
}, { timezone: "Asia/Dhaka" });
export default {};
