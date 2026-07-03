import os
import glob
from mgz.summary import Summary

def test_summary():
    files = glob.glob("C:/Users/pauli/Games/Age of Empires 2 DE/76561198024935383/savegame/*.aoe2record")
    print(f"Found {len(files)} files.")
    
    success = 0
    fail = 0
    ten_x = 0
    fail_reasons = {}
    
    for fpath in files:
        filename = os.path.basename(fpath)
        try:
            with open(fpath, 'rb') as f:
                summary = Summary(f)
                
                # Check lobby name
                platform = summary.get_platform()
                lobby_name = platform.get('lobby_name') or ""
                
                # Check map
                map_info = summary.get_map()
                map_name = map_info.get('name') if isinstance(map_info, dict) else str(map_info)
                
                # Check players
                players = summary.get_players()
                
                is_10x = "10x" in lobby_name.lower()
                if is_10x:
                    ten_x += 1
                    
                success += 1
        except Exception as e:
            fail += 1
            reason = str(e)
            # truncate/normalize long error messages
            if "expected" in reason and "parsed" in reason:
                reason = "construct.core.ConstError/RangeError (version mismatch/new format)"
            elif "expected" in reason:
                reason = "Construct expected value error"
            elif "RangeError" in reason:
                reason = "Construct RangeError"
            fail_reasons[reason] = fail_reasons.get(reason, 0) + 1
            
    print("\n--- RESULTS ---")
    print(f"Parsed successfully: {success}")
    print(f"Failed to parse: {fail}")
    print(f"Found 10x games: {ten_x}")
    print("\n--- FAILURE REASONS ---")
    for r, count in fail_reasons.items():
        print(f"  {count} files: {r}")

if __name__ == '__main__':
    test_summary()
