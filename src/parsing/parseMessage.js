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
  "target_reps": number | null,
  "target_sets": number | null,
  "target_tempo": string | null
}

"show_history" — user wants recent entries for an exercise:
{
  "intent": "show_history",
  "exercise": string,
  "lookback_days": number | null
}

"undo" — user wants to delete the last entry:
{
  "intent": "undo"
}

"export_data" — user wants to download or export all their lift records as a file:
{
  "intent": "export_data"
}

"log_challenge" — user logged a challenge result (no weight; total reps, time, or both):
{
  "intent": "log_challenge",
  "exercise": string,
  "total_count": number | null,
  "duration_minutes": number | null,
  "date": "YYYY-MM-DD" | null
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
- "what should I bench for 10 reps" → recommend_weight, exercise="bench press", target_reps=10, target_sets=null, target_tempo=null.
- "what should I bench for 3x10" or "bench 3 sets of 10" → recommend_weight, exercise="bench press", target_reps=10, target_sets=3, target_tempo=null.
- target_sets is null when no set count is mentioned.
- target_tempo for recommend_weight: null means the user did not mention tempo (use their historical default); "none" means the user explicitly said no tempo or normal/standard speed; a tempo string like "30x0" means the user explicitly requested that tempo.
- "show recent bench" → show_history, exercise="bench press", lookback_days=null.
- "show deadlifts over the past year" → show_history, exercise="deadlift", lookback_days=365.
- "show bench last 3 months" → show_history, exercise="bench press", lookback_days=90.
- "show squat last month" → show_history, exercise="squat", lookback_days=30.
- lookback_days is null when no time range is mentioned (show most recent entries).
- "undo" or "delete last" → undo.
- "export my data", "download my lifts", "give me a CSV", "export records" → export_data.
- log_challenge is for workouts where weight is irrelevant: push-up challenges, run/row distances, timed efforts, etc.
- "82 pushups for 100 pushup challenge" → log_challenge, exercise="100 pushup challenge", total_count=82, duration_minutes=null.
- "completed 100 pushup challenge in 11:30" → log_challenge, exercise="100 pushup challenge", total_count=100, duration_minutes=11.5.
- "100 pushup challenge - 75 reps in 12 minutes" → log_challenge, exercise="100 pushup challenge", total_count=75, duration_minutes=12.
- "2000m row in 7:45" → log_challenge, exercise="2000m row", total_count=null, duration_minutes=7.75.
- duration_minutes is a decimal number (11:30 → 11.5, 7:45 → 7.75); null when no time is mentioned.
- total_count is a whole number of reps/meters/etc; null when only time is recorded.
- At least one of total_count or duration_minutes must be non-null for log_challenge.
- Use log_lift (not log_challenge) whenever weight is mentioned or clearly implied.
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
      targetSets:
        typeof parsed.target_sets === 'number' && parsed.target_sets > 0 && Number.isInteger(parsed.target_sets)
          ? parsed.target_sets
          : null,
      targetTempo: typeof parsed.target_tempo === 'string' ? parsed.target_tempo.trim() : null,
    };
  }

  if (intent === 'show_history') {
    if (typeof parsed.exercise !== 'string' || !parsed.exercise.trim()) {
      return { intent: 'unknown' };
    }
    return {
      intent: 'show_history',
      exercise: parsed.exercise.trim(),
      lookbackDays:
        typeof parsed.lookback_days === 'number' && parsed.lookback_days > 0
          ? Math.round(parsed.lookback_days)
          : null,
    };
  }

  if (intent === 'log_challenge') {
    if (typeof parsed.exercise !== 'string' || !parsed.exercise.trim()) {
      return { intent: 'unknown' };
    }
    const totalCount =
      typeof parsed.total_count === 'number' && parsed.total_count > 0 && Number.isInteger(parsed.total_count)
        ? parsed.total_count
        : null;
    const durationMinutes =
      typeof parsed.duration_minutes === 'number' && parsed.duration_minutes > 0
        ? parsed.duration_minutes
        : null;
    if (totalCount === null && durationMinutes === null) return { intent: 'unknown' };
    return {
      intent: 'log_challenge',
      exercise: parsed.exercise.trim(),
      totalCount,
      durationMinutes,
      date: typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
        ? parsed.date
        : null,
    };
  }

  if (intent === 'undo') return { intent: 'undo' };

  if (intent === 'export_data') return { intent: 'export_data' };

  return { intent: 'unknown' };
}
