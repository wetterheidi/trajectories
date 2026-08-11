"""Unit tests for OmReaderCache tickets / invalidation."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from trajectories.om_reader_cache import (
    OmReaderCache,
    SlabStaleError,
    clear_om_reader_cache,
)


def test_ticket_stale_on_invalidate(tmp_path):
    clear_om_reader_cache()
    path = tmp_path / "chunk_0.om"
    path.write_bytes(b"x")

    cache = OmReaderCache(max_readers=8)
    fake_reader = MagicMock()
    fake_reader.__getitem__ = MagicMock(return_value=1.0)
    fake_reader.close = MagicMock()
    cache._OmFileReader = MagicMock(return_value=fake_reader)

    # Bypass real omfiles: inject entry via get after mocking opener
    tid = cache.begin_ticket()
    # Manually register path on ticket then invalidate
    with cache._lock:
        cache._active_tickets[tid].add(str(path.resolve()))
    cache.invalidate(str(path))
    assert cache.ticket_stale(tid)
    with pytest.raises(SlabStaleError):
        cache.check_ticket(tid)
    cache.end_ticket(tid)
    cache.close()


def test_lru_eviction(tmp_path):
    clear_om_reader_cache()
    # OmReaderCache floors max_readers at 8
    cache = OmReaderCache(max_readers=8)
    # Disable inotify so sibling file creates don't race with LRU assertions
    if cache._observer is not None:
        cache._observer.stop()
        cache._observer.join(timeout=2)
        cache._observer = None
        cache._handler = None
    readers = []

    def make_reader(_p):
        r = MagicMock()
        r.close = MagicMock()
        r.shape = (10, 10, 5)
        readers.append(r)
        return r

    cache._OmFileReader = make_reader
    paths = []
    for i in range(9):
        p = tmp_path / f"c{i}.om"
        p.write_bytes(b"x")
        paths.append(p)
        cache.get(str(p))
    assert cache.size == 8
    # paths[0] is LRU and must have been closed/evicted
    assert readers[0].close.called
    for r in readers[1:]:
        assert not r.close.called
    # Re-requesting paths[0] creates a new reader (and evicts paths[1])
    n_before = len(readers)
    cache.get(str(paths[0]))
    assert len(readers) == n_before + 1
    assert readers[1].close.called
    cache.close()
