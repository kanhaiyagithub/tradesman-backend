const admin = require("firebase-admin");
const serviceAccount = require("../config/firebase-service-account.json");

try {
  if (serviceAccount && serviceAccount.project_id) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase Admin initialized successfully.");
  } else {
    console.warn("⚠️ Firebase Warning: config/firebase-service-account.json is missing 'project_id'. Push notifications will not work.");
  }
} catch (error) {
  console.error("❌ Firebase Initialization Error:", error.message);
  console.warn("⚠️ Push notifications are disabled in this session.");
}

module.exports = admin;