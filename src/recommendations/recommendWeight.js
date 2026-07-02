import { db } from '../db/index.js';
import { workoutEntries } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';

// 2-0-1-0 baseline (eccentric/pause/concentric/top)
const STANDARD_SECS_PER_REP = 3;

function epley1RM(weight, reps) {
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

// Parse a tempo string like "30x0" into total seconds per rep ("x" = 1s explosive)
function secsPerRep(tempo) {
  if (!tempo) return STANDARD_SECS_PER_REP;
  const total = tempo.split('').reduce((sum, c) => sum + (c === 'x' ? 1 : (parseInt(c) || 0)), 0);
  return total || STANDARD_SECS_PER_REP;
}

// Linear warmup progression: last set is always working (100%), earlier sets step down 15% each, floored at 40%
function setPercentages(numSets) {
  if (numSets <= 1) return [1.0];
  return Array.from({ length: numSets }, (_, i) => {
    const stepsFromEnd = numSets - 1 - i;
    return stepsFromEnd === 0 ? 1.0 : Math.max(0.4, 1.0 - stepsFromEnd * 0.15);
  });
}

// targetTempoOverride: undefined = use historical default, "none"/"" = explicitly no tempo, other string = explicit tempo
export async function recommendWeight(userId, exerciseId, targetReps = 10, targetSets = 1, unit = 'lb', targetTempoOverride = undefined) {
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

  const avg1RM = withEpley.reduce((sum, x) => sum + x.estimated1RM, 0) / withEpley.length;

  let targetTempo;
  if (targetTempoOverride !== undefined) {
    targetTempo = (targetTempoOverride === 'none' || targetTempoOverride === '') ? null : targetTempoOverride;
  } else {
    // Target the recommendation at the user's most common historical tempo
    const tempoCounts = {};
    for (const x of withEpley) {
      const key = x.entry.tempo ?? '';
      tempoCounts[key] = (tempoCounts[key] || 0) + 1;
    }
    const mostCommonKey = Object.entries(tempoCounts).sort((a, b) => b[1] - a[1])[0][0];
    targetTempo = mostCommonKey || null;
  }
  const workingWeight = targetWeightFor(avg1RM, targetReps);

  const sets = setPercentages(targetSets).map((pct, i) => ({
    setNumber: i + 1,
    weight: roundToIncrement(workingWeight * pct, unit),
    unit,
    label: pct < 1.0 ? 'warmup' : 'working',
  }));

  return {
    sets,
    targetReps,
    targetSets,
    targetTempo,
    estimated1RM: Math.round(avg1RM),
    unit,
    sourcedFrom: withEpley.map((x) => ({
      date: x.entry.performedAt,
      weight: parseFloat(x.entry.weight),
      reps: x.entry.reps,
      unit: x.entry.unit,
      tempo: x.entry.tempo ?? null,
    })),
  };
}
