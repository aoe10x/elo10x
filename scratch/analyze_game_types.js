import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve path to db.json
const dbPath = path.join(__dirname, '..', 'data', 'db.json');

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const matches = Object.values(db.matches || {});
const totalMatches = matches.length;

// Filter matches with exactly 8 players
const eightPlayerMatches = matches.filter(m => m.players && m.players.length === 8);
const totalEightPlayerMatches = eightPlayerMatches.length;

// Classification logic for game types
function classifyMatch(match) {
  const desc = (match.description || '').toLowerCase();
  const map = (match.mapname || '').toLowerCase();
  const combined = `${desc} | ${map}`;

  const has10x = combined.includes('10x');
  const has3x = combined.includes('3x');
  const has10x3x = combined.includes('10x3x') || (has10x && has3x);
  const has256x = combined.includes('256x');

  if (has10x3x) {
    return '10x3x';
  } else if (has256x) {
    return '256x';
  } else if (has10x && !has3x && !has256x) {
    return 'Plain 10x';
  } else {
    return 'Other';
  }
}

// Map name resolution logic
function resolveMapName(match) {
  const map = (match.mapname || '').toLowerCase();
  const desc = (match.description || '').toLowerCase();

  if (map.includes('bamboo') || desc.includes('bamboo') || desc.includes(' bn ') || desc.endsWith(' bn') || desc.includes('bn ') || desc.includes('3xbn')) {
    return 'Bamboo Nothing';
  }
  if (map.includes('forest nothing') || desc.includes('forest nothing') || desc.includes(' fn ') || desc.endsWith(' fn') || desc.includes('fn ') || desc.includes('forest')) {
    return 'Forest Nothing';
  }
  if (map.includes('wet woods') || desc.includes('wet woods')) {
    return 'Wet Woods';
  }
  if (map.includes('twin bays') || desc.includes('twin bays')) {
    return 'Amazon Tunnel Twin Bays';
  }
  if (map.includes('amazon') || desc.includes('amazon')) {
    return 'Amazon Tunnel';
  }
  if (map.includes('michi') || desc.includes('michi')) {
    return 'Michi';
  }
  if (map.includes('black forest') || desc.includes('black forest') || desc.includes(' bf ') || desc.endsWith(' bf') || desc.includes('bf ')) {
    return 'Black Forest';
  }
  if (map.includes('everything nothing') || desc.includes('everything nothing') || desc.includes('en ')) {
    return 'Everything Nothing';
  }
  if (map.includes('ring of fire') || desc.includes('ring of fire') || desc.includes(' rf ') || desc.endsWith(' rf') || desc.includes('rf ')) {
    return 'Ring of Fire';
  }
  if (map.includes('arabia') || desc.includes('arabia')) {
    return 'Arabia';
  }
  if (map === 'my map') {
    return 'Custom Map (Unspecified)';
  }
  return match.mapname || 'Unknown';
}

// Group and analyze
const typeCounts = {
  '10x3x': 0,
  '256x': 0,
  'Plain 10x': 0,
  'Other': 0
};

const rawMapCounts = {};
const resolvedMapCounts = {};
const lobbyWords = {};

eightPlayerMatches.forEach(m => {
  const type = classifyMatch(m);
  typeCounts[type]++;

  // Raw Map counts
  const rawMap = m.mapname || 'Unknown';
  rawMapCounts[rawMap] = (rawMapCounts[rawMap] || 0) + 1;

  // Resolved Map counts
  const resolvedMap = resolveMapName(m);
  resolvedMapCounts[resolvedMap] = (resolvedMapCounts[resolvedMap] || 0) + 1;

  // Description words
  const desc = m.description || '';
  const words = desc.toLowerCase().split(/[\s,._\-()!]+/);
  words.forEach(w => {
    if (w.length > 2) {
      lobbyWords[w] = (lobbyWords[w] || 0) + 1;
    }
  });
});

console.log('=== Game Analysis Results ===');
console.log(`Total Matches in DB: ${totalMatches}`);
console.log(`Total 8-Player Matches: ${totalEightPlayerMatches} (${((totalEightPlayerMatches/totalMatches)*100).toFixed(2)}%)`);

console.log('\n--- Game Type Breakdown ---');
Object.entries(typeCounts).forEach(([type, count]) => {
  const pct = ((count / totalEightPlayerMatches) * 100).toFixed(2);
  console.log(`- ${type}: ${count} matches (${pct}%)`);
});

console.log('\n--- Top 10 Raw Maps ---');
const sortedRawMaps = Object.entries(rawMapCounts).sort((a, b) => b[1] - a[1]);
sortedRawMaps.slice(0, 10).forEach(([map, count]) => {
  console.log(`- ${map}: ${count} matches`);
});

console.log('\n--- Top 10 Resolved Maps (Using Map & Lobby Desc) ---');
const sortedResolvedMaps = Object.entries(resolvedMapCounts).sort((a, b) => b[1] - a[1]);
sortedResolvedMaps.slice(0, 10).forEach(([map, count]) => {
  const pct = ((count / totalEightPlayerMatches) * 100).toFixed(2);
  console.log(`- ${map}: ${count} matches (${pct}%)`);
});

console.log('\n--- Top 20 Common Lobby Words (Excluding Stopwords) ---');
const stopWords = ['and', 'the', 'for', 'with', 'you', 'are', 'not', 'but', 'this', 'pls'];
const sortedWords = Object.entries(lobbyWords)
  .filter(([word]) => !stopWords.includes(word))
  .sort((a, b) => b[1] - a[1]);
sortedWords.slice(0, 20).forEach(([word, count]) => {
  console.log(`- ${word}: ${count}`);
});
