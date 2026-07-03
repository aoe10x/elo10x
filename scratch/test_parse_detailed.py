"""Extended test - parses all files and shows save versions + errors."""
import os
import glob
import struct
import zlib
from mgz.summary import Summary

def get_raw_save_version(filepath):
    """Try to get save_version by reading the file header bytes."""
    with open(filepath, 'rb') as f:
        raw = f.read(20)
    # Attempt to figure out the magic header
    # AoE2 files: first 4 bytes = compressed length, then chapter_pos(4), then data
    comp_len = struct.unpack('<I', raw[0:4])[0]
    # skip 4 bytes
    return comp_len

def test_all_files():
    pattern = "C:/Users/pauli/Games/Age of Empires 2 DE/76561198024935383/savegame/*.aoe2record"
    files = sorted(glob.glob(pattern))[:50]
    print(f"Testing {len(files)} files")
    
    success = 0
    failure = 0
    
    for fpath in files:
        fname = os.path.basename(fpath)
        try:
            with open(fpath, 'rb') as f:
                s = Summary(f)
                pf = s.get_platform()
                sv = pf.get('save_version') if pf else '?'
                players = s.get_players()
                print(f"OK sv={sv} | p={len(players)} | {fname}")
                success += 1
        except Exception as e:
            err = str(e)
            # Truncate error message
            if len(err) > 120:
                err = err[:120] + '...'
            print(f"FAIL | {fname} | {err}")
            failure += 1
    
    print(f"\nTotal: {success} succeeded, {failure} failed")

if __name__ == '__main__':
    test_all_files()
