import { db } from '../db/index.js';
import { reminderSchedules, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// Tracks which (scheduleId, minuteKey) pairs have already fired to prevent double-sends.
const fired = new Map();

function currentMinuteKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}-${d.getUTCMinutes()}`;
}

function getLocalTime(timezone) {
  const now = new Date();
  // Use Intl to get day-of-week, hour, and minute in the user's timezone.
  // hour12: false returns 0-23 (midnight may return "24" on some platforms, hence the % 24).
  const day = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(now);
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(now),
    10,
  ) % 24;
  const minute = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, minute: 'numeric' }).format(now),
    10,
  );
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
  return { dayIndex, hour, minute };
}

export function startScheduler(client) {
  setInterval(async () => {
    const minuteKey = currentMinuteKey();

    // Prune entries from prior minutes.
    for (const key of fired.keys()) {
      if (!key.endsWith(`:${minuteKey}`)) fired.delete(key);
    }

    let schedules;
    try {
      schedules = await db
        .select({
          id: reminderSchedules.id,
          daysOfWeek: reminderSchedules.daysOfWeek,
          hour: reminderSchedules.hour,
          minute: reminderSchedules.minute,
          slackUserId: users.slackUserId,
          timezone: users.timezone,
        })
        .from(reminderSchedules)
        .innerJoin(users, eq(reminderSchedules.userId, users.id))
        .where(eq(reminderSchedules.enabled, true));
    } catch (err) {
      console.error('[scheduler] DB error fetching reminders:', err);
      return;
    }

    for (const schedule of schedules) {
      const fireKey = `${schedule.id}:${minuteKey}`;
      if (fired.has(fireKey)) continue;

      const tz = schedule.timezone || 'UTC';
      let localTime;
      try {
        localTime = getLocalTime(tz);
      } catch {
        localTime = getLocalTime('UTC');
      }

      const days = schedule.daysOfWeek;
      if (!Array.isArray(days) || !days.includes(localTime.dayIndex)) continue;
      if (schedule.hour !== localTime.hour || schedule.minute !== localTime.minute) continue;

      fired.set(fireKey, true);

      try {
        const dmResult = await client.conversations.open({ users: schedule.slackUserId });
        const channelId = dmResult.channel.id;
        await client.chat.postMessage({
          channel: channelId,
          text: "Time to log your workout! What did you lift today?",
        });
      } catch (err) {
        console.error(`[scheduler] Failed to send reminder to ${schedule.slackUserId}:`, err);
      }
    }
  }, 60_000);

  console.log('[scheduler] Reminder scheduler started.');
}
