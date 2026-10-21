const present = (name) => Boolean(process.env[name]);
const appleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const apiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

// Match electron-builder 25.1.8 selection order, including partial-set blockers.
let selected;
if (present('APPLE_ID') || present('APPLE_APP_SPECIFIC_PASSWORD')) {
  selected = ['Apple ID', appleId];
} else if (apiKey.some(present)) {
  selected = ['App Store Connect API key', apiKey];
} else if (present('APPLE_KEYCHAIN_PROFILE')) {
  selected = ['Keychain profile', ['APPLE_KEYCHAIN_PROFILE']];
}

if (!selected) {
  console.log('not configured, notarization will be skipped');
} else {
  const [label, names] = selected;
  const missing = names.filter((name) => !present(name));
  console.log(missing.length
    ? `${label}: incomplete; missing ${missing.join(', ')}; electron-builder may fail notarization configuration`
    : `${label}: credential set present (not validated)`);
}

process.exitCode = 0;
