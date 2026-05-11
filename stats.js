// stats.js — derive statistics from db.matches
// All functions take the db and return plain data (no DOM).

export function totalsOfMatch(match) {
  const totals = {};
  for (const r of match.rounds) {
    for (const [pid, sc] of Object.entries(r.scores)) {
      if (sc == null) continue;
      totals[pid] = (totals[pid] || 0) + Number(sc);
    }
  }
  return totals;
}

export function winnersOfMatch(match, game) {
  const totals = totalsOfMatch(match);
  const ids = match.playerIds.filter(p => p in totals);
  if (!ids.length) return [];
  const vals = ids.map(p => totals[p]);
  const best = game.scoreDir === 'low' ? Math.min(...vals) : Math.max(...vals);
  return ids.filter(p => totals[p] === best);
}

function withinPeriod(iso, days) {
  if (!days || days === 'all') return true;
  const t = new Date(iso).getTime();
  return (Date.now() - t) <= days * 86400000;
}

export function filteredMatches(db, { gameId, periodDays } = {}) {
  return db.matches.filter(m => {
    if (m.status !== 'finished') return false;
    if (gameId && m.gameId !== gameId) return false;
    if (periodDays && !withinPeriod(m.endedAt || m.startedAt, periodDays)) return false;
    return true;
  });
}

export function playerKpis(db, { gameId, periodDays } = {}) {
  const games = Object.fromEntries(db.games.map(g => [g.id, g]));
  const matches = filteredMatches(db, { gameId, periodDays });
  const stats = {}; // pid -> { played, wins, sumTotal, best, worst, history: [{date, total, won, gameId}] }

  for (const m of matches) {
    const game = games[m.gameId]; if (!game) continue;
    const totals = totalsOfMatch(m);
    const winners = winnersOfMatch(m, game);
    for (const pid of m.playerIds) {
      if (!(pid in totals)) continue;
      const t = totals[pid];
      const s = stats[pid] || (stats[pid] = {
        played: 0, wins: 0, sumTotal: 0, best: null, worst: null, history: [], byGame: {},
      });
      s.played++;
      const won = winners.includes(pid);
      if (won) s.wins++;
      s.sumTotal += t;
      const better = game.scoreDir === 'low' ? (s.best == null || t < s.best) : (s.best == null || t > s.best);
      const worse  = game.scoreDir === 'low' ? (s.worst == null || t > s.worst) : (s.worst == null || t < s.worst);
      if (better) s.best = t;
      if (worse)  s.worst = t;
      s.history.push({ date: m.endedAt || m.startedAt, total: t, won, gameId: m.gameId });
      const bg = s.byGame[m.gameId] || (s.byGame[m.gameId] = { played: 0, wins: 0 });
      bg.played++; if (won) bg.wins++;
    }
  }
  for (const s of Object.values(stats)) {
    s.avg = s.played ? s.sumTotal / s.played : 0;
    s.winRate = s.played ? s.wins / s.played : 0;
    s.history.sort((a, b) => a.date.localeCompare(b.date));
  }
  return stats;
}

export function podium(db, gameId, periodDays) {
  // Top 3 winners by # of wins for a given game
  const stats = playerKpis(db, { gameId, periodDays });
  const arr = Object.entries(stats).map(([pid, s]) => ({ pid, wins: s.wins, played: s.played, rate: s.winRate }));
  arr.sort((a, b) => b.wins - a.wins || b.rate - a.rate || b.played - a.played);
  return arr.slice(0, 3);
}

export function headToHead(db, { gameId, periodDays } = {}) {
  // pid -> pid -> { wins, ties, losses, played }
  const games = Object.fromEntries(db.games.map(g => [g.id, g]));
  const matches = filteredMatches(db, { gameId, periodDays });
  const h2h = {};
  function ensure(a, b) {
    h2h[a] = h2h[a] || {};
    h2h[a][b] = h2h[a][b] || { wins: 0, ties: 0, losses: 0, played: 0 };
    return h2h[a][b];
  }
  for (const m of matches) {
    const game = games[m.gameId]; if (!game) continue;
    const totals = totalsOfMatch(m);
    const players = m.playerIds.filter(p => p in totals);
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const a = players[i], b = players[j];
        const ta = totals[a], tb = totals[b];
        const ea = ensure(a, b), eb = ensure(b, a);
        ea.played++; eb.played++;
        if (ta === tb) { ea.ties++; eb.ties++; }
        else if ((game.scoreDir === 'low' && ta < tb) || (game.scoreDir === 'high' && ta > tb)) {
          ea.wins++; eb.losses++;
        } else { ea.losses++; eb.wins++; }
      }
    }
  }
  return h2h;
}

export function evolution(db, pid, { gameId, periodDays } = {}, bucketDays = 30) {
  // Returns [{ bucket: Date(iso), avgTotal, wins, played, rate }] over time
  const matches = filteredMatches(db, { gameId, periodDays }).filter(m => m.playerIds.includes(pid));
  const games = Object.fromEntries(db.games.map(g => [g.id, g]));
  const points = [];
  for (const m of matches) {
    const totals = totalsOfMatch(m);
    if (!(pid in totals)) continue;
    const game = games[m.gameId];
    const winners = winnersOfMatch(m, game);
    points.push({
      date: m.endedAt || m.startedAt,
      total: totals[pid],
      won: winners.includes(pid),
    });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}
