// Import first in a check script that loads src/ modules: the checks run on the generic example household,
// never this Mac's private household.json (src/household.js), so they give the same answer on every machine.
process.env.ONTO_HOUSEHOLD = 'example';
