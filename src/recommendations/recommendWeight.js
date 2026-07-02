import { db } from '../db/index.js';
import { workoutEntries } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';

function epley1RM(weight, reps) {
  // Epley formula: weight * (1 + reps/30)
  return weight * (1 + reps / 30);
}

function targetWeightFor(estimated1RM, targetReps) {
  return estimated1RM / (1 + targetReps / 30);
}

function roundToIncrement(value, unit) {
  const increment = unit === 'kg' ? 2.5 : 5;
  return Math.round(value / increment) * increment;
}

function convertWeight(weight, fromUnit, toUnit) {
  if (fromUnit === toUnit) return weight;
  return toUnit === 'kg' ? weight * 0.453592 : weight * 2.20462;
}

export async function recommendWeight(userId, exerciseId, targetReps = 10, unit = 'lb') {
  const entries = await db
    .select()
    .from(workoutEntries)
    .where(
      and(
        eq(workoutEntries.userId, userId),
        eq(workoutEntries.exerciseId, exerciseId),
      ),
    )
    .orderBy(desc(workoutEntries.performedAt))
    .limit(5);

  if (entries.length === 0) return null;

  const withEpley = entries.map((e) => {
    const w = convertWeight(parseFloat(e.weight), e.unit, unit);
    return {
      entry: e,
      weightInUnit: w,
      estimated1RM: epley1RM(w, e.reps),
    };
  });

  const avg1RM =
    withEpley.reduce((sum, x) => sum + x.estimated1RM, 0) / withEpley.length;

  const target = targetWeightFor(avg1RM, targetReps);
  const increment = unit === 'kg' ? 2.5 : 5;
  const rounded = roundToIncrement(target, unit);
  const low = rounded - increment;
  const high = rounded;

  return {
    recommendedLow: low,
    recommendedHigh: high,
    unit,
    estimated1RM: Math.round(avg1RM),
    targetReps,
    sourcedFrom: withEpley.map((x) => ({
      date: x.entry.performedAt,
      weight: parseFloat(x.entry.weight),
      reps: x.entry.reps,
      unit: x.entry.unit,
    })),
  };
}
