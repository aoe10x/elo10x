"""Check save versions of local .aoe2record files."""
import glob
import os
import struct
import zlib
import io

def get_save_version(filepath):
    """Extract save_version from a replay file header."""
    with open(filepath, 'rb') as f:
        # mgz header format:
        # 4 bytes: header_len (uncompressed size)
        # 4 bytes: chapter_pos
        # Then zlib-compressed data (with -15 wbits, raw deflate)
        header_len = struct.unpack('<I', f.read(4))[0]
        # skip the next 4 bytes (chapter pos or similar)
        f.read(4)
        compressed = f.read(header_len - 8)
        try:
            data = zlib.decompress(compressed, wbits=-15)
        except Exception:
            # Try alternative: maybe first 8 bytes are different
            f.seek(0)
            f.read(4)
            f.read(4)
            compressed = f.read()
            data = zlib.decompress(compressed, wbits=-15)
        
        # save_version is a Float32l at offset 0 in the decompressed data
        if len(data) >= 4:
            sv = struct.unpack('<f', data[0:4])[0]
            return sv
    return None

def main():
    pattern = "C:/Users/pauli/Games/Age of Empires 2 DE/76561198024935383/savegame/*.aoe2record"
    files = glob.glob(pattern)
    print(f"Found {len(files)} files")
    
    versions = {}
    errors = []
    
    for f in files[:50]:
        try:
            sv = get_save_version(f)
            key = f"{sv:.2f}" if sv else "unknown"
            versions[key] = versions.get(key, 0) + 1
        except Exception as e:
            errors.append(f"{os.path.basename(f)}: {e}")
    
    print("\nSave version distribution:")
    for v, count in sorted(versions.items(), key=lambda x: float(x[0]) if x[0] != 'unknown' else 0):
        print(f"  {v}: {count} files")
    
    if errors:
        print(f"\nErrors ({len(errors)}):")
        for e in errors[:10]:
            print(f"  {e}")

    # Also try using mgz directly
    print("\n--- Using mgz directly on first 10 files ---")
    try:
        from mgz.header import parse_replay
        for f in files[:10]:
            try:
                with open(f, 'rb') as fh:
                    header, _, _, version = parse_replay(fh)
                    print(f"  {os.path.basename(f)}: save_version={version}")
            except Exception as e:
                print(f"  ERR {os.path.basename(f)}: {e}")
    except ImportError as ie:
        print(f"  Could not import parse_replay: {ie}")
        # Try mgz.util approach
        try:
            import mgz
            from mgz.summary import Summary
            for f in files[:5]:
                try:
                    with open(f, 'rb') as fh:
                        s = Summary(fh)
                        # Try to access header internals
                        header = s._header
                        sv = getattr(header, 'save_version', None)
                        de = getattr(header, 'de', None)
                        print(f"  {os.path.basename(f)}: save_version={sv}")
                except Exception as e:
                    print(f"  ERR {os.path.basename(f)}: {e}")
        except Exception as e2:
            print(f"  Also failed: {e2}")

if __name__ == '__main__':
    main()
