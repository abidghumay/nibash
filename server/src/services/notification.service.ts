import { pool } from "../db/pool.js";
import { AppError } from "../errors/AppError.js";

export async function listNotifications(userId: number, unread: boolean, before?: number) {
  const result = await pool.query(
    `SELECT id,contract_id,payment_id,kind,title,body,created_at,read_at
     FROM notifications WHERE user_id=$1
       AND (NOT $2::boolean OR read_at IS NULL)
       AND ($3::integer IS NULL OR id < $3)
     ORDER BY id DESC LIMIT 21`,
    [userId, unread, before ?? null],
  );
  const notifications = result.rows.slice(0,20);
  return {
    notifications,
    nextCursor: result.rows.length > 20 ? notifications[19].id : null,
  };
}

export async function unreadCount(userId: number) {
  const result = await pool.query(
    "SELECT count(*)::int AS count FROM notifications WHERE user_id=$1 AND read_at IS NULL", [userId],
  );
  return result.rows[0].count as number;
}

export async function setNotificationRead(userId: number, id: number, read: boolean) {
  const result = await pool.query(
    `UPDATE notifications SET read_at=CASE WHEN $3::boolean THEN COALESCE(read_at,now()) ELSE NULL END
     WHERE user_id=$1 AND id=$2 RETURNING id,read_at`, [userId,id,read],
  );
  if (!result.rows.length) throw new AppError(404,"Message not found");
  return result.rows[0];
}

export async function markAllNotificationsRead(userId: number) {
  await pool.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [userId]);
}

export async function generateInboxReminders() {
  await pool.query("SELECT generate_inbox_reminders()");
}
