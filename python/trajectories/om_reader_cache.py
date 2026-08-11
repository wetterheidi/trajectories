"""Process-wide keep-open OmFileReader cache with per-path locks + inotify."""

from __future__ import annotations

import os
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

# Optional watchdog for inotify; mtime/inode fallback always works.
try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer

    _HAS_WATCHDOG = True
except ImportError:  # pragma: no cover
    FileSystemEventHandler = object  # type: ignore[misc, assignment]
    Observer = None  # type: ignore[misc, assignment]
    _HAS_WATCHDOG = False

DEFAULT_MAX_READERS = 128


class SlabStaleError(RuntimeError):
    """A cached .om file changed during an in-flight slab load."""


@dataclass
class _Entry:
    reader: Any
    lock: threading.Lock = field(default_factory=threading.Lock)
    mtime_ns: int = 0
    inode: int = 0


class _DirHandler(FileSystemEventHandler):  # type: ignore[misc]
    """Invalidate only on real content changes — ignore open/close/access."""

    def __init__(self, cache: "OmReaderCache"):
        super().__init__()
        self._cache = cache

    def _bump(self, event):  # noqa: ANN001
        if getattr(event, "is_directory", False):
            return
        for attr in ("src_path", "dest_path"):
            path = getattr(event, attr, None)
            if path:
                self._cache.invalidate(str(path))

    def on_modified(self, event):  # noqa: ANN001
        self._bump(event)

    def on_created(self, event):  # noqa: ANN001
        self._bump(event)

    def on_deleted(self, event):  # noqa: ANN001
        self._bump(event)

    def on_moved(self, event):  # noqa: ANN001
        self._bump(event)


