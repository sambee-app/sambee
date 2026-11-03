"""Wait for owned workers without creating abandoned shield futures."""

import asyncio
from typing import TypeVar

WorkerResult = TypeVar("WorkerResult")


async def wait_for_worker(future: asyncio.Future[WorkerResult], timeout: float | None = None) -> WorkerResult:
    """Leave cancellation and late-result disposal to the worker's owner."""
    completed, _ = await asyncio.wait((future,), timeout=timeout)
    if not completed:
        raise TimeoutError("Worker is still running after the caller timeout")
    return future.result()
