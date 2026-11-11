"""Operation summaries without headers, file paths, or message payloads."""

import logging
import uuid
from time import monotonic

from starlette import status
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging import websocket_log_context

MILLISECONDS_PER_SECOND = 1000
BROWSE_API_PREFIX = "/api/browse/"
operation_logger = logging.getLogger("app.operations")
websocket_logger = logging.getLogger("app.protocol.websocket")


class OperationSummaryMiddleware:
    """Count WebSocket traffic and report completed browser operations."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            await self._websocket(scope, receive, send)
        elif scope["type"] == "http" and scope["path"].startswith(BROWSE_API_PREFIX) and operation_logger.isEnabledFor(logging.DEBUG):
            await self._operation(scope, receive, send)
        else:
            await self.app(scope, receive, send)

    async def _operation(self, scope: Scope, receive: Receive, send: Send) -> None:
        started = monotonic()
        response_status = status.HTTP_500_INTERNAL_SERVER_ERROR
        error_type: str | None = None

        async def send_summary(message: Message) -> None:
            nonlocal response_status
            await send(message)
            if message["type"] == "http.response.start":
                response_status = message["status"]

        try:
            await self.app(scope, receive, send_summary)
        except BaseException as error:
            error_type = type(error).__name__
            raise
        finally:
            source_id = scope.get("path_params", {}).get("connection_id")
            if source_id is not None:
                operation_logger.debug(
                    "event=storage_operation operation=%r source_id=%r status=%s duration_ms=%.1f outcome=%s error_type=%r",
                    getattr(scope.get("endpoint"), "__name__", "request"),
                    str(source_id),
                    response_status,
                    (monotonic() - started) * MILLISECONDS_PER_SECOND,
                    "success" if error_type is None and response_status < status.HTTP_400_BAD_REQUEST else "failed",
                    error_type,
                )

    async def _websocket(self, scope: Scope, receive: Receive, send: Send) -> None:
        started = monotonic()
        connection_id = uuid.uuid4().hex
        context_token = websocket_log_context.set((connection_id, started))
        accepted = False
        close_code = status.WS_1006_ABNORMAL_CLOSURE
        rx_messages = tx_messages = rx_bytes = tx_bytes = 0
        error_type: str | None = None

        async def receive_summary() -> Message:
            nonlocal close_code, rx_messages, rx_bytes
            message = await receive()
            if message["type"] == "websocket.receive":
                rx_messages += 1
                rx_bytes += _message_size(message)
            elif message["type"] == "websocket.disconnect":
                close_code = message.get("code", status.WS_1006_ABNORMAL_CLOSURE)
            return message

        async def send_summary(message: Message) -> None:
            nonlocal accepted, close_code, tx_messages, tx_bytes
            await send(message)
            if message["type"] == "websocket.accept":
                accepted = True
            elif message["type"] == "websocket.close":
                close_code = message.get("code", status.WS_1000_NORMAL_CLOSURE)
            elif message["type"] == "websocket.send":
                tx_messages += 1
                tx_bytes += _message_size(message)

        try:
            await self.app(scope, receive_summary, send_summary)
        except BaseException as error:
            error_type = type(error).__name__
            raise
        finally:
            websocket_log_context.reset(context_token)
            if accepted:
                websocket_logger.debug(
                    "event=ws_closed connection_id=%s close_code=%s duration_ms=%.1f "
                    "rx_messages=%s tx_messages=%s rx_bytes=%s tx_bytes=%s error_type=%r",
                    connection_id,
                    close_code,
                    (monotonic() - started) * MILLISECONDS_PER_SECOND,
                    rx_messages,
                    tx_messages,
                    rx_bytes,
                    tx_bytes,
                    error_type,
                )


def _message_size(message: Message) -> int:
    content = message.get("bytes")
    if content is not None:
        return len(content)
    return len((message.get("text") or "").encode("utf-8"))
