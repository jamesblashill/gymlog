import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  unique,
  boolean,
} from 'drizzle-orm/pg-core';

// entry_type values: 'set' | 'challenge'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  slackUserId: text('slack_user_id').notNull().unique(),
  defaultUnit: text('default_unit').notNull().default('lb'),
  timezone: text('timezone').notNull().default('UTC'),
  isCoach: boolean('is_coach').notNull().default(false),
});

export const exercises = pgTable('exercises', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  canonicalName: text('canonical_name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const exerciseAliases = pgTable(
  'exercise_aliases',
  {
    id: serial('id').primaryKey(),
    exerciseId: integer('exercise_id')
      .notNull()
      .references(() => exercises.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    aliasText: text('alias_text').notNull(),
    normalizedAliasText: text('normalized_alias_text').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [unique('unique_user_alias').on(t.userId, t.normalizedAliasText)],
);

export const workoutEntries = pgTable('workout_entries', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  exerciseId: integer('exercise_id')
    .notNull()
    .references(() => exercises.id),
  rawExerciseText: text('raw_exercise_text').notNull(),
  rawMessage: text('raw_message').notNull(),
  weight: numeric('weight', { precision: 8, scale: 2 }).notNull(),
  reps: integer('reps').notNull(),
  unit: text('unit').notNull(),
  tempo: text('tempo'),
  entryType: text('entry_type').notNull().default('set'),
  durationMinutes: numeric('duration_minutes', { precision: 6, scale: 2 }),
  performedAt: timestamp('performed_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const reminderSchedules = pgTable('reminder_schedules', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  daysOfWeek: jsonb('days_of_week').notNull(), // array of 0-6 (0=Sun)
  hour: integer('hour').notNull(),             // 0-23 in user's timezone
  minute: integer('minute').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const weeklyPrograms = pgTable('weekly_programs', {
  id: serial('id').primaryKey(),
  coachUserId: integer('coach_user_id').notNull().references(() => users.id),
  weekStartDate: text('week_start_date').notNull(), // 'YYYY-MM-DD' (Monday of the week)
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const weeklyProgramExercises = pgTable('weekly_program_exercises', {
  id: serial('id').primaryKey(),
  programId: integer('program_id').notNull().references(() => weeklyPrograms.id),
  exerciseName: text('exercise_name').notNull(),
  targetReps: integer('target_reps'),
  tempo: text('tempo'),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Holds in-flight entries waiting for user to pick / confirm an exercise
export const pendingEntries = pgTable('pending_entries', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  rawMessage: text('raw_message').notNull(),
  rawExerciseText: text('raw_exercise_text').notNull(),
  weight: numeric('weight', { precision: 8, scale: 2 }).notNull(),
  reps: integer('reps').notNull(),
  unit: text('unit').notNull(),
  tempo: text('tempo'),
  entryType: text('entry_type').notNull().default('set'),
  durationMinutes: numeric('duration_minutes', { precision: 6, scale: 2 }),
  performedAt: timestamp('performed_at').notNull(),
  candidateMatches: jsonb('candidate_matches').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
