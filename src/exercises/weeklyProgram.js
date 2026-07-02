import OpenAI from 'openai';
import { db } from '../db/index.js';
import { weeklyPrograms, weeklyProgramExercises } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';

const openai = new OpenAI();

// Returns the Monday of the ISO week containing the given date, as 'YYYY-MM-DD'
export function getWeekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split('T')[0];
}

export async function saveWeeklyProgram(coachUserId, exercises, date = new Date()) {
  const weekStart = getWeekStart(date);

  const [existing] = await db
    .select()
    .from(weeklyPrograms)
    .where(eq(weeklyPrograms.weekStartDate, weekStart))
    .limit(1);

  if (existing) {
    await db
      .delete(weeklyProgramExercises)
      .where(eq(weeklyProgramExercises.programId, existing.id));
    await db.delete(weeklyPrograms).where(eq(weeklyPrograms.id, existing.id));
  }

  const [program] = await db
    .insert(weeklyPrograms)
    .values({ coachUserId, weekStartDate: weekStart })
    .returning();

  for (let i = 0; i < exercises.length; i++) {
    const ex = exercises[i];
    await db.insert(weeklyProgramExercises).values({
      programId: program.id,
      exerciseName: ex.name,
      targetReps: ex.targetReps ?? null,
      tempo: ex.tempo ?? null,
      displayOrder: i,
    });
  }

  const programExercises = await db
    .select()
    .from(weeklyProgramExercises)
    .where(eq(weeklyProgramExercises.programId, program.id))
    .orderBy(weeklyProgramExercises.displayOrder);

  return { ...program, exercises: programExercises };
}

export async function getActiveWeeklyProgram(date = new Date()) {
  const weekStart = getWeekStart(date);

  const [program] = await db
    .select()
    .from(weeklyPrograms)
    .where(eq(weeklyPrograms.weekStartDate, weekStart))
    .limit(1);

  if (!program) return null;

  const exercises = await db
    .select()
    .from(weeklyProgramExercises)
    .where(eq(weeklyProgramExercises.programId, program.id))
    .orderBy(weeklyProgramExercises.displayOrder);

  return { ...program, exercises };
}

const MATCH_SYSTEM = `You are a gym exercise matcher. Given a user's raw exercise text and this week's programmed exercises, determine if the text refers to one of them.

Input (JSON):
- rawText: string — the user's input
- programExercises: array of { id, name, targetReps, tempo }

Return one of (no prose, no code fences):
{ "matched": true, "programExerciseId": <id> }
{ "matched": false }

Rules:
- Match when the raw text is a shorthand, abbreviation, or informal name for a programmed exercise.
  Example: "squats" → "1-1/4 Cyclist Squat" if that's the only squat in the program.
  Example: "hip thrust" → "BB Hip Thrust"
- If multiple exercises plausibly match, pick the most specific/likely one.
- The weekly program is the primary context — prefer matching over not matching when reasonable.
- Return matched: false only if there is genuinely no plausible match.
`;

export async function matchToWeeklyProgram(rawText, programExercises) {
  if (!programExercises || programExercises.length === 0) return null;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: MATCH_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          rawText,
          programExercises: programExercises.map((e) => ({
            id: e.id,
            name: e.exerciseName,
            targetReps: e.targetReps,
            tempo: e.tempo,
          })),
        }),
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  let result;
  try {
    result = JSON.parse(completion.choices[0].message.content);
  } catch {
    return null;
  }

  if (!result?.matched) return null;

  return programExercises.find((e) => e.id === result.programExerciseId) ?? null;
}
