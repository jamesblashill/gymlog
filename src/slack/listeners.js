import { db } from '../db/index.js';
import {
  users,
  exercises,
  exerciseAliases,
  workoutEntries,
  pendingEntries,
} from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
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

async function saveEntry(userId, exerciseId, { exercise, weight, reps, unit, tempo, date }, rawMessage) {
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

  await say(
    `Deleted: *${ex?.canonicalName ?? 'exercise'}* — ${parseFloat(last.weight)} ${last.unit} × ${last.reps} (${fmtDate(last.performedAt)})`,
  );
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

  const entries = await db
    .select()
    .from(workoutEntries)
    .where(
      and(
        eq(workoutEntries.userId, user.id),
        eq(workoutEntries.exerciseId, exerciseId),
      ),
    )
    .orderBy(desc(workoutEntries.performedAt))
    .limit(10);

  if (entries.length === 0) {
    await say(`No history found for *${exerciseName}*.`);
    return;
  }

  const lines = entries.map(
    (e) => `• ${fmtDate(e.performedAt)}: ${parseFloat(e.weight)} ${e.unit} × ${e.reps}`,
  );
  await say(`*${exerciseName}* — recent entries:\n${lines.join('\n')}`);
}

async function handleRecommend(user, parsed, say) {
  const resolution = await resolveExercise(parsed.exercise, user.id);

  if (resolution.action !== 'match_existing') {
    await say(`No history for *${parsed.exercise}* yet. Log some sets first.`);
    return;
  }

  const { exercise } = resolution;
  const targetReps = parsed.targetReps ?? 10;
  const rec = await recommendWeight(user.id, exercise.id, targetReps, user.defaultUnit);

  if (!rec) {
    await say(`No entries found for *${exercise.canonicalName}*. Log some sets first.`);
    return;
  }

  const based = rec.sourcedFrom
    .map((s) => `• ${fmtDate(s.date)}: ${s.weight} ${s.unit} × ${s.reps}`)
    .join('\n');

  await say(
    `I'd start around *${rec.recommendedLow}–${rec.recommendedHigh} ${rec.unit}* for ${rec.targetReps} reps.\n\n` +
      `Based on:\n${based}\n\n` +
      `That puts your estimated 1RM around *${rec.estimated1RM} ${rec.unit}*.`,
  );
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
    performedAt: new Date(pending.performedAt),
  });

  await db.delete(pendingEntries).where(eq(pendingEntries.id, pendingId));

  await respond({
    replace_original: true,
    text: `Logged: *${exerciseName}* — ${parseFloat(pending.weight)} ${pending.unit} × ${pending.reps}${pending.tempo ? ` @ ${pending.tempo}` : ''}`,
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerListeners(app) {
  app.message(async ({ message, say }) => {
    console.log('[debug] message received:', JSON.stringify({ subtype: message.subtype, channel_type: message.channel_type, text: message.text }));
    if (message.subtype) return;
    if (message.channel_type !== 'im') return;

    const text = message.text?.trim();
    if (!text) return;

    const user = await getOrCreateUser(message.user);
    const parsed = await parseMessage(text, user.timezone);

    if (parsed.intent === 'undo') return handleUndo(user, say);
    if (parsed.intent === 'show_history') return handleShowHistory(user, parsed, say);
    if (parsed.intent === 'recommend_weight') return handleRecommend(user, parsed, say);
    if (parsed.intent === 'log_lift') return handleLogLift(user, parsed, text, say);

    await say(
      "I didn't understand that. Try:\n" +
        '• `bench press 215x3`\n' +
        '• `what should I bench for 10 reps?`\n' +
        '• `show recent bench`\n' +
        '• `undo`',
    );
  });

  app.action(/^gym_resolve_/, async ({ action, ack, body, respond }) => {
    await ack();
    await handleResolveAction(action, body, respond);
  });
}
