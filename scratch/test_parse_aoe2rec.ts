import {RecordingParser     } from  '../src/parse_replay_aoe2rec.ts';

import fs from 'fs';

const parser = new RecordingParser();


const file = "C:\\Users\\pauli\\Games\\Age of Empires 2 DE\\76561198024935383\\savegame\\MP Replay v101.103.48086.0 @2026.07.02 174815 (1).aoe2record"

const buffer = fs.readFileSync(file).buffer;
const parsed = await parser.parse(buffer, file);


console.log(parsed);