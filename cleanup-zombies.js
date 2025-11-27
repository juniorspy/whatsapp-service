// One-time cleanup script for zombie messages in /respuestas/
// Run with: node cleanup-zombies.js

import admin from 'firebase-admin';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// Load Firebase credentials
const serviceAccount = JSON.parse(
  fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT || './serviceAccount.json', 'utf-8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();

async function cleanupZombieMessages() {
  console.log('🧹 Starting zombie message cleanup...');

  const respuestasRef = db.ref('/respuestas');
  const snapshot = await respuestasRef.once('value');

  if (!snapshot.exists()) {
    console.log('✅ No /respuestas/ node exists. Nothing to clean.');
    process.exit(0);
  }

  const respuestas = snapshot.val();
  let cleanedCount = 0;
  let totalCount = 0;

  for (const slug in respuestas) {
    for (const chatId in respuestas[slug]) {
      for (const responseId in respuestas[slug][chatId]) {
        totalCount++;
        const response = respuestas[slug][chatId][responseId];

        // Delete if already sent (zombie)
        if (response.enviado === true) {
          console.log(`🧹 Deleting zombie: ${slug}/${chatId}/${responseId}`);
          await db.ref(`/respuestas/${slug}/${chatId}/${responseId}`).remove();
          cleanedCount++;
        }

        // Delete if invalid (no text)
        else if (!response.text || typeof response.text !== 'string') {
          console.log(`❌ Deleting invalid: ${slug}/${chatId}/${responseId}`);
          await db.ref(`/respuestas/${slug}/${chatId}/${responseId}`).remove();
          cleanedCount++;
        }
      }
    }
  }

  console.log(`\n✅ Cleanup complete!`);
  console.log(`   Total messages found: ${totalCount}`);
  console.log(`   Zombie/invalid deleted: ${cleanedCount}`);
  console.log(`   Remaining valid: ${totalCount - cleanedCount}`);

  process.exit(0);
}

cleanupZombieMessages().catch(err => {
  console.error('❌ Cleanup failed:', err);
  process.exit(1);
});
