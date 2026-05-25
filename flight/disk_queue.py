"""
Persistent FIFO disk queue for store-and-forward message handling during network outages.
Survives process restarts and power loss via atomic file operations (tmp+rename), 
and guarantees ordered delivery with granular message ACK/removal.
"""

import json
import os
import threading
from pathlib import Path
from typing import Dict, List, Optional, Any


class DiskQueue:
    

    def __init__(self, queue_dir: str, max_depth: int = 10000):
       
        self._queue_dir = Path(queue_dir)
        self._max_depth = max_depth
        self._lock = threading.Lock()

        # Ensure directory exists
        self._queue_dir.mkdir(parents=True, exist_ok=True)

    # Public Interface — IDiskQueue

    def enqueue(self, msg: Dict[str, Any]) -> None:
       
        if "seq_id" not in msg:
            raise ValueError("Message must contain 'seq_id' key")

        seq_id = int(msg["seq_id"])

        with self._lock:
            # Overflow protection: drop oldest if at capacity
            if self._count_locked() >= self._max_depth:
                self._drop_oldest_locked()

            # Atomic write: tmp file → rename
            final_path = self._queue_dir / f"{seq_id:06d}.json"
            tmp_path = self._queue_dir / f"{seq_id:06d}.json.tmp"

            data = json.dumps(msg, separators=(",", ":"))
            with open(tmp_path, "w", encoding="utf-8") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())

            os.rename(str(tmp_path), str(final_path))

    def get_from(self, seq_id: int) -> List[Dict[str, Any]]:
      
        with self._lock:
            files = self._sorted_files_locked()
            results = []
            for f in files:
                file_seq = self._seq_from_filename(f.name)
                if file_seq is not None and file_seq >= seq_id:
                    msg = self._read_file(f)
                    if msg is not None:
                        results.append(msg)
            return results

    def remove_up_to(self, seq_id: int) -> int:
        
        with self._lock:
            files = self._sorted_files_locked()
            removed = 0
            for f in files:
                file_seq = self._seq_from_filename(f.name)
                if file_seq is not None and file_seq <= seq_id:
                    try:
                        f.unlink()
                        removed += 1
                    except OSError:
                        pass
            return removed

    def depth(self) -> int:
        with self._lock:
            return self._count_locked()

    def is_empty(self) -> bool:
        return self.depth() == 0

    def peek(self) -> Optional[Dict[str, Any]]:
        
        with self._lock:
            files = self._sorted_files_locked()
            if not files:
                return None
            return self._read_file(files[0])

    def clear(self) -> int:
        with self._lock:
            files = self._sorted_files_locked()
            removed = 0
            for f in files:
                try:
                    f.unlink()
                    removed += 1
                except OSError:
                    pass
            return removed

    # Internal Helpers (must hold self._lock)

    def _sorted_files_locked(self) -> List[Path]:
        try:
            files = [f for f in self._queue_dir.iterdir()
                     if f.suffix == ".json" and not f.name.endswith(".tmp")]
            files.sort(key=lambda f: f.name)
            return files
        except OSError:
            return []

    def _count_locked(self) -> int:
        return len(self._sorted_files_locked())

    def _drop_oldest_locked(self) -> None:
        files = self._sorted_files_locked()
        if files:
            try:
                files[0].unlink()
            except OSError:
                pass

    @staticmethod
    def _seq_from_filename(filename: str) -> Optional[int]:
        try:
            return int(filename.replace(".json", ""))
        except ValueError:
            return None

    @staticmethod
    def _read_file(path: Path) -> Optional[Dict[str, Any]]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.loads(f.read())
        except (OSError, json.JSONDecodeError):
            return None
