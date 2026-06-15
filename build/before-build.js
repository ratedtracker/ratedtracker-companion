const fs = require("fs");
const path = require("path");

// Writes generated-config.js from build-time env so the Google OAuth client secret never
// lives in the public source repo. Empty string when the env var is absent (dev builds),
// in which case the built-in Google Drive client is simply unavailable.
module.exports = async function beforeBuild() {
  const out = path.join(__dirname, "..", "generated-config.js");
  const secret = process.env.RT_GOOGLE_CLIENT_SECRET || "";
  const body = "module.exports = { googleClientSecret: " + JSON.stringify(secret) + " };\n";
  fs.writeFileSync(out, body);
  return true;
};
