import OpenAI from 'openai';

const openai = new OpenAI();

const SYSTEM = `You are a gym log parser. Extract structured data from a user's workout message.

Return a single JSON object. No prose. No code fences.

Intent types and their schemas:

"log_lift" — user logged a set:
{
  "intent": "log_lift",
  "exercise": string,
  "weight": number,
  "reps": number,
  "unit": "lb" | "kg",
  "tempo": string | null,
  "date": "YYYY-MM-DD" | null
}

"recommend_weight" — user wants a weight recommendation:
{
  "intent": "recommend_weight",
  "exercise": string,
  "target_reps": number | null
}

"show_history" — user wants recent entries for an exercise:
{
  "intent": "show_history",
  "exercise": string
}

"undo" — user wants to delete the last entry:
{
  "intent": "undo"
}

"unknown" — none of the above:
{
  "intent": "unknown"
}

Parsing rules:
- Default unit is "lb" unless "kg" or "kilos" appears or context is clearly metric.
- date is null when no date is mentioned (means today).
- weight and reps must be positive numbers; reps must be a whole number.
- "215x3" means weight=215, reps=3.
- "3 reps @ 215" means weight=215, reps=3.
- tempo is a 4-digit string like "30x0" representing eccentric/pause-at-bottom/concentric/pause-at-top seconds; "x" means explosive. Extract it as-is when present, otherwise null.
- "bench 215x3 @30x0" or "bench 215x3 tempo 30x0" means weight=215, reps=3, tempo="30x0".
- "what should I bench for 10 reps" → recommend_weight, exercise="bench press", target_reps=10.
- "show recent bench" → show_history, exercise="bench press".
- "undo" or "delete last" → undo.
`;

export async function parseMessage(text, userTimezone = 'UTC') {
  const today = new Date().toISOString().split('T')[0];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Today is ${today}. User timezone: ${userTimezone}.\n\nMessage: ${text}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0].message.content);
  } catch {
    return { intent: 'unknown' };
  }

  return validate(parsed);
}

function validate(parsed) {
  if (!parsed || typeof parsed !== 'object') return { intent: 'unknown' };

  const { intent } = parsed;

  if (intent === 'log_lift') {
    if (
      typeof parsed.exercise !== 'string' ||
      !parsed.exercise.trim() ||
      typeof parsed.weight !== 'number' ||
      parsed.weight <= 0 ||
      typeof parsed.reps !== 'number' ||
      parsed.reps <= 0 ||
      !Number.isInteger(parsed.reps) ||
      !['lb', 'kg'].includes(parsed.unit)
    ) {
      return { intent: 'unknown' };
    }
    return {
      intent: 'log_lift',
      exercise: parsed.exercise.trim(),
      weight: parsed.weight,
      reps: parsed.reps,
      unit: parsed.unit,
      tempo: typeof parsed.tempo === 'string' && parsed.tempo.trim() ? parsed.tempo.trim() : null,
      date: typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? parsed.date
        : null,
    };
  }

  if (intent === 'recommend_weight') {
    if (typeof parsed.exercise !== 'string' || !parsed.exercise.trim()) {
      return { intent: 'unknown' };
    }
    return {
      intent: 'recommend_weight',
      exercise: parsed.exercise.trim(),
      targetReps:
        typeof parsed.target_reps === 'number' && parsed.target_reps > 0 && Number.isInteger(parsed.target_reps)
          ? parsed.target_reps
          : null,
    };
  }

  if (intent === 'show_history') {
    if (typeof parsed.exercise !== 'string' || !parsed.exercise.trim()) {
      return { intent: 'unknown' };
    }
    return { intent: 'show_history', exercise: parsed.exercise.trim() };
  }

  if (intent === 'undo') return { intent: 'undo' };

  return { intent: 'unknown' };
}
