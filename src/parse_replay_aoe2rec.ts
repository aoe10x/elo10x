import { parse_rec_summary } from "aoe2rec-js";
import { CIV_NAMES, MAP_NAMES } from "./civ-data.ts";
import type { ParsedRecording } from "./types.ts";

// ─── RecordingParser ──────────────────────────────────────────────────────────

export class RecordingParser {
  /** Parses a .aoe2record file using aoe2rec-js. */
  async parse(buffer: ArrayBuffer, fileName: string): Promise<ParsedRecording> {

    const summary = parse_rec_summary(buffer);

    console.log(`[aoe2rec-js] "${fileName}"`, {
      duration_raw: summary.duration,
      world_time: summary.header.replay.world_time,
      old_world_time: summary.header.replay.old_world_time,
      timestamp: summary.header.timestamp,
      map_resolved_id: summary.header.game_settings.resolved_map_id,
      map_selected_id: summary.header.game_settings.selected_map_id,
      rms_strings: summary.header.game_settings.rms_strings,
      replay: {
        game_mode: summary.header.replay.game_mode,
        game_speed: summary.header.replay.game_speed,
        num_players: summary.header.replay.num_players,
        timer: summary.header.replay.timer,
        world_time: summary.header.replay.world_time,
      },
      teams: summary.teams.map((team, i) => ({
        team: i,
        winner: team.winner,
        players: team.players.map((p) => ({
          name: p.name,
          player_number: p.player_number,
          civ_id: p.civ_id,
          profile_id: p.profile_id,
          resigned: p.resigned,
          color_id: p.color_id,
          resolved_team_id: p.resolved_team_id,
          selected_team_id: p.selected_team_id,
        })),
      })),
    });

    const team0 = summary.teams[0];
    const team1 = summary.teams[1];
    const p1 = team0?.players[0];
    const p2 = team1?.players[0];

    const winner: 1 | 2 | null = team0?.winner ? 1 : team1?.winner ? 2 : null;

    const mapId = summary.header.game_settings.resolved_map_id;
    const timestamp = summary.header.timestamp;

    return {
      fileName,
      player1: p1?.name ?? "",
      player2: p2?.name ?? "",
      profileId1: p1?.profile_id ?? 0,
      profileId2: p2?.profile_id ?? 0,
      civ1: CIV_NAMES[p1?.civ_id ?? -1] ?? `Civ #${p1?.civ_id ?? "?"}`,
      civ2: CIV_NAMES[p2?.civ_id ?? -1] ?? `Civ #${p2?.civ_id ?? "?"}`,
      civId1: p1?.civ_id ?? 0,
      civId2: p2?.civ_id ?? 0,
      map: MAP_NAMES[mapId] ?? `Map #${mapId}`,
      mapId,
      length: formatDurationMs(summary.duration),
      date: timestamp
        ? new Date(timestamp * 1000).toISOString().slice(0, 10)
        : "",
      winner,
      // aoe2rec-js does not expose a game GUID.
      // Empty guid tells validateRestoredGame to skip the guid-match check.
      guid: "",
      restored: true,
    };
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatDurationMs(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}