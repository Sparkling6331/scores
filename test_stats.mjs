// Smoke test script (Node.js). Optional, peut être supprimé.
// Usage: `node test_stats.mjs` depuis ce dossier.
import * as stats from './stats.js';
import { readFileSync } from 'node:fs';
const db = JSON.parse(readFileSync('./seed.json', 'utf-8'));
const players = Object.fromEntries(db.players.map(p => [p.id, p.name]));
const k = stats.playerKpis(db, {});
const rows = Object.entries(k).map(([pid, s]) => ({
  name: players[pid], played: s.played, wins: s.wins,
  rate: (s.winRate * 100).toFixed(0) + '%', avg: s.avg.toFixed(1),
}));
rows.sort((a, b) => b.wins - a.wins);
console.table(rows);
