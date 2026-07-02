import OpenAI from 'openai';
import { db } from '../db/index.js';
import { exercises, exerciseAliases } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

const openai = new OpenAI();

const SYSTEM = `You are a gym exercise resolver. Match raw exercise text to a user's existing exercises, or decide to create a new one.

Input (JSON):
- rawExercise: string — the user's raw text
- existingExercises: array of { id, canonicalName, aliases: [{ text, normalized }] }

Return one of the following JSON shapes (no prose, no code fences):

Match an existing exercise:
{ "action": "match_existing", "exerciseId": <number> }

Create a new one:
{ "action": "create_new", "canonicalName": <string> }

Ask the user to clarify (2–4 most plausible candidates):
{ "action": "ask_user", "candidates": [<exerciseId>, ...] }

Rules:
- Match when wording differs only by tense, abbreviation, word order, or minor phrasing.
  Examples that should match: "bench" / "bench press" / "bench pressing" / "benching"
- Create new when equipment, angle, grip, stance, limb count, or machine differs.
  Examples that should NOT match: "bench press" vs "incline bench press", "bench press" vs "dumbbell bench press"
- Ask when it's genuinely ambiguous (e.g. "press" when both "Bench Press" and "Overhead Press" exist).
- If existingExercises is empty, always return create_new.
- For create_new, canonicalName must be Title Case: "Bench Press", "Incline Dumbbell Press".
- Never invent an exerciseId that isn't in existingExercises.
`;

export function normalizeText(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ');
}

export function toTitleCase(str) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function getUserExercises(userId) {
  const rows = await db
    .select({
      exerciseId: exercises.id,
      canonicalName: exercises.canonicalName,
      aliasText: exerciseAliases.aliasText,
      normalizedAliasText: exerciseAliases.normalizedAliasText,
    })
    .from(exercises)
    .leftJoin(
      exerciseAliases,
      and(
        eq(exerciseAliases.exerciseId, exercises.id),
        eq(exerciseAliases.userId, userId),
      ),
    )
    .where(eq(exercises.userId, userId));

  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.exerciseId)) {
      map.set(row.exerciseId, {
        id: row.exerciseId,
        canonicalName: row.canonicalName,
        aliases: [],
      });
    }
    if (row.aliasText) {
      map.get(row.exerciseId).aliases.push({
        text: row.aliasText,
        normalized: row.normalizedAliasText,
      });
    }
  }
  return Array.from(map.values());
}

export async function resolveExercise(rawExerciseText, userId) {
  const normalized = normalizeText(rawExerciseText);
  const userExercises = await getUserExercises(userId);

  // Fast path: exact alias match
  for (const ex of userExercises) {
    for (const alias of ex.aliases) {
      if (alias.normalized === normalized) {
        return { action: 'match_existing', exercise: ex };
      }
    }
  }

  // No exercises yet — skip the LLM call
  if (userExercises.length === 0) {
    return {
      action: 'create_new',
      canonicalName: toTitleCase(rawExerciseText.trim()),
      rawExerciseText,
    };
  }

  // LLM resolver
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          rawExercise: rawExerciseText,
          existingExercises: userExercises.map((e) => ({
            id: e.id,
            canonicalName: e.canonicalName,
            aliases: e.aliases,
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
    return {
      action: 'create_new',
      canonicalName: toTitleCase(rawExerciseText.trim()),
      rawExerciseText,
    };
  }

  return validateResult(result, userExercises, rawExerciseText);
}

function validateResult(result, userExercises, rawExerciseText) {
  const fallback = {
    action: 'create_new',
    canonicalName: toTitleCase(rawExerciseText.trim()),
    rawExerciseText,
  };

  if (!result || typeof result.action !== 'string') return fallback;

  if (result.action === 'match_existing') {
    const ex = userExercises.find((e) => e.id === result.exerciseId);
    if (!ex) return fallback;
    return { action: 'match_existing', exercise: ex };
  }

  if (result.action === 'create_new') {
    const canonicalName =
      typeof result.canonicalName === 'string' && result.canonicalName.trim()
        ? result.canonicalName.trim()
        : toTitleCase(rawExerciseText.trim());
    return { action: 'create_new', canonicalName, rawExerciseText };
  }

  if (result.action === 'ask_user') {
    const candidates = Array.isArray(result.candidates)
      ? result.candidates
          .map((id) => userExercises.find((e) => e.id === id))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    if (candidates.length < 2) return fallback;
    return { action: 'ask_user', candidates, rawExerciseText };
  }

  return fallback;
}
