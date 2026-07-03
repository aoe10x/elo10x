import os
import glob
from mgz.summary import Summary

def test_all():
    files = glob.glob("C:/Users/pauli/Games/Age of Empires 2 DE/76561198024935383/savegame/*.aoe2record")
    print(f"Found {len(files)} files.")
    
    success_count = 0
    failure_count = 0
    
    for fpath in files[:20]: # Test first 20 files
        filename = os.path.basename(fpath)
        try:
            with open(fpath, 'rb') as f:
                summary = Summary(f)
                map_name = summary.get_map()
                players = summary.get_players()
                platform = summary.get_platform()
                lobby_name = platform.get('lobby_name')
                print(f"SUCCESS: {filename} | Map: {map_name} | Lobby: {lobby_name} | Players: {len(players)}")
                success_count += 1
        except Exception as e:
            print(f"FAILED: {filename} | Error: {e}")
            failure_count += 1
            
    print(f"Total: {success_count} succeeded, {failure_count} failed.")

if __name__ == '__main__':
    test_all()
