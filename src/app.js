import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;
import { registerListeners } from './slack/listeners.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

registerListeners(app);

await app.start();
console.log('GymLog is running.');
