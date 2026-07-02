# GymLog

A Slack bot that acts as your personal lifting coach. DM it to log workouts, get weight recommendations, and track your progress — no app to install, no account to create.

## Logging lifts

Send a DM in natural language. The bot understands many ways to say the same thing:

| Example | What happens |
|---|---|
| `bench press 215x3` | Logs 215 lb × 3 reps |
| `bench press for 3 reps @ 215` | Same thing, different phrasing |
| `Feb 19 bench press for 3 reps @ 215` | Log with a specific date |
| `incline db curl 35x12` | Creates a new exercise if it doesn't exist yet |

## Weight recommendations

Ask for a recommendation and the bot calculates a target weight based on your recent history using the Epley formula across your last 5 entries.

| Example |
|---|
| `what should I bench for 10 reps?` |
| `what weight should I pick for bench press for 10 reps?` |

Results are rounded to the nearest 5 lb / 2.5 kg and given as a small range.

## Viewing history

| Example | What it shows |
|---|---|
| `show recent bench` | Your last several bench press entries |

## Undoing entries

| Example |
|---|
| `undo` |
| `delete last` |

## Smart exercise matching

You don't have to type exercise names exactly the same way every time. When you log a lift, GymLog checks if the exercise name matches something you've logged before — it'll map `"bench"` to `"Bench Press"` automatically.

When a name is genuinely ambiguous (e.g. you have both "Bench Press" and "Close Grip Bench Press"), the bot sends you buttons to pick which one you meant. Your choice is saved as an alias so you won't be asked again.

---

[Development setup →](DEVELOPMENT.md)
