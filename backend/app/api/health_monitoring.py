from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlmodel import Session

import app.services.health_monitoring as health_monitoring_service
from app.core.logging import set_user
from app.core.security import get_current_user_with_auth_check
from app.db.database import get_session
from app.models.health_monitoring import (
    HealthMonitoringClientPolicyRead,
    HealthMonitoringSnapshotRead,
)
from app.models.user import User
from app.services.health_monitoring_settings import (
    build_client_policy_read,
    build_health_monitoring_policy,
    can_view_health_monitoring,
)

router = APIRouter()

NO_STORE_CACHE_CONTROL = "no-store"


def _apply_no_store(response: Response) -> None:
    response.headers["Cache-Control"] = NO_STORE_CACHE_CONTROL
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"


@router.get("/policy", response_model=HealthMonitoringClientPolicyRead)
async def get_health_monitoring_client_policy(
    response: Response,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> HealthMonitoringClientPolicyRead:
    """Return whether health monitoring is enabled and visible for the current user."""

    set_user(current_user.username)
    _apply_no_store(response)
    return build_client_policy_read(current_user, session)


@router.get("/snapshot", response_model=HealthMonitoringSnapshotRead)
async def get_health_monitoring_snapshot(
    response: Response,
    connection_id: Annotated[list[uuid.UUID], Query(default_factory=list, max_length=2)],
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> HealthMonitoringSnapshotRead:
    """Return the current RAM-only health snapshot without blocking on host or storage I/O."""

    set_user(current_user.username)
    _apply_no_store(response)

    policy = build_health_monitoring_policy(session)
    if not policy.enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Health monitoring is disabled.",
        )
    if not can_view_health_monitoring(current_user, policy):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Health monitoring is not available for your user role.",
        )

    return health_monitoring_service.get_health_monitoring_coordinator().build_snapshot(
        current_user=current_user,
        connection_ids=connection_id,
        session=session,
        policy=policy,
    )
