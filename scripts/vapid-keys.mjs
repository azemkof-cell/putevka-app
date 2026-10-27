// Prints a new VAPID key pair for Web Push. Put the lines into .env once; changing the keys later
// silently cuts off every device that already turned notifications on.
import { generateVapidKeys } from '../src/push.js';

const k = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\nVAPID_SUBJECT=mailto:support@ваш-домен`);
