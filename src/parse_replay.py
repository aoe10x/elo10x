import sys
import json
import os
from mgz.summary import Summary

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}), file=sys.stderr)
        sys.exit(1)
        
    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(json.dumps({"error": f"File does not exist: {filepath}"}), file=sys.stderr)
        sys.exit(1)
        
    try:
        with open(filepath, 'rb') as f:
            summary = Summary(f)
            
            # Platform details
            try:
                platform = summary.get_platform()
            except Exception:
                platform = {}
                
            # Lobby name
            lobby_name = platform.get('lobby_name') or ""
            
            # Match ID (guid)
            match_id = platform.get('platform_match_id')
            
            # Map name
            map_name = ""
            try:
                map_info = summary.get_map()
                if isinstance(map_info, dict):
                    map_name = map_info.get('name') or ""
                else:
                    map_name = str(map_info)
            except Exception:
                pass
                
            # Played / Duration
            played = 0
            try:
                played_val = summary.get_played()
                if played_val:
                    played = int(played_val)
            except Exception:
                pass
                
            duration = 0
            try:
                dur_val = summary.get_duration()
                if dur_val:
                    duration = int(dur_val / 1000) # Convert ms to seconds
            except Exception:
                pass
                
            # Teams mapping
            teams_mapping = {}
            try:
                teams = summary.get_teams()
                for team_index, player_numbers in enumerate(teams):
                    for num in player_numbers:
                        teams_mapping[num] = team_index
            except Exception:
                pass

            # Players
            players = []
            try:
                for p in summary.get_players():
                    p_num = p.get('number')
                    team_id = teams_mapping.get(p_num)
                    players.append({
                        "profile_id": p.get('user_id'),
                        "alias": p.get('name'),
                        "civ_id": p.get('civilization'),
                        "team_id": team_id,
                        "winner": p.get('winner')
                    })
            except Exception:
                pass
                
            output = {
                "match_id": match_id,
                "lobby_name": lobby_name,
                "map_name": map_name,
                "start_time": played,
                "duration": duration,
                "players": players
            }
            print(json.dumps(output))
            sys.exit(0)
    except Exception as e:
        print(json.dumps({"error": f"Failed to parse replay: {str(e)}"}), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
