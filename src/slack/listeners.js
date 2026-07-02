import { db } from '../db/index.js';
import {
  users,
  exercises,
  exerciseAliases,
  workoutEntries,
  pendingEntries,
  reminderSchedules,
} from '../db/schema.js';
import { eq, and, desc, asc, gte } from 'drizzle-orm';
import { parseMessage } from '../parsing/parseMessage.js';
import { resolveExercise, normalizeText, toTitleCase } from '../exercises/resolveExercise.js';
import { recommendWeight } from '../recommendations/recommendWeight.js';

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getOrCreateUser(slackUserId) {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.slackUserId, slackUserId))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(users)
    .values({ slackUserId })
    .returning();
  return created;
}

async function createExerciseWithAlias(userId, canonicalName, rawText) {
  const [exercise] = await db
    .insert(exercises)
    .values({ userId, canonicalName })
    .returning();
  await upsertAlias(exercise.id, userId, rawText);
  return exercise;
}

async function upsertAlias(exerciseId, userId, rawText) {
  await db
    .insert(exerciseAliases)
    .values({
      exerciseId,
      userId,
      aliasText: rawText,
      normalizedAliasText: normalizeText(rawText),
    })
    .onConflictDoNothing();
}

async function saveEntry(userId, exerciseId, { exercise, weight, reps, unit, tempo, date, entryType, durationMinutes }, rawMessage) {
  const performedAt = date ? new Date(date) : new Date();
  const [entry] = await db
    .insert(workoutEntries)
    .values({
      userId,
      exerciseId,
      rawExerciseText: exercise,
      rawMessage,
      weight: String(weight),
      reps,
      unit,
      tempo: tempo ?? null,
      entryType: entryType ?? 'set',
      durationMinutes: durationMinutes != null ? String(durationMinutes) : null,
      performedAt,
    })
    .returning();
  return entry;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtDate(date) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function fmtDuration(minutes) {
  const m = Math.floor(Number(minutes));
  const s = Math.round((Number(minutes) - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtChallenge(e) {
  const parts = [];
  if (e.reps > 0) parts.push(`${e.reps} reps`);
  if (e.durationMinutes) parts.push(`in ${fmtDuration(e.durationMinutes)}`);
  return parts.join(' ');
}

function csvEscape(val) {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ── Intent handlers ───────────────────────────────────────────────────────────

async function handleUndo(user, say) {
  const [last] = await db
    .select()
    .from(workoutEntries)
    .where(eq(workoutEntries.userId, user.id))
    .orderBy(desc(workoutEntries.createdAt))
    .limit(1);

  if (!last) {
    await say('Nothing to undo.');
    return;
  }

  const [ex] = await db
    .select()
    .from(exercises)
    .where(eq(exercises.id, last.exerciseId))
    .limit(1);

  await db.delete(workoutEntries).where(eq(workoutEntries.id, last.id));

  const name = ex?.canonicalName ?? 'exercise';
  const detail = last.entryType === 'challenge'
    ? fmtChallenge(last)
    : `${parseFloat(last.weight)} ${last.unit} × ${last.reps}`;
  await say(`Deleted: *${name}* — ${detail} (${fmtDate(last.performedAt)})`);
}

async function handleShowHistory(user, parsed, say) {
  const resolution = await resolveExercise(parsed.exercise, user.id);

  let exerciseId;
  let exerciseName;

  if (resolution.action === 'match_existing') {
    exerciseId = resolution.exercise.id;
    exerciseName = resolution.exercise.canonicalName;
  } else if (resolution.action === 'ask_user') {
    // Multiple plausible matches — show history for the first and note ambiguity
    exerciseId = resolution.candidates[0].id;
    exerciseName = resolution.candidates[0].canonicalName;
  } else {
    await say(`No history found for *${parsed.exercise}*. Log a set first.`);
    return;
  }

  const conditions = [
    eq(workoutEntries.userId, user.id),
    eq(workoutEntries.exerciseId, exerciseId),
  ];

  if (parsed.lookbackDays) {
    const since = new Date();
    since.setDate(since.getDate() - parsed.lookbackDays);
    conditions.push(gte(workoutEntries.performedAt, since));
  }

  const entries = await db
    .select()
    .from(workoutEntries)
    .where(and(...conditions))
    .orderBy(desc(workoutEntries.performedAt))
    .limit(parsed.lookbackDays ? 100 : 10);

  if (entries.length === 0) {
    const rangeNote = parsed.lookbackDays ? ` in the past ${parsed.lookbackDays} days` : '';
    await say(`No history found for *${exerciseName}*${rangeNote}.`);
    return;
  }

  const lines = entries.map((e) => {
    const detail = e.entryType === 'challenge'
      ? fmtChallenge(e)
      : `${parseFloat(e.weight)} ${e.unit} × ${e.reps}${e.tempo ? ` @ ${e.tempo}` : ''}`;
    return `• ${fmtDate(e.performedAt)}: ${detail}`;
  });
  const header = parsed.lookbackDays
    ? `*${exerciseName}* — past ${parsed.lookbackDays} days (${entries.length} entries):`
    : `*${exerciseName}* — recent entries:`;
  await say(`${header}\n${lines.join('\n')}`);
}

async function handleRecommend(user, parsed, say) {
  const resolution = await resolveExercise(parsed.exercise, user.id);

  if (resolution.action !== 'match_existing') {
    await say(`No history for *${parsed.exercise}* yet. Log some sets first.`);
    return;
  }

  const { exercise } = resolution;
  const targetReps = parsed.targetReps ?? 10;
  const targetSets = parsed.targetSets ?? 1;
  const tempoOverride = parsed.targetTempo !== null ? parsed.targetTempo : undefined;
  const rec = await recommendWeight(user.id, exercise.id, targetReps, targetSets, user.defaultUnit, tempoOverride);

  if (!rec) {
    await say(`No entries found for *${exercise.canonicalName}*. Log some sets first.`);
    return;
  }

  const tempoNote = rec.targetTempo ? ` at ${rec.targetTempo} tempo` : '';

  const based = rec.sourcedFrom
    .map((s) => `• ${fmtDate(s.date)}: ${s.weight} ${s.unit} × ${s.reps}${s.tempo ? ` @ ${s.tempo}` : ''}`)
    .join('\n');

  let recommendation;
  if (rec.sets.length === 1) {
    recommendation = `I'd suggest *${rec.sets[0].weight} ${rec.unit}* for ${rec.targetReps} reps${tempoNote}.`;
  } else {
    const setLines = rec.sets
      .map((s) => `• Set ${s.setNumber} (${s.label}): *${s.weight} ${s.unit}*`)
      .join('\n');
    recommendation = `Here's your *${exercise.canonicalName}* plan for ${rec.targetSets}×${rec.targetReps}${tempoNote}:\n${setLines}`;
  }

  await say(
    `${recommendation}\n\n` +
      `Based on:\n${based}\n\n` +
      `Estimated 1RM: ~*${rec.estimated1RM} ${rec.unit}*`,
  );
}

async function handleLogChallenge(user, parsed, rawMessage, say) {
  const resolution = await resolveExercise(parsed.exercise, user.id);
  const challengeFields = {
    exercise: parsed.exercise,
    weight: 0,
    reps: parsed.totalCount ?? 0,
    unit: 'count',
    tempo: null,
    date: parsed.date,
    entryType: 'challenge',
    durationMinutes: parsed.durationMinutes ?? null,
  };
  const resultLabel = fmtChallenge({ reps: challengeFields.reps, durationMinutes: challengeFields.durationMinutes });

  if (resolution.action === 'match_existing') {
    const { exercise } = resolution;
    await upsertAlias(exercise.id, user.id, parsed.exercise);
    await saveEntry(user.id, exercise.id, challengeFields, rawMessage);
    await say(`Logged: *${exercise.canonicalName}* — ${resultLabel}`);
    return;
  }

  if (resolution.action === 'create_new') {
    const exercise = await createExerciseWithAlias(user.id, resolution.canonicalName, parsed.exercise);
    await saveEntry(user.id, exercise.id, challengeFields, rawMessage);
    await say(`Logged: *${resolution.canonicalName}* — ${resultLabel}`);
    return;
  }

  // ask_user — save pending and show buttons
  const performedAt = parsed.date ? new Date(parsed.date) : new Date();
  const [pending] = await db
    .insert(pendingEntries)
    .values({
      userId: user.id,
      rawMessage,
      rawExerciseText: parsed.exercise,
      weight: '0',
      reps: challengeFields.reps,
      unit: 'count',
      tempo: null,
      entryType: 'challenge',
      durationMinutes: parsed.durationMinutes != null ? String(parsed.durationMinutes) : null,
      performedAt,
      candidateMatches: resolution.candidates.map((c) => ({ id: c.id, name: c.canonicalName })),
    })
    .returning();

  const existingButtons = resolution.candidates.map((c) => ({
    type: 'button',
    text: { type: 'plain_text', text: c.canonicalName },
    action_id: 'gym_resolve_existing',
    value: JSON.stringify({ pendingId: pending.id, exerciseId: c.id }),
  }));

  const createButton = {
    type: 'button',
    text: { type: 'plain_text', text: `New: "${toTitleCase(parsed.exercise)}"` },
    action_id: 'gym_resolve_create',
    value: JSON.stringify({ pendingId: pending.id }),
    style: 'primary',
  };

  await say({
    text: `Which exercise is "${parsed.exercise}"?`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Which exercise is *"${parsed.exercise}"*?\n_${resultLabel}_`,
        },
      },
      {
        type: 'actions',
        elements: [...existingButtons, createButton],
      },
    ],
  });
}

async function handleLogLift(user, parsed, rawMessage, say) {
  const resolution = await resolveExercise(parsed.exercise, user.id);

  if (resolution.action === 'match_existing') {
    const { exercise } = resolution;
    await upsertAlias(exercise.id, user.id, parsed.exercise);
    await saveEntry(user.id, exercise.id, parsed, rawMessage);
    await say(`Logged: *${exercise.canonicalName}* — ${parsed.weight} ${parsed.unit} × ${parsed.reps}${parsed.tempo ? ` @ ${parsed.tempo}` : ''}`);
    return;
  }

  if (resolution.action === 'create_new') {
    const exercise = await createExerciseWithAlias(user.id, resolution.canonicalName, parsed.exercise);
    await saveEntry(user.id, exercise.id, parsed, rawMessage);
    await say(`Logged: *${resolution.canonicalName}* — ${parsed.weight} ${parsed.unit} × ${parsed.reps}${parsed.tempo ? ` @ ${parsed.tempo}` : ''}`);
    return;
  }

  // ask_user — save pending entry and show buttons
  const performedAt = parsed.date ? new Date(parsed.date) : new Date();
  const [pending] = await db
    .insert(pendingEntries)
    .values({
      userId: user.id,
      rawMessage,
      rawExerciseText: parsed.exercise,
      weight: String(parsed.weight),
      reps: parsed.reps,
      unit: parsed.unit,
      tempo: parsed.tempo ?? null,
      performedAt,
      candidateMatches: resolution.candidates.map((c) => ({ id: c.id, name: c.canonicalName })),
    })
    .returning();

  const existingButtons = resolution.candidates.map((c) => ({
    type: 'button',
    text: { type: 'plain_text', text: c.canonicalName },
    action_id: 'gym_resolve_existing',
    value: JSON.stringify({ pendingId: pending.id, exerciseId: c.id }),
  }));

  const createButton = {
    type: 'button',
    text: { type: 'plain_text', text: `New: "${toTitleCase(parsed.exercise)}"` },
    action_id: 'gym_resolve_create',
    value: JSON.stringify({ pendingId: pending.id }),
    style: 'primary',
  };

  await say({
    text: `Which exercise is "${parsed.exercise}"?`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Which exercise is *"${parsed.exercise}"*?\n_${parsed.weight} ${parsed.unit} × ${parsed.reps}${parsed.tempo ? ` @ ${parsed.tempo}` : ''}_`,
        },
      },
      {
        type: 'actions',
        elements: [...existingButtons, createButton],
      },
    ],
  });
}

async function handleExportData(user, message, client, say) {
  const entries = await db
    .select({
      performedAt: workoutEntries.performedAt,
      exercise: exercises.canonicalName,
      entryType: workoutEntries.entryType,
      weight: workoutEntries.weight,
      unit: workoutEntries.unit,
      reps: workoutEntries.reps,
      tempo: workoutEntries.tempo,
      durationMinutes: workoutEntries.durationMinutes,
    })
    .from(workoutEntries)
    .innerJoin(exercises, eq(workoutEntries.exerciseId, exercises.id))
    .where(eq(workoutEntries.userId, user.id))
    .orderBy(asc(workoutEntries.performedAt));

  if (entries.length === 0) {
    await say("You don't have any logged lifts yet.");
    return;
  }

  const rows = entries.map((e) => {
    const date = new Date(e.performedAt).toISOString().split('T')[0];
    if (e.entryType === 'challenge') {
      return [date, csvEscape(e.exercise), 'challenge', '', '', e.reps || '', '', e.durationMinutes ?? ''].join(',');
    }
    return [date, csvEscape(e.exercise), 'set', parseFloat(e.weight), e.unit, e.reps, e.tempo ?? '', ''].join(',');
  });
  const csv = `date,exercise,entry_type,weight,unit,reps,tempo,duration_minutes\n${rows.join('\n')}`;

  await client.filesUploadV2({
    channel_id: message.channel,
    filename: 'gymlog-export.csv',
    content: csv,
    initial_comment: `Here are all your lift records (${entries.length} entries).`,
  });
}

// ── Reminder helpers ──────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtReminderTime(hour, minute) {
  const ampm = hour >= 12 ? 'pm' : 'am';
  const h = hour % 12 || 12;
  const m = minute > 0 ? `:${String(minute).padStart(2, '0')}` : '';
  return `${h}${m}${ampm}`;
}

function fmtReminderDays(daysOfWeek) {
  if (daysOfWeek.length === 7) return 'every day';
  const sorted = [...daysOfWeek].sort((a, b) => a - b);
  return sorted.map((d) => DAY_NAMES[d]).join('/');
}

async function handleSetReminder(user, parsed, say) {
  await db.delete(reminderSchedules).where(eq(reminderSchedules.userId, user.id));
  await db.insert(reminderSchedules).values({
    userId: user.id,
    daysOfWeek: parsed.daysOfWeek,
    hour: parsed.hour,
    minute: parsed.minute,
  });
  const days = fmtReminderDays(parsed.daysOfWeek);
  const time = fmtReminderTime(parsed.hour, parsed.minute);
  const tz = user.timezone !== 'UTC' ? ` (${user.timezone})` : '';
  await say(`Got it! I'll remind you *${days} at ${time}*${tz} to log your workout.`);
}

async function handleClearReminder(user, say) {
  const result = await db.delete(reminderSchedules).where(eq(reminderSchedules.userId, user.id)).returning();
  if (result.length === 0) {
    await say("You don't have any reminders set.");
  } else {
    await say('Reminders cleared.');
  }
}

async function handleShowReminders(user, say) {
  const schedules = await db
    .select()
    .from(reminderSchedules)
    .where(eq(reminderSchedules.userId, user.id));

  if (schedules.length === 0) {
    await say("You don't have any reminders set. Try: _remind me Mon/Wed/Fri at 5pm_");
    return;
  }

  const tz = user.timezone !== 'UTC' ? ` (${user.timezone})` : '';
  const lines = schedules.map((s) => {
    const days = fmtReminderDays(s.daysOfWeek);
    const time = fmtReminderTime(s.hour, s.minute);
    return `• *${days}* at *${time}*${tz}`;
  });
  await say(`Your workout reminders:\n${lines.join('\n')}`);
}

// ── Button action handler ─────────────────────────────────────────────────────

async function handleResolveAction(action, body, respond) {
  const slackUserId = body.user.id;
  const user = await getOrCreateUser(slackUserId);
  const value = JSON.parse(action.value);
  const { pendingId } = value;

  const [pending] = await db
    .select()
    .from(pendingEntries)
    .where(eq(pendingEntries.id, pendingId))
    .limit(1);

  if (!pending) {
    await respond({ replace_original: true, text: 'That request expired — please try again.' });
    return;
  }

  let exerciseId;
  let exerciseName;

  if (action.action_id === 'gym_resolve_existing') {
    exerciseId = value.exerciseId;
    const [ex] = await db
      .select()
      .from(exercises)
      .where(eq(exercises.id, exerciseId))
      .limit(1);
    exerciseName = ex?.canonicalName ?? 'exercise';
    await upsertAlias(exerciseId, user.id, pending.rawExerciseText);
  } else {
    const canonicalName = toTitleCase(pending.rawExerciseText.trim());
    const ex = await createExerciseWithAlias(user.id, canonicalName, pending.rawExerciseText);
    exerciseId = ex.id;
    exerciseName = canonicalName;
  }

  await db.insert(workoutEntries).values({
    userId: user.id,
    exerciseId,
    rawExerciseText: pending.rawExerciseText,
    rawMessage: pending.rawMessage,
    weight: pending.weight,
    reps: pending.reps,
    unit: pending.unit,
    tempo: pending.tempo ?? null,
    entryType: pending.entryType ?? 'set',
    durationMinutes: pending.durationMinutes ?? null,
    performedAt: new Date(pending.performedAt),
  });

  await db.delete(pendingEntries).where(eq(pendingEntries.id, pendingId));

  const detail = pending.entryType === 'challenge'
    ? fmtChallenge({ reps: pending.reps, durationMinutes: pending.durationMinutes })
    : `${parseFloat(pending.weight)} ${pending.unit} × ${pending.reps}${pending.tempo ? ` @ ${pending.tempo}` : ''}`;
  await respond({
    replace_original: true,
    text: `Logged: *${exerciseName}* — ${detail}`,
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerListeners(app) {
  app.message(async ({ message, say, client }) => {
    console.log('[debug] message received:', JSON.stringify({ subtype: message.subtype, channel_type: message.channel_type, text: message.text }));
    if (message.subtype) return;
    if (message.channel_type !== 'im') return;

    const text = message.text?.trim();
    if (!text) return;

    try {
      const user = await getOrCreateUser(message.user);
      const parsed = await parseMessage(text, user.timezone);

      if (parsed.intent === 'undo') return await handleUndo(user, say);
      if (parsed.intent === 'show_history') return await handleShowHistory(user, parsed, say);
      if (parsed.intent === 'recommend_weight') return await handleRecommend(user, parsed, say);
      if (parsed.intent === 'log_lift') return await handleLogLift(user, parsed, text, say);
      if (parsed.intent === 'log_challenge') return await handleLogChallenge(user, parsed, text, say);
      if (parsed.intent === 'export_data') return await handleExportData(user, message, client, say);
      if (parsed.intent === 'set_reminder') return await handleSetReminder(user, parsed, say);
      if (parsed.intent === 'clear_reminder') return await handleClearReminder(user, say);
      if (parsed.intent === 'show_reminders') return await handleShowReminders(user, say);

      await say(
        "I didn't understand that. Try:\n" +
          '• `bench press 215x3`\n' +
          '• `what should I bench for 10 reps?`\n' +
          '• `show recent bench` or `show deadlifts over the past year`\n' +
          '• `82 pushups for 100 pushup challenge` or `100 pushup challenge in 11:30`\n' +
          '• `undo`\n' +
          '• `export my data`\n' +
          '• `remind me Mon/Wed/Fri at 5pm`\n' +
          '• `show my reminders` or `clear reminders`',
      );
    } catch (err) {
      console.error('[error] message handler:', err);
      await say('Sorry, something went wrong. Please try again.');
    }
  });

  app.action(/^gym_resolve_/, async ({ action, ack, body, respond }) => {
    await ack();
    try {
      await handleResolveAction(action, body, respond);
    } catch (err) {
      console.error('[error] resolve action:', err);
      await respond({ replace_original: false, text: 'Sorry, something went wrong. Please try again.' });
    }
  });
}