class OmReaderCache:
    """
    LRU of open OmFileReader instances (local mmap paths).

    Thread safety: one reader per path; acquire ``entry.lock`` around reads.
    Parallelism is across different paths. Inotify (watchdog) invalidates
    only paths currently cached; mtime/inode revalidated on every get.
    """

    def __init__(self, *, max_readers: int = DEFAULT_MAX_READERS):
        self._max = max(8, int(max_readers))
        self._lock = threading.RLock()
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._OmFileReader = None
        # path -> set of LoadTicket ids that used it
        self._active_tickets: dict[int, set[str]] = {}
        self._ticket_stale: dict[int, bool] = {}
        self._next_ticket = 1
        # parent dir -> refcount of watched files under it
        self._dir_refs: dict[str, int] = {}
        self._observer = None
        self._handler = None
        if _HAS_WATCHDOG and Observer is not None:
            self._handler = _DirHandler(self)
            self._observer = Observer()
            self._observer.daemon = True
            self._observer.start()

    def _ensure_reader_cls(self):
        if self._OmFileReader is None:
            from omfiles import OmFileReader

            self._OmFileReader = OmFileReader
        return self._OmFileReader

    def begin_ticket(self) -> int:
        with self._lock:
            tid = self._next_ticket
            self._next_ticket += 1
            self._active_tickets[tid] = set()
            self._ticket_stale[tid] = False
            return tid

    def end_ticket(self, tid: int) -> None:
        with self._lock:
            self._active_tickets.pop(tid, None)
            self._ticket_stale.pop(tid, None)

    def ticket_stale(self, tid: int) -> bool:
        with self._lock:
            return bool(self._ticket_stale.get(tid))

    def check_ticket(self, tid: int) -> None:
        if self.ticket_stale(tid):
            raise SlabStaleError("OM file changed during slab load")

    def _stat(self, path: str) -> tuple[int, int]:
        st = os.stat(path)
        return int(st.st_mtime_ns), int(st.st_ino)

    def _watch_parent(self, path: str) -> None:
        if self._observer is None or self._handler is None:
            return
        parent = str(Path(path).resolve().parent)
        if parent not in self._dir_refs:
            try:
                self._observer.schedule(self._handler, parent, recursive=False)
            except Exception:
                return
            self._dir_refs[parent] = 0
        self._dir_refs[parent] += 1

    def _unwatch_parent(self, path: str) -> None:
        if self._observer is None:
            return
        parent = str(Path(path).resolve().parent)
        n = self._dir_refs.get(parent, 0) - 1
        if n <= 0:
            self._dir_refs.pop(parent, None)
            # watchdog has no easy unschedule-by-path; leave watch (cheap)
        else:
            self._dir_refs[parent] = n

    def _close_entry(self, path: str, entry: _Entry) -> None:
        try:
            entry.reader.close()
        except Exception:
            pass
        self._unwatch_parent(path)

    def invalidate(self, path: str) -> None:
        try:
            from .om_backend import clear_om_slab_cache

            clear_om_slab_cache()
        except Exception:
            pass
        try:
            key = str(Path(path).resolve())
        except Exception:
            key = str(path)
        candidates = {key, str(path), os.path.abspath(path)}
        with self._lock:
            for p in list(self._entries):
                if p in candidates or os.path.abspath(p) in candidates:
                    entry = self._entries.pop(p)
                    self._close_entry(p, entry)
            for tid, paths in self._active_tickets.items():
                if paths & candidates or any(
                    os.path.abspath(x) in candidates for x in paths
                ):
                    self._ticket_stale[tid] = True

    def get(self, path: str, *, ticket: int | None = None) -> _Entry:
        """Return cache entry; caller must hold ``entry.lock`` while reading."""
        key = str(Path(path).resolve())
        OmFileReader = self._ensure_reader_cls()
        with self._lock:
            if ticket is not None and ticket in self._active_tickets:
                self._active_tickets[ticket].add(key)
                if self._ticket_stale.get(ticket):
                    raise SlabStaleError("OM file changed during slab load")

            entry = self._entries.get(key)
            if entry is not None:
                try:
                    mtime_ns, inode = self._stat(key)
                except OSError:
                    self._entries.pop(key, None)
                    self._close_entry(key, entry)
                    entry = None
                else:
                    if mtime_ns != entry.mtime_ns or inode != entry.inode:
                        self._entries.pop(key)
                        self._close_entry(key, entry)
                        entry = None
                    else:
                        self._entries.move_to_end(key)
                        return entry

            mtime_ns, inode = self._stat(key)
            reader = OmFileReader(key)
            entry = _Entry(reader=reader, mtime_ns=mtime_ns, inode=inode)
            self._entries[key] = entry
            self._watch_parent(key)
            while len(self._entries) > self._max:
                old_p, old_e = self._entries.popitem(last=False)
                self._close_entry(old_p, old_e)
            return entry

    def read_array(self, path: str, indexer, *, ticket: int | None = None):
        """Thread-safe slice read from a cached reader."""
        entry = self.get(path, ticket=ticket)
        with entry.lock:
            if ticket is not None:
                self.check_ticket(ticket)
            # Re-check identity under lock
            try:
                mtime_ns, inode = self._stat(str(Path(path).resolve()))
            except OSError as exc:
                raise SlabStaleError(str(exc)) from exc
            if mtime_ns != entry.mtime_ns or inode != entry.inode:
                self.invalidate(path)
                raise SlabStaleError(f"stale reader: {path}")
            return entry.reader[indexer]

    def clear(self) -> None:
        with self._lock:
            for p, e in list(self._entries.items()):
                self._close_entry(p, e)
            self._entries.clear()

    def close(self) -> None:
        self.clear()
        if self._observer is not None:
            try:
                self._observer.stop()
                self._observer.join(timeout=2)
            except Exception:
                pass
            self._observer = None

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._entries)


_CACHE_LOCK = threading.Lock()
_CACHE: OmReaderCache | None = None


def get_om_reader_cache() -> OmReaderCache:
    global _CACHE
    with _CACHE_LOCK:
        if _CACHE is None:
            max_r = int(os.environ.get("TRAJECTORIES_OM_READER_CACHE", DEFAULT_MAX_READERS))
            _CACHE = OmReaderCache(max_readers=max_r)
        return _CACHE


def clear_om_reader_cache() -> None:
    global _CACHE
    with _CACHE_LOCK:
        if _CACHE is not None:
            _CACHE.close()
            _CACHE = None
